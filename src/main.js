const {
  app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, net, shell,
  safeStorage, session, Notification,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { createHash } = require('crypto');
const { newMrCache, rememberIssues, mrView, syncMrProject } = require('./mr-sync.js');
const { newEtagStore, fetchWithEtag, invalidate, clearEtags } = require('./etag.js');
const { CONFIG_DEFAULTS, ASSIGNED_LIMIT, ASSIGNED_TIMEOUT_MS, apiUrl, mergeConfig, intervalSec, freshTodos, assignedPatch, tr } = require('./lib.js');

// 軽量化: GPU・ネットワークを別プロセスにせず、メインに統合する（素のHTMLなのでGPU不要）
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('enable-features', 'NetworkServiceInProcess2');
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=64');
app.setAppUserModelId('io.github.hyperdrums.notice-me-senpai');

if (!app.requestSingleInstanceLock()) app.quit();

const DEFAULTS = { ...CONFIG_DEFAULTS, token: '' };
const configPath = () => path.join(app.getPath('userData'), 'config.json');

let win = null;
let tray = null;
let timer = null;
let quitting = false;
let config = { ...DEFAULTS, token: '' };
let knownIds = null; // 初回取得ではデスクトップ通知を出さない
// count は To-Do だけの件数（バッジとトレイ用）。作業アイテムの件数は混ぜない
let state = { todos: [], assigned: [], assignedLimited: false, assignedTotal: null, assignedError: null, relatedMrsByIssue: {}, mrSyncError: false, count: 0, error: null, updatedAt: null, loading: false };
let connectionGeneration = 0;
let mrCache = newMrCache();
let mrJob = null;
let mrOffset = 0;
let mrRetryAt = 0;
const mrCachePath = () => path.join(app.getPath('userData'), 'mr-cache.enc');
const mrConnectionKey = () => createHash('sha256').update(JSON.stringify([config.baseUrl, config.token])).digest('hex');
let pollSeq = 0;      // poll の通し番号
let todosSeq = 0;     // To-Do の結果を反映した最新の poll の番号
let assignedSeq = 0;  // 作業アイテムの結果を反映した最新の poll の番号

// 初回起動（設定が無いとき）だけ OS の言語を見る。ja 以外なら英語で出す
const guessLang = () => (String(app.getLocale() || '').toLowerCase().startsWith('ja') ? 'ja' : 'en');

// ---------- 設定（トークンは DPAPI で暗号化して保存） ----------
async function loadConfig() {
  const fresh = { ...DEFAULTS, token: '', lang: guessLang() };
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    const token = raw.tokenEnc
      ? (await safeStorage.decryptStringAsync(Buffer.from(raw.tokenEnc, 'base64'))).result
      : '';
    delete raw.tokenEnc;
    config = { ...fresh, ...raw, token };
  } catch {
    config = fresh;
  }
}

async function saveConfig() {
  const { token, ...rest } = config;
  const enc = token ? (await safeStorage.encryptStringAsync(token)).toString('base64') : '';
  const out = { ...rest, tokenEnc: enc };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(out, null, 2));
}

function applyCertPolicy() {
  // 自己署名証明書のオンプレ向け。対象ホストだけ検証をスキップする
  let host = '';
  try { host = new URL(config.baseUrl).hostname; } catch {}
  session.defaultSession.setCertificateVerifyProc((req, cb) => {
    cb(config.insecure && req.hostname === host ? 0 : -3);
  });
}

function applyAutoStart() {
  const args = app.isPackaged ? ['--minimized'] : [app.getAppPath(), '--minimized'];
  // portable exe は一時フォルダに展開されて動くため、元の exe のパスを登録する
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  app.setLoginItemSettings({ openAtLogin: !!config.autoStart, path: exe, args });
}

