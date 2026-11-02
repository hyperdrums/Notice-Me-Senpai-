const {
  app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, net, shell,
  safeStorage, session, Notification,
} = require('electron');
const path = require('path');
const fs = require('fs');

// 軽量化: GPU・ネットワークを別プロセスにせず、メインに統合する（素のHTMLなのでGPU不要）
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('enable-features', 'NetworkServiceInProcess2');
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=64');
app.setAppUserModelId('io.github.hyperdrums.notice-me-senpai');

if (!app.requestSingleInstanceLock()) app.quit();

const DEFAULTS = { baseUrl: '', intervalSec: 60, notify: true, insecure: false, autoStart: false };
const configPath = () => path.join(app.getPath('userData'), 'config.json');

let win = null;
let tray = null;
let timer = null;
let quitting = false;
let config = { ...DEFAULTS, token: '' };
let knownIds = null; // 初回取得ではデスクトップ通知を出さない
let state = { todos: [], issues: [], count: 0, error: null, updatedAt: null, loading: false };

// ---------- 設定（トークンは DPAPI で暗号化して保存） ----------
async function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    const token = raw.tokenEnc
      ? (await safeStorage.decryptStringAsync(Buffer.from(raw.tokenEnc, 'base64'))).result
      : '';
    delete raw.tokenEnc;
    config = { ...DEFAULTS, ...raw, token };
  } catch {
    config = { ...DEFAULTS, token: '' };
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
async function api(p, method = 'GET') {
  const base = config.baseUrl.replace(/\/+$/, '');
  const res = await net.fetch(`${base}/api/v4${p}`, {
    method,
    headers: { 'PRIVATE-TOKEN': config.token },
  });
  if (!res.ok) {
    const msg = res.status === 401 ? 'トークンが無効です (401)' : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return res;
}

async function poll() {
  if (!config.baseUrl || !config.token) {
    setState({ todos: [], issues: [], count: 0, error: '未設定です。設定タブで URL とトークンを入力してください。' });
    return;
  }
  setState({ loading: true });
  try {
    const [res, issueRes] = await Promise.all([
      api('/todos?state=pending&per_page=100'),
      // 期限タブ用: 自分にアサインされた未完了 Issue（期限が近い順、期限なしは末尾）
      api('/issues?scope=assigned_to_me&state=opened&order_by=due_date&sort=asc&per_page=100'),
    ]);
    const todos = await res.json();
    const issues = (await issueRes.json()).filter(i => i.due_date);
    const count = Number(res.headers.get('x-total')) || todos.length;
    notifyNew(todos);
    setState({ todos, issues, count, error: null, updatedAt: Date.now(), loading: false });
  } catch (e) {
    setState({ error: `取得失敗: ${e.message}`, loading: false });
  }
}

function notifyNew(todos) {
  const ids = new Set(todos.map(t => t.id));
  const fresh = knownIds ? todos.filter(t => !knownIds.has(t.id)) : [];
  knownIds = ids;
  if (!config.notify || fresh.length === 0 || !Notification.isSupported()) return;
  const t = fresh[0];
  const n = new Notification({
    title: fresh.length > 1 ? `GitLab: 新着 ${fresh.length} 件` : `GitLab: ${t.author?.name ?? ''}`,
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
  const sec = Math.max(15, Number(config.intervalSec) || DEFAULTS.intervalSec);
  timer = setInterval(poll, sec * 1000);
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

function createTray() {
  tray = new Tray(circleIcon(32, [226, 67, 41]));
  tray.setToolTip('Notice Me, Senpai!');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '開く', click: showWindow },
    { label: '今すぐ更新', click: poll },
    { type: 'separator' },
    { label: '終了', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

// ---------- IPC ----------
ipcMain.handle('get-state', () => state);
ipcMain.handle('get-config', () => {
  const { token, ...rest } = config;
  return { ...rest, hasToken: !!token };
});
ipcMain.handle('save-config', async (_e, c) => {
  config = {
    ...config,
    baseUrl: String(c.baseUrl || '').trim(),
    intervalSec: Number(c.intervalSec) || DEFAULTS.intervalSec,
    notify: !!c.notify,
    insecure: !!c.insecure,
    autoStart: !!c.autoStart,
    // 空欄なら既存トークンを維持
    token: c.token ? String(c.token).trim() : config.token,
  };
  await saveConfig();
  applyCertPolicy();
  applyAutoStart();
  knownIds = null;
  schedule();
  return true;
});
ipcMain.handle('refresh', () => poll());
ipcMain.handle('open', (_e, url) => openUrl(url));
ipcMain.handle('done', async (_e, id) => {
  try {
    await api(`/todos/${Number(id)}/mark_as_done`, 'POST');
  } catch (e) {
    setState({ error: `完了処理に失敗: ${e.message}` });
  }
  await poll();
});
// レンダラーが canvas で描いたバッジ画像を受け取る
ipcMain.on('badge', (_e, { overlay, trayIcon, count }) => {
  if (!win) return;
  win.setOverlayIcon(count > 0 ? nativeImage.createFromDataURL(overlay) : null, `${count} 件`);
  if (tray && trayIcon) tray.setImage(nativeImage.createFromDataURL(trayIcon));
  tray?.setToolTip(`NMS - 未読 ${count} 件`);
});

// ---------- 起動 ----------
app.on('second-instance', showWindow);
app.on('before-quit', () => { quitting = true; });
app.whenReady().then(async () => {
  await loadConfig();
  applyCertPolicy();
  createWindow();
  createTray();
  schedule();
});