// ---------- GitLab API ----------
async function api(p, method = 'GET', signal, extraHeaders) {
  const res = await net.fetch(apiUrl(config.baseUrl, p), {
    method,
    headers: { 'PRIVATE-TOKEN': config.token, ...extraHeaders },
    signal,
    ...(extraHeaders && { cache: 'no-store' }),
  });
  if (res.status === 304 && extraHeaders?.['If-None-Match']) return res;
  if (!res.ok) {
    const msg = res.status === 401 ? tr(config.lang, 'errInvalidToken') : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return res;
}

const etagStore = newEtagStore();
const TODO_LIMIT = 100;
const TODOS_PATH = `/todos?state=pending&per_page=${TODO_LIMIT}`;
const ASSIGNED_PATH = `/issues?scope=assigned_to_me&state=opened&order_by=due_date&sort=asc&per_page=${ASSIGNED_LIMIT}`;

async function apiJsonCached(p, limit, signal) {
  return fetchWithEtag(etagStore, apiUrl(config.baseUrl, p), async ({ etag }) => {
    // Electron の HTTP キャッシュを介さず、ここで 304 を処理する。
    const res = await api(p, 'GET', signal, etag ? { 'If-None-Match': etag } : {});
    // 304 に x-total が付いていれば採用する（GitLab は通常再送しないが、付く実装でも件数を古くしない）
    if (res.status === 304) return { status: 304, xTotal: res.headers.get('x-total') };
    const body = await res.json();
    if (!Array.isArray(body)) throw new Error(tr(config.lang, 'errBadResponse'));
    const xTotal = res.headers.get('x-total');
    // 304 では x-total が来ない。表示外に件数があり得るときは毎回総数を取り直す。
    const complete = body.length < limit && (xTotal == null || Number(xTotal) === body.length);
    return { status: res.status, etag: complete ? res.headers.get('etag') : null, body, xTotal };
  });
}

async function fetchTodos() {
  const { body: todos, changed, xTotal } = await apiJsonCached(TODOS_PATH, TODO_LIMIT);
  return { todos, changed, count: Number(xTotal) || todos.length };
}

// 作業アイテムタブ用: 自分にアサインされた未完了の作業アイテム。issue_type を指定しなければタスクなども返る
async function fetchAssigned() {
  // 応答が来ないときも部分的な失敗として扱えるよう、待つ時間を区切る
  const signal = AbortSignal.timeout(ASSIGNED_TIMEOUT_MS);
  try {
    const { body: items, changed, xTotal } = await apiJsonCached(ASSIGNED_PATH, ASSIGNED_LIMIT, signal);
    return { items, changed, xTotal };
  } catch (e) {
    throw signal.aborted ? new Error(tr(config.lang, 'errTimeout')) : e;
  }
}

async function loadMrCache() {
  if (!config.baseUrl || !config.token) return;
  try {
    const data = await fs.promises.readFile(mrCachePath());
    const { result } = await safeStorage.decryptStringAsync(data);
    const { key, cache } = JSON.parse(result);
    // 過去バージョンのキャッシュに残っている history は読み込まない（#22）。次の保存で落ちる
    if (key === mrConnectionKey() && cache?.issues && cache.projects && cache.mrs) {
      mrCache = { projects: cache.projects, issues: cache.issues, mrs: cache.mrs };
      rememberIssues(mrCache, [], Date.now());
      setState(mrView(mrCache));
    }
  } catch { /* 無い、または復号できないキャッシュは作り直す */ }
}

function syncMrs(generation) {
  if (mrJob || generation !== connectionGeneration || Date.now() < mrRetryAt) return;
  const cache = mrCache;
  const controller = new AbortController();
  const job = { controller };
  mrJob = job;
  setState({ mrSyncing: true });
  const upper = Date.now();
  const projects = rememberIssues(cache, state.assigned, upper);
  let remaining = 30;
  // 1 リクエストずつ実行し、1 回の同期にも予算を設ける。途中停止ではカーソルを進めない。
  const budget = new Error('MR request budget exhausted');
  const get = async endpoint => {
    controller.signal.throwIfAborted();
    if (remaining <= 0) throw budget;
    remaining--;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(ASSIGNED_TIMEOUT_MS)]);
    const res = await api(endpoint, 'GET', signal);
    return { rows: await res.json(), nextPage: res.headers.get('x-next-page') };
  };
  void (async () => {
    let failed = false;
    try {
      let index = mrOffset % (projects.length || 1);
      for (let i = 0; i < projects.length; i++) {
        try {
          await syncMrProject(cache, projects[index], upper, get);
        } catch (e) {
          if (controller.signal.aborted || e === budget) break;
          failed = true;
          if (e.message === 'HTTP 429') {
            mrRetryAt = Date.now() + 60_000;
            break;
          }
        }
        index = (index + 1) % projects.length;
        mrOffset = index;
      }
      if (generation !== connectionGeneration) return;
      setState({ ...mrView(cache), mrSyncError: failed });
      const data = await safeStorage.encryptStringAsync(JSON.stringify({ key: mrConnectionKey(), cache }));
      if (generation !== connectionGeneration) return;
      const file = mrCachePath();
      fs.writeFileSync(`${file}.tmp`, data);
      fs.renameSync(`${file}.tmp`, file);
    } catch {
      if (generation === connectionGeneration) setState({ mrSyncError: true });
    } finally {
      if (mrJob === job) {
        mrJob = null;
        setState({ mrSyncing: false });
      }
    }
  })();
}

async function poll() {
  const seq = ++pollSeq;
  const generation = connectionGeneration;
  if (!config.baseUrl || !config.token) {
    assignedSeq = seq;
    setState({ todos: [], assigned: [], assignedLimited: false, assignedTotal: null, assignedError: null, count: 0, error: tr(config.lang, 'errNotConfigured') });
    return;
  }
  setState({ loading: true });
  // 同時に取りにいくが、作業アイテムの結果は To-Do を反映してから受ける。
  // 作業アイテムが遅くても失敗しても、To-Do の表示・バッジ・通知は待たせない
  const assignedFetch = Promise.allSettled([fetchAssigned()]);
  try {
    const { todos, changed, count } = await fetchTodos();
    if (generation !== connectionGeneration || seq < todosSeq) return;
    todosSeq = seq;
    if (changed || state.todos !== todos) {
      notifyNew(todos);
      setState({ todos, count, error: null, updatedAt: Date.now(), loading: false });
    } else {
      if (knownIds === null) knownIds = new Set(todos.map(t => t.id));
      setState(state.error ? { error: null, updatedAt: Date.now(), loading: false } : { loading: false });
    }
  } catch (e) {
    if (generation !== connectionGeneration || seq < todosSeq) return;
    todosSeq = seq;
    setState({ error: tr(config.lang, 'errFetch', { msg: e.message }), assignedError: null, loading: false });
    return;
  }
  const [assignedResult] = await assignedFetch;
  // 新しい poll の結果を、遅れて届いた古い応答で上書きしない
  if (seq < assignedSeq) return;
  assignedSeq = seq;
  // To-Do の取得に失敗した間のキャッシュも、画面には一度反映する。
  if (assignedResult.status === 'fulfilled' && assignedResult.value.items !== state.assigned) {
    assignedResult.value.changed = true;
  }
  setState(assignedPatch(assignedResult, config.lang));
  if (assignedResult.status === 'fulfilled') syncMrs(generation);
}

function notifyNew(todos) {
  const fresh = freshTodos(knownIds, todos);
  knownIds = new Set(todos.map(t => t.id));
  if (!config.notify || fresh.length === 0 || !Notification.isSupported()) return;
  const t = fresh[0];
  const n = new Notification({
    title: fresh.length > 1
      ? tr(config.lang, 'notifNew', { n: fresh.length })
      : tr(config.lang, 'notifFrom', { name: t.author?.name ?? '' }),
    body: t.target?.title ?? t.body ?? '',
  });
  n.on('click', () => (fresh.length === 1 ? openUrl(t.target_url) : showWindow()));
  n.show();
}

function setState(patch) {
  state = { ...state, ...patch };
  win?.webContents.send('state', state);
}

function schedule() {
  clearInterval(timer);
  timer = setInterval(poll, intervalSec(config.intervalSec) * 1000);
  poll();
}

function openUrl(url) {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
}

// ---------- ウィンドウ / トレイ ----------
// 単色の丸アイコンをビットマップで生成（画像ファイル不要）
function circleIcon(size, [r, g, b]) {
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const a = Math.max(0, Math.min(1, size / 2 - d)) * 255;
      const i = (y * size + x) * 4;
      buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = a; // BGRA
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  const startMinimized = process.argv.includes('--minimized');
  win = new BrowserWindow({
    width: 520,
    height: 640,
    icon: circleIcon(64, [226, 67, 41]),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      spellcheck: false,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => {
    if (startMinimized) win.minimize();
    else win.show();
  });

  // × では終了せず最小化（タスクバーのバッジを残すため）
  win.on('close', e => {
    if (quitting) return;
    e.preventDefault();
    win.minimize();
  });
}

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: tr(config.lang, 'trayOpen'), click: showWindow },
    { label: tr(config.lang, 'trayRefresh'), click: poll },
    { type: 'separator' },
    { label: tr(config.lang, 'trayQuit'), click: () => { quitting = true; app.quit(); } },
  ]);
}

function createTray() {
  tray = new Tray(circleIcon(32, [226, 67, 41]));
  tray.setToolTip(tr(config.lang, 'appTitle'));
  tray.setContextMenu(trayMenu());
  tray.on('click', showWindow);
}

// ---------- IPC ----------
ipcMain.handle('get-state', () => state);
ipcMain.handle('get-config', () => {
  const { token, ...rest } = config;
  return { ...rest, hasToken: !!token };
});
ipcMain.handle('save-config', async (_e, c) => {
  const previous = config;
  config = mergeConfig(config, c);
  if (previous.baseUrl !== config.baseUrl || previous.token !== config.token) {
    assignedSeq = ++pollSeq;
    connectionGeneration++;
    mrJob?.controller.abort();
    mrJob = null;
    mrOffset = 0;
    mrRetryAt = 0;
    mrCache = newMrCache();
    // baseUrl / token が変われば ETag も別接続のもの。持ち越さない
    clearEtags(etagStore);
    setState({ todos: [], count: 0, assigned: [], assignedLimited: false, assignedTotal: null, assignedError: null, ...mrView(mrCache), mrSyncError: false });
  }
  await saveConfig();
  applyCertPolicy();
  applyAutoStart();
  tray?.setContextMenu(trayMenu());   // 言語が変わった可能性があるのでメニューを作り直す
  knownIds = null;
  schedule();
  return true;
});
ipcMain.handle('refresh', () => poll());
ipcMain.handle('open', (_e, url) => openUrl(url));
ipcMain.handle('done', async (_e, id) => {
  const generation = connectionGeneration;
  try {
    await api(`/todos/${Number(id)}/mark_as_done`, 'POST');
    if (generation !== connectionGeneration) return;
    // サーバ側で確実に変わった。次回 poll が偽 304 で古い一覧を返さないよう捨てる
    invalidate(etagStore, apiUrl(config.baseUrl, TODOS_PATH));
    invalidate(etagStore, apiUrl(config.baseUrl, ASSIGNED_PATH));
  } catch (e) {
    if (generation !== connectionGeneration) return;
    setState({ error: tr(config.lang, 'errDone', { msg: e.message }) });
  }
  await poll();
});
// レンダラーが canvas で描いたバッジ画像を受け取る
ipcMain.on('badge', (_e, { overlay, trayIcon, count }) => {
  if (!win) return;
  win.setOverlayIcon(count > 0 ? nativeImage.createFromDataURL(overlay) : null, tr(config.lang, 'statusCount', { n: count }));
  if (tray && trayIcon) tray.setImage(nativeImage.createFromDataURL(trayIcon));
  tray?.setToolTip(tr(config.lang, 'trayTooltip', { n: count }));
});

// ---------- 起動 ----------
app.on('second-instance', showWindow);
app.on('before-quit', () => { quitting = true; });
app.whenReady().then(async () => {
  await loadConfig();
  await loadMrCache();
  applyCertPolicy();
  createWindow();
  createTray();
  schedule();
});
