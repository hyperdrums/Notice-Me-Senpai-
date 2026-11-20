// GUI の e2e テスト。モック GitLab に対して本物のアプリを起動し、
// Chrome DevTools Protocol で画面を読み、期待どおりに描画されているか確かめる。
//
//   npm run test:gui
//
// 依存ゼロ（Node 組み込みの fetch / WebSocket を使う）。
// スクリーンショットは dist/gui-test/ に出る（gitignore 済み）。
// 07-related-mrs-ja.png は日本語の作業アイテムタブの MR 状態と最近の更新。
// ウィンドウが実際に映るので、実行中は画面に注意すること。

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mock = require('./mock-gitlab.js');

const REPO = path.join(__dirname, '..');
const OUT = path.join(REPO, 'dist', 'gui-test');
const CDP_PORT = 9333;
const INSPECT_PORT = 9334;
const ELECTRON = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const json = async url => (await fetch(url)).json();

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `   [${detail}]` : ''}`);
};

// ---------- DevTools Protocol の最小クライアント ----------
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP に接続できない')); });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  };
  return {
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    }),
    close: () => ws.close(),
  };
}

let cdp;
let mainCdp;
// main プロセスで式を評価する（--inspect の口を使う）
const evlMain = async expression => {
  const r = await mainCdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error('main: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result?.value;
};
// shell.openExternal と Notification の表示は OS に触るので、記録するだけに差し替える。
// main.js には手を入れない（呼ばれるたびに electron のオブジェクトからメソッドを引くので差し替えが効く）
const STUB_MAIN = `(() => {
  const { shell, Notification } = process.mainModule.require('electron');
  globalThis.__opened = [];
  globalThis.__shown = [];
  shell.openExternal = async url => { globalThis.__opened.push(url); };
  Notification.prototype.show = function () { globalThis.__shown.push(this.body); };
  return shell.openExternal.toString().includes('__opened');
})()`;
const shownBodies = () => evlMain('JSON.stringify(globalThis.__shown)').then(JSON.parse);

const evl = async expression => {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error('renderer: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result?.value;
};
const click = sel => evl(`document.querySelector(${JSON.stringify(sel)}).click()`);
const clickChip = (bar, text) => evl(
  `[...document.querySelectorAll(${JSON.stringify(bar + ' .chip')})].find(c => c.textContent.includes(${JSON.stringify(text)})).click()`);

// 画面側の変化を待つ
async function waitFor(label, expression, timeout = 30000) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await evl(expression); } catch { /* まだ画面が準備中 */ }
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timeout: ${label}`);
    await sleep(250);
  }
}
// モック側（Node 側）の変化を待つ
async function waitUntil(label, fn, timeout = 20000) {
  const t0 = Date.now();
  for (;;) {
    let ok = false;
    try { ok = await fn(); } catch { /* サーバ応答待ち */ }
    if (ok) return;
    if (Date.now() - t0 > timeout) throw new Error(`timeout: ${label}`);
    await sleep(200);
  }
}
const count = where => evl(`document.querySelectorAll(${JSON.stringify(where)}).length`);
async function shot(name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT, name);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`        → ${path.relative(REPO, file)}`);
}

// 配色の確認用に、同じ画面を暗い画面と明るい画面の両方で撮る（#18）
async function shotSchemes(name) {
  for (const scheme of ['dark', 'light']) {
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    await shot(`${name}-${scheme}.png`);
  }
  await cdp.send('Emulation.setEmulatedMedia', { features: [] });
}

let app = null;
let m = null;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  m = await mock.start({ quiet: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nms-gui-profile-'));

  // 1) 設定を DPAPI で書き込む（Electron を一瞬走らせる）
  await new Promise((resolve, reject) => {
    const p = spawn(ELECTRON, [
      path.join('scripts', 'mock-config.js'),
      `--user-data-dir=${profile}`, `--mock-url=${m.url}`, `--mock-token=${m.token}`,
    ], { cwd: REPO, stdio: 'ignore' });
    p.on('error', reject);
    p.on('exit', code => code === 0 ? resolve() : reject(new Error(`mock-config exit ${code}`)));
  });
  console.log(`設定を書き込み: ${m.url}\n`);

  // 2) アプリを起動（DevTools プロトコル有効）
  app = spawn(ELECTRON, ['.', `--user-data-dir=${profile}`, `--remote-debugging-port=${CDP_PORT}`, `--inspect=${INSPECT_PORT}`],
    { cwd: REPO, stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(500);
    try {
      const list = await json(`http://127.0.0.1:${CDP_PORT}/json/list`);
      target = list.find(t => t.type === 'page' && t.url.includes('index.html'));
    } catch { /* まだ起動前 */ }
  }
  if (!target) throw new Error('DevTools target が見つからない');
  cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  const [mainTarget] = await json(`http://127.0.0.1:${INSPECT_PORT}/json/list`);
  mainCdp = await connect(mainTarget.webSocketDebuggerUrl);
  await mainCdp.send('Runtime.enable');
  if (!(await evlMain(STUB_MAIN))) throw new Error('main プロセスの差し替えに失敗');
  console.log('アプリ起動，画面に接続');

  // 3) モックのデータが描画される
  await waitFor('To-Do 一覧 4 件', `document.querySelectorAll('#todos li').length === 4`);
  check('To-Do タブに 4 件描画', (await count('#todos li')) === 4);

  const status = await evl(`document.querySelector('#status').textContent`);
  check('ヘッダに件数と更新時刻', /4 件/.test(status), status);
  check('エラーバー非表示', (await evl(`document.querySelector('#error').style.display`)) === 'none');

  const tags = await evl(`[...document.querySelectorAll('#todos .tag')].map(e => e.textContent).join(',')`);
  check('種別ラベル', tags === 'レビュー依頼,アサイン,メンション,アサイン', tags);

  // #18: To-Do の種類は分類なので無彩色の1色。期限は行の右端、絞り込みチップに色の点は付けない
  const tagTones = await evl(`[...document.querySelectorAll('#todos .tag')].map(e => [...e.classList].find(c => c.startsWith('t-'))).join(',')`);
  check('To-Do の種類ラベルは無彩色', tagTones === 't-muted,t-muted,t-muted,t-muted', tagTones);
  for (const scheme of ['dark', 'light']) {
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    const colors = await evl(`[...new Set([...document.querySelectorAll('#todos .tag')].map(e => getComputedStyle(e).color))]`);
    const [r, g, b] = (colors[0] ?? '').match(/\d+/g)?.map(Number) ?? [0, 255, 0];
    check(`[${scheme}] To-Do の種類ラベルは無彩色の1色`, colors.length === 1 && Math.max(r, g, b) - Math.min(r, g, b) < 32, JSON.stringify(colors));
  }
  await cdp.send('Emulation.setEmulatedMedia', { features: [] });
  check('To-Do の絞り込みチップに色の点を付けない', (await count('#actions .dot')) === 0);
  const todoTrail = await evl(`[...document.querySelectorAll('#todos > li')].map(li => li.querySelector(':scope > .trail > .due') ? 'R' : li.querySelector('.due') ? 'L' : '-').join('')`);
  check('To-Do の期限も行の右端（完了ボタンの左）に出る', todoTrail === '-R-R', todoTrail);

  const meta = await evl(`[...document.querySelectorAll('#todos .meta')].map(e => e.textContent).join('|')`);
  check('経過時間（たった今/時間前/日前）',
    /たった今/.test(meta) && /2時間前/.test(meta) && /1日前/.test(meta), meta.slice(0, 48) + '…');
  const todoTitles = await evl(`[...document.querySelectorAll('#todos .title')].map(e => e.textContent).join('|')`);
  check('タイトルに種別と参照（MR は !、Work item は #）',
    todoTitles.includes('レビュー依頼MR !42 ログイン周りのリファクタリング')
    && todoTitles.includes('アサインIssue #17 タスクバーのバッジが二重に表示される')
    && todoTitles.includes('アサインWork item #21 リリース手順の整理'), todoTitles);
  await shot('01-list.png');
  await shotSchemes('ui-list');

  // 4) 期限の色分け
  const over = await count('#todos .due.over');
  const soon = await count('#todos .due.soon');
  check('期限切れは赤（over）', over === 1, `${over} 件`);
  check('3日以内は橙（soon）', soon === 1, `${soon} 件`);
  const dues = await evl(`[...document.querySelectorAll('#todos .due')].map(e => e.textContent).join(' | ')`);
  check('マイルストーン期限も表示', dues.includes('MS期限'), dues);

  // 5) 作業アイテムタブ
  const ROWS = '#assignedItems > li:not(.separator):not(.empty)';
  const itemTitles = `${ROWS} > .main .title`;
  const itemTags = `${ROWS} > .main > .assigned-item-link > .title > .tag`;
  const itemRow = (project, iid) => `#assignedItems > li[data-issue-key="${project}:${iid}"]`;
  const mrBadge = (issueProject, iid, mrProject, mrIid) =>
    `${itemRow(issueProject, iid)} .related-mr-link[data-mr-key="${mrProject}:${mrIid}"]`;
  const badgeState = (...keys) => `document.querySelector(${JSON.stringify(mrBadge(...keys) + ' .related-mr-state')})?.textContent`;
  const history = '#recentMrUpdatesList > li';
  const historyEvents = `[...document.querySelectorAll(${JSON.stringify(history)})].map(row => [
    row.querySelector('.recent-mr-issue-link').textContent,
    row.querySelector('.recent-mr-link').textContent,
    row.querySelector('.recent-mr-event').textContent,
  ])`;
  const hasEvent = (issueIid, mrIid, event) => `${historyEvents}.some(([issue, mr, label]) =>
    issue.startsWith(${JSON.stringify('#' + issueIid)}) && mr.startsWith(${JSON.stringify('!' + mrIid)}) && label === ${JSON.stringify(event)})`;
  const q = (await m.snapshot()).issuesQuery;
  check('作業アイテムの取得条件（自分の未完了を期限順に 100 件）',
    q?.scope === 'assigned_to_me' && q?.state === 'opened' && q?.order_by === 'due_date' && q?.sort === 'asc' && q?.per_page === '100',
    JSON.stringify(q));
  const assignedTab = await evl(`document.querySelector('#assignedTab').textContent`);
  check('作業アイテムタブのラベル（超過数込み）', assignedTab === '作業アイテム 7 (超過1)', assignedTab);
  await click('.tab[data-view=assigned]');
  await waitFor('作業アイテム一覧 7 件', `document.querySelectorAll(${JSON.stringify(ROWS)}).length === 7`);
  check('期限なしも含めて表示', (await count(ROWS)) === 7);
  const order = await evl(`[...document.querySelectorAll(${JSON.stringify(itemTitles)})].map(e => e.textContent.match(/#\\d+/)[0]).join('|')`);
  check('期限が近い順で期限なしは末尾', order === '#17|#22|#25|#23|#24|#26|#27', order);
  const sep = await evl(`[...document.querySelectorAll('#assignedItems .separator')].map(e => e.textContent).join('|')`);
  check('期限なしの区切り行', sep === '期限なし', sep);
  const sepAt = await evl(`[...document.querySelector('#assignedItems').children].findIndex(e => e.classList.contains('separator'))`);
  check('区切り行は期限ありの直後', sepAt === 4, String(sepAt));
  const typeTags = await evl(`[...document.querySelectorAll(${JSON.stringify(itemTags)})].map(e => e.textContent).join(',')`);
  check('行頭に種別タグ（issue_type なしは Issue）',
    typeTags === 'Issue,Issue,タスク,Issue,Issue,タスク,インシデント', typeTags);
  // #18: 種別は分類なので無彩色。インシデントだけが「危険」の意味で強調される
  const typeTones = await evl(`[...document.querySelectorAll(${JSON.stringify(itemTags)})].map(e => [...e.classList].find(c => c.startsWith('t-'))).join(',')`);
  check('作業アイテムの種別はインシデントだけ強調', typeTones === 't-muted,t-muted,t-muted,t-muted,t-muted,t-muted,t-danger', typeTones);
  check('種別チップに色の点を付けない', (await count('#assignedTypes .dot')) === 0, String(await count('#assignedTypes .dot')));
  const trailDue = await evl(`[...document.querySelectorAll(${JSON.stringify(ROWS)})].map(li => li.querySelector(':scope > .trail > .due') ? 'R' : li.querySelector('.due') ? 'L' : '-').join('')`);
  check('期限は行の右端（末尾の枠）に出る', trailDue === 'RRRR---', trailDue);
  const dueCls = await evl(`[...document.querySelectorAll(${JSON.stringify(ROWS)})].map(li => li.querySelector('.due')?.className ?? '-').join('|')`);
  check('作業アイテムの期限の色分け（期限なしは期限を出さない）', dueCls === 'due over|due soon|due soon|due|-|-|-', dueCls);
  const dueTexts = await evl(`[...document.querySelectorAll('#assignedItems .due')].map(e => e.textContent).join(' | ')`);
  check('作業アイテムの期限の文言', /2日超過/.test(dueTexts) && /あと1日/.test(dueTexts) && /あと3日/.test(dueTexts) && /あと14日/.test(dueTexts), dueTexts);
  check('作業アイテムに NaN が出ない', !(await evl(`document.querySelector('#assignedItems').textContent`)).includes('NaN'));
  await click(ROWS);
  await waitUntil('行のクリックで web_url を開く', async () => (await evlMain('globalThis.__opened.length')) === 1);
  const opened = await evlMain('globalThis.__opened[0]');
  check('行のクリックで web_url を開く', opened === 'http://127.0.0.1/group/proj-a/-/issues/17', opened);
  const typeChips = await evl(`[...document.querySelectorAll('#assignedTypes .chip')].map(e => e.textContent).join('|')`);
  check('種別のチップ', typeChips === 'すべて 7|Issue 4|タスク 2|インシデント 1', typeChips);
  await shot('02-assigned.png');
  await shotSchemes('ui-assigned');

  // 配色の優先度（#18）: 期限超過が最も強く、絞り込みの選択中は警告色を使わず、MR 状態は種別ラベルと別の形
  await waitFor('MR 状態のバッジ', `document.querySelector('#assignedItems .mr-status')`);
  for (const scheme of ['dark', 'light']) {
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    const look = await evl(`(() => {
      const s = q => getComputedStyle(document.querySelector(q));
      const over = s('#assignedItems .due.over'), plain = s('#assignedItems .due:not(.soon):not(.over)');
      const chip = s('#assignedTypes .chip.active'), tag = s(${JSON.stringify(itemTags)});
      const mr = document.querySelector('#assignedItems .mr-status');
      const tags = [...document.querySelectorAll(${JSON.stringify(itemTags)})].filter(e => !e.classList.contains('t-danger'));
      return { overWeight: over.fontWeight, overColor: over.color, plainColor: plain.color, chipBg: chip.backgroundColor,
        tagBg: tag.backgroundColor, tagColors: [...new Set(tags.map(e => getComputedStyle(e).color))],
        mrText: mr && getComputedStyle(mr).color, mrMarkColor: mr && getComputedStyle(mr, '::before').color,
        mrBorder: mr && getComputedStyle(mr).borderTopWidth, mrMark: mr && getComputedStyle(mr, '::before').content };
    })()`);
    // 無彩色の判定。補足文字のグレー（#6e7781 など）はわずかに青みがあり RGB の幅が 19 前後になるので、
    // 有彩色（MR の緑・紫・赤は幅 100 以上）と確実に分けられる 32 未満を無彩色とみなす
    const neutral = c => { const [r, g, b] = c.match(/\d+/g).map(Number); return Math.max(r, g, b) - Math.min(r, g, b) < 32; };
    check(`[${scheme}] 期限超過は太字で通常の期限と色が違う`, Number(look.overWeight) >= 700 && look.overColor !== look.plainColor, JSON.stringify(look));
    check(`[${scheme}] 絞り込みの選択中は無彩色（赤を使わない）`, neutral(look.chipBg), look.chipBg);
    check(`[${scheme}] 種別ラベルは塗らず、インシデント以外は無彩色の1色`,
      /rgba\(0, 0, 0, 0\)|transparent/.test(look.tagBg) && look.tagColors.length === 1 && neutral(look.tagColors[0]), JSON.stringify(look.tagColors));
    check(`[${scheme}] MR 状態は枠なし・文字は控えめ・色は記号だけ`,
      look.mrBorder === '0px' && neutral(look.mrText) && !neutral(look.mrMarkColor) && /[●○✓✕?]/.test(look.mrMark ?? ''),
      `${look.mrBorder} / ${look.mrText} / ${look.mrMarkColor} / ${look.mrMark}`);
  }
  await cdp.send('Emulation.setEmulatedMedia', { features: [] });

  await clickChip('#assignedTypes', 'タスク');
  await waitFor('タスクのみ', `document.querySelectorAll(${JSON.stringify(ROWS)}).length === 2`);
  check('種別で絞り込み', (await count(ROWS)) === 2);
  const tabFiltered = await evl(`document.querySelector('#assignedTab').textContent`);
  check('絞り込んでもタブの件数は合計のまま', tabFiltered === '作業アイテム 7 (超過1)', tabFiltered);
  await clickChip('#assignedRepos', 'proj-c');
  await waitFor('proj-c のみ', `document.querySelectorAll(${JSON.stringify(ROWS)}).length === 1`);
  check('種別が 1 つなら種別の行を隠す', (await count('#assignedTypes .chip')) === 0);
  await clickChip('#assignedRepos', 'すべて');
  await waitFor('全件に戻す', `document.querySelectorAll(${JSON.stringify(ROWS)}).length === 7`);
  check('隠れた種別の選択は解除される', (await count('#assignedTypes .chip.active')) === 1
    && (await evl(`document.querySelector('#assignedTypes .chip.active').textContent`)).startsWith('すべて'));

  // 5-2) Issue #16: 初回は状態を復元するだけ。その後は操作なしでも発行・終了を通知する。
  const refreshMrs = async () => {
    const idle = 'window.api.getState().then(s => !s.mrSyncing)';
    await waitFor('前回の MR 同期が完了', idle);
    await evl('window.api.refresh()');
    await waitFor('MR 差分同期が完了', idle);
  };
  await waitFor('初回の同一 Issue に複数 MR と別 Issue の下書き',
    `${badgeState(1, 17, 1, 42)} === 'オープン' && ${badgeState(1, 17, 1, 43)} === 'オープン'
    && ${badgeState(2, 23, 2, 45)} === '下書き'`);
  check('初回補完は既存の MR を最近の更新に追加しない', (await count(history)) === 0
    && await evl(`document.querySelector('#recentMrUpdates').hidden`));
  check('補完期間外の MR・無関係な Issue のバッジは出ない',
    (await count(`${mrBadge(2, 23, 2, 49)}, ${itemRow(1, 22)} .related-mr-link`)) === 0);
  const baseline = await m.snapshot();
  check('プロジェクト MR 差分のみ取得し、一覧と関連付けをページ送りする',
    baseline.mrListRequests.length >= 3 && baseline.mrListRequests.every(({projectId, query}) =>
      [1, 2].includes(projectId) && query.state === 'all' && query.scope === 'all' && query.order_by === 'updated_at'
      && query.sort === 'asc' && query.per_page === '100' && /^\d+$/.test(query.page)
      && Number.isFinite(Date.parse(query.updated_after)) && Date.parse(query.updated_after) <= Date.parse(query.updated_before))
    && baseline.mrListRequests.some(({projectId, query}) => projectId === 1 && Number(query.page) === 2)
    && baseline.closesIssueRequests.some(({projectId, iid, page}) => projectId === 1 && iid === 42 && page === 2),
    JSON.stringify({ list: baseline.mrListRequests.length, closes: baseline.closesIssueRequests }));

  // 発行は、GUI の「更新」を押さず通常のポーリングで拾う。
  await m.transitionMr('issued');
  await waitFor('ポーリングで新規 MR の発行とバッジが出る',
    `${hasEvent(17, 46, '発行')} && ${badgeState(1, 17, 1, 46)} === 'オープン'`, 45000);
  await m.transitionMr('merged');
  await refreshMrs();
  await waitFor('マージで Issue が一覧から消えても履歴に残る',
    `${hasEvent(17, 42, 'マージ済み')} && !document.querySelector(${JSON.stringify(itemRow(1, 17))})
    && document.querySelectorAll(${JSON.stringify(ROWS)}).length === 6`);
  await m.transitionMr('closed');
  await refreshMrs();
  await waitFor('未マージのクローズはマージと別表示で Issue を閉じない',
    `${hasEvent(23, 45, 'クローズ（未マージ）')} && ${badgeState(2, 23, 2, 45)} === 'クローズ（未マージ）'`);
  const observedEvents = await evl(historyEvents);
  check('発行・マージ・未マージのクローズを各1件だけ表示', observedEvents.length === 3 &&
    await evl([hasEvent(17, 46, '発行'), hasEvent(17, 42, 'マージ済み'), hasEvent(23, 45, 'クローズ（未マージ）')].join(' && ')),
    JSON.stringify(observedEvents));

  const beforeRepeat = await m.snapshot();
  await refreshMrs();
  await waitUntil('差分同期で前回と重なる MR が再び返る', async () => {
    const snap = await m.snapshot();
    return snap.mrListRequests.slice(beforeRepeat.mrListRequests.length)
      .some(({ projectId, matched }) => projectId === 2 && matched.includes(45));
  });
  const afterRepeat = await m.snapshot();
  check('重なる時刻窓でも、同じ MR の同じ更新は再照合せず履歴も重複しない',
    afterRepeat.closesIssueRequests.length === beforeRepeat.closesIssueRequests.length && (await count(history)) === 3,
    `照合 ${beforeRepeat.closesIssueRequests.length} → ${afterRepeat.closesIssueRequests.length}`);
  check('個別 Issue の MR 有無確認リクエストは発生しない', afterRepeat.perIssueRequests.length === 0,
    JSON.stringify(afterRepeat.perIssueRequests));
  check('MR の同期は To-Do の件数に加算されない', (await count('#todos li')) === 4
    && (await evl('window.api.getState().then(s => s.count)')) === 4);
  check('最近の更新欄は日本語で表示される',
    (await evl(`document.querySelector('#recentMrUpdatesTitle').textContent`)) === '最近の MR 更新');
  await shot('07-related-mrs-ja.png');
  await shotSchemes('ui-mr-updates');

  const openedCount = await evlMain('globalThis.__opened.length');
  await click(`${mrBadge(2, 23, 2, 45)}`);
  await waitUntil('MR バッジのリンク', async () => (await evlMain('globalThis.__opened.length')) === openedCount + 1);
  const relatedOpened = await evlMain(`globalThis.__opened.slice(${openedCount})`);
  check('MR バッジは Issue ではなく MR だけを開く', relatedOpened[0] === `${m.url}/other/proj-b/-/merge_requests/45`,
    JSON.stringify(relatedOpened));

  await m.fail('mergeRequests', 500);
  await refreshMrs();
  await waitFor('MR 同期だけのエラー', `!document.querySelector('#mrSyncError').hidden`);
  check('MR 同期に失敗しても To-Do と最後の MR 情報を維持する',
    (await count('#todos li')) === 4 && (await count(history)) === 3 &&
    await evl(`document.querySelector('#error').style.display === 'none' && ${badgeState(2, 23, 2, 45)} === 'クローズ（未マージ）'`));
  await m.fail('mergeRequests', 0);
  await m.transitionMr('reopen-issue'); // 後続の既存テストでは初期の7件が必要。
  await refreshMrs();
  await waitFor('MR 同期成功でエラーが消え、再オープンした Issue が戻る',
    `document.querySelector('#mrSyncError').hidden && document.querySelectorAll(${JSON.stringify(ROWS)}).length === 7`);

  // 6) 絞り込み
  await click('.tab[data-view=list]');
  const chips = await evl(`[...document.querySelectorAll('#todoRepos .chip')].map(e => e.textContent).join('|')`);
  check('リポジトリのチップ', chips.includes('proj-a 2') && chips.includes('proj-b 2'), chips);
  await clickChip('#todoRepos', 'proj-b');
  await waitFor('proj-b のみ', `document.querySelectorAll('#todos li').length === 2`);
  check('リポジトリで絞り込み', (await count('#todos li')) === 2);
  await clickChip('#actions', 'メンション');
  await waitFor('種別でも絞り込み', `document.querySelectorAll('#todos li').length === 1`);
  check('種別でも絞り込み', (await count('#todos li')) === 1);
  await shot('03-filtered.png');
  await clickChip('#todoRepos', 'すべて');
  await clickChip('#actions', 'すべて');
  await waitFor('全件に戻す', `document.querySelectorAll('#todos li').length === 4`);

  // 7) 「完了」ボタン → API を叩して一覧から消える
  const head = await evl(`document.querySelector('#todos li .title').textContent`);
  await click('#todos button');
  await waitUntil('モック側で完了', async () => (await m.snapshot()).done.length === 1);
  await waitFor('一覧から消える', `document.querySelectorAll('#todos li').length === 3`);
  check('完了ボタンで To-Do が消える', true, `先頭: ${head.slice(0, 12)}…`);
  const snap = await m.snapshot();
  check('mark_as_done が呼ばれた', snap.done.length === 1 && snap.done[0].id === 101, JSON.stringify(snap.done));

  // 8) バッジの描画 → main に渡す流れ。preload は凍結していてフックできないので、
  //    ページ読み込み前に canvas を数える仕込みを入れてから再読み込みする
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__draws = 0;
      const orig = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function (...a) { window.__draws++; return orig.apply(this, a); };
      const origText = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (t, ...a) { window.__badge = t; return origText.call(this, t, ...a); };`,
  });
  await cdp.send('Page.reload');
  await waitFor('再読み込み後に一覧', `document.querySelectorAll('#todos li').length === 3`, 20000);
  await waitFor('バッジ画像を描画', `window.__draws >= 2`, 10000);
  const draws = await evl(`window.__draws`);
  check('バッジ画像を描画して main に渡す', draws >= 2, `${draws} 回描画`);
  // 作業アイテムは 7 件あるが、バッジとトレイの件数は To-Do だけ
  const badge = await evl(`window.__badge`);
  check('バッジは To-Do の件数だけ', badge === '3', String(badge));
  const stateCount = await evl(`window.api.getState().then(s => s.count)`);
  check('state.count は To-Do の件数だけ', stateCount === 3, String(stateCount));

  // 9) 新着（通知は main 側で記録だけする）
  await m.push();
  await waitFor('新着がポーリングで反映', `document.querySelectorAll('#todos li').length === 4`, 30000);
  check('新着 To-Do がポーリングで増える', (await count('#todos li')) === 4);
  const fresh = await evl(`document.querySelector('#todos li .title').textContent`);
  check('新着が先頭に表示', fresh.includes('モックから押した新着'), fresh);
  await shot('04-new-arrival.png');

  // 9-2) 作業アイテムだけ取得に失敗しても To-Do は動き続ける
  const errorText = `document.querySelector('#error').textContent`;
  const errorShown = `document.querySelector('#error').style.display === 'block'`;
  const errorHidden = `document.querySelector('#error').style.display === 'none'`;
  await m.fail('issues', 500);
  await m.push();
  await click('#refresh');
  await waitFor('作業アイテムの失敗が表示される', `${errorText}.includes('作業アイテムの取得に失敗')`);
  const partialErr = await evl(errorText);
  check('作業アイテムの失敗だと分かるメッセージ', partialErr.includes('HTTP 500'), partialErr);
  check('作業アイテムが失敗しても To-Do は更新', (await count('#todos li')) === 5);
  check('作業アイテムが失敗しても To-Do のバッジは更新', (await evl(`window.__badge`)) === '5');
  check('作業アイテムが失敗しても新着を通知', (await shownBodies()).includes('モックから押した新着 2'));
  check('作業アイテムの前回の一覧が残る', (await count(ROWS)) === 7);
  await shot('06-assigned-failed.png');

  await m.fail('issues', 0);
  await click('#refresh');
  await waitFor('作業アイテムの失敗が消える', errorHidden);
  check('次の成功で作業アイテムのエラーが消える', (await evl(errorText)) === '');

  // 9-3) To-Do の失敗は従来どおり（画面の一覧はそのまま、エラーを表示）
  await m.fail('todos', 500);
  await click('#refresh');
  await waitFor('To-Do の失敗が表示される', `${errorShown} && ${errorText}.includes('取得失敗')`);
  const todoErr = await evl(errorText);
  check('To-Do の失敗は取得失敗と表示', todoErr === '取得失敗: HTTP 500', todoErr);
  check('To-Do の失敗で一覧とバッジは維持', (await count('#todos li')) === 5 && (await evl(`window.__badge`)) === '5');
  await m.fail('todos', 0);
  await click('#refresh');
  await waitFor('To-Do の失敗が消える', errorHidden);
  check('次の成功で To-Do のエラーが消える', (await evl(errorText)) === '');

  // 作業アイテムの失敗に続いて To-Do も失敗したら、「To-Do は更新しました」を残さない
  await m.fail('issues', 500);
  await click('#refresh');
  await waitFor('作業アイテムの失敗が表示される', `${errorText}.includes('作業アイテムの取得に失敗')`);
  await m.fail('todos', 500);
  await click('#refresh');
  await waitFor('To-Do の失敗だけになる', `${errorText} === '取得失敗: HTTP 500'`);
  await sleep(500);   // 遅れて届く作業アイテムの失敗で上書きされないことも見る
  const bothErr = await evl(errorText);
  check('両方失敗したら To-Do の失敗だけ表示', bothErr === '取得失敗: HTTP 500', bothErr);
  await m.fail('issues', 0);
  await m.fail('todos', 0);
  await click('#refresh');
  await waitFor('両方の失敗が消える', errorHidden);

  // 9-4) 取得上限のお知らせ
  const limitHidden = `document.querySelector('#assignedLimit').classList.contains('hidden')`;
  const tabText = `document.querySelector('#assignedTab').textContent`;
  check('上限未満ならお知らせなし', await evl(limitHidden));
  await m.setAssignedCount(150);
  await click('#refresh');
  await waitFor('上限のお知らせが出る', `!${limitHidden}`);
  const limitText = await evl(`document.querySelector('#assignedLimit').textContent`);
  check('上限のお知らせ', limitText === '100 件まで表示', limitText);
  check('取得するのは 100 件まで', (await count(ROWS)) === 100);
  const totalLabel = await evl(tabText);
  check('タブの件数は x-total の総数', totalLabel === '作業アイテム 150 (超過1)', totalLabel);
  // x-total が無くても、100 件返ってきたら上限とみなす
  await m.setAssignedTotal('none');
  await click('#refresh');
  await waitFor('x-total なしの件数', `${tabText} === '作業アイテム 100 (超過1)'`);
  check('x-total なしで 100 件ならお知らせを出す', !(await evl(limitHidden)));
  await m.setAssignedCount(null);
  await click('#refresh');
  await waitFor('x-total なしで 7 件', `${tabText} === '作業アイテム 7 (超過1)'`);
  check('x-total なしで 100 件未満ならお知らせなし', await evl(limitHidden));
  await m.setAssignedTotal(null);
  await click('#refresh');
  await waitFor('上限のお知らせが消える', limitHidden);

  // 9-5) 作業アイテムが応答しなくても To-Do は待たされず、時間切れで部分的な失敗になる
  await m.hangIssues(true);
  await m.push();
  await click('#refresh');
  await waitFor('作業アイテムを待たずに To-Do が更新', `document.querySelectorAll('#todos li').length === 6 && /6 件/.test(document.querySelector('#status').textContent)`, 10000);
  check('作業アイテムが応答しなくても To-Do とヘッダは更新', true);
  check('作業アイテムが応答しなくても To-Do のバッジは更新', (await evl(`window.__badge`)) === '6');
  check('作業アイテムが応答しなくても新着を通知', (await shownBodies()).includes('モックから押した新着 3'));
  await waitFor('作業アイテムの時間切れが表示される', `${errorText}.includes('作業アイテムの取得に失敗')`, 45000);
  const timeoutErr = await evl(errorText);
  check('作業アイテムの時間切れは部分的な失敗', timeoutErr === '作業アイテムの取得に失敗: 応答がありません（To-Do は更新しました）', timeoutErr);
  check('作業アイテムの時間切れでも前回の一覧が残る', (await count(ROWS)) === 7);
  await m.hangIssues(false);
  await click('#refresh');
  await waitFor('作業アイテムの時間切れが消える', errorHidden);
  check('次の成功で時間切れのエラーが消える', (await evl(errorText)) === '');

  // 10) preload の公開面
  const api = await evl(`Object.keys(window.api).sort().join(',')`);
  check('preload の IPC 面', api.includes('done') && api.includes('setBadge'), api);

  // 11) 言語の切り替え（Issue #5）
  const sel = `document.querySelector('select[name=lang]')`;
  await click('.tab[data-view=settings]');
  const options = await evl(`[...${sel}.options].map(o => o.value).join(',')`);
  check('設定に言語の選択がある', options === 'ja,en', options);
  const optTexts = await evl(`[...${sel}.options].map(o => o.text).join('|')`);
  check('選択肢がどちらの言語でも読める', optTexts === '日本語 (Japanese)|English (英語)', optTexts);
  const langLabel = await evl(`document.querySelector('[data-i18n=lblLang]').textContent`);
  check('ラベルが日英併記で見つけられる', langLabel.includes('Language') && langLabel.includes('表示言語'), langLabel);
  check('既定は日本語', (await evl(`${sel}.value`)) === 'ja');

  await evl(`${sel}.value = 'en'; document.querySelector('#form').requestSubmit();`);
  await waitFor('英語に切り替わる', `document.querySelector('.tab[data-view=settings]').textContent === 'Settings'`, 20000);
  const tabs = await evl(`[...document.querySelectorAll('.tab')].map(e => e.textContent).join('|')`);
  check('タブが英語になる', tabs.startsWith('To-Do|Work items') && tabs.endsWith('|Settings'), tabs);
  const chipsEn = await evl(`[...document.querySelectorAll('#todoRepos .chip')].map(e => e.textContent).join('|')`);
  check('チップが英語（All / プロジェクト名）', chipsEn.startsWith('All '), chipsEn);
  const tagsEn = await evl(`[...document.querySelectorAll('#todos .tag')].map(e => e.textContent).join(',')`);
  check('種別ラベルが英語', /Mentioned/.test(tagsEn) && /Assigned/.test(tagsEn) && !/メンション/.test(tagsEn), tagsEn);
  const doneEn = await evl(`document.querySelector('#todos button').textContent`);
  check('完了ボタンが Done', doneEn === 'Done', doneEn);
  const statusEn = await evl(`document.querySelector('#status').textContent`);
  check('ヘッダが英語', /\d+ to-dos/.test(statusEn), statusEn);
  const dueEn = await evl(`[...document.querySelectorAll('#todos .due')].map(e => e.textContent).join(' | ')`);
  check('期限表示が英語', dueEn.includes('overdue') && dueEn.includes('Milestone'), dueEn);
  const assignedEn = await evl(`document.querySelector('#assignedTab').textContent`);
  check('作業アイテムタブのラベルが英語', assignedEn === 'Work items 7 (1 overdue)', assignedEn);
  const sepEn = await evl(`document.querySelector('#assignedItems .separator').textContent`);
  check('区切り行が英語', sepEn === 'No due date', sepEn);
  const assignedDueEn = await evl(`[...document.querySelectorAll('#assignedItems .due')].map(e => e.textContent).join(' | ')`);
  check('作業アイテムの期限が英語', assignedDueEn.includes('2d overdue') && assignedDueEn.includes('in 1d'), assignedDueEn);
  const typeTagsEn = await evl(`[...document.querySelectorAll(${JSON.stringify(itemTags)})].map(e => e.textContent).join(',')`);
  check('種別タグが英語', typeTagsEn === 'Issue,Issue,Task,Issue,Issue,Task,Incident', typeTagsEn);
  const limitEn = await evl(`document.querySelector('#assignedLimit').textContent`);
  check('上限のお知らせが英語', limitEn === 'Showing the first 100', limitEn);
  await click('.tab[data-view=settings]');
  const saveEn = await evl(`document.querySelector('button[type=submit]').textContent`);
  check('保存ボタンが Save', saveEn === 'Save', saveEn);
  const hintEn = await evl(`document.querySelector('#form p.hint').textContent`);
  check('ヒントも英語', hintEn.includes('DPAPI'), hintEn);
  await click('.tab[data-view=list]');
  await shot('05-english.png');
  // README の 2 枚目（英語の作業アイテムタブ）。README は暗い画面で揃えている
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await click('.tab[data-view=assigned]');
  // header は flex なので折り返しは矩形の数でなく高さで見る（1 行なら約 24px）
  const wrapped = await evl(`[...document.querySelectorAll('header .tab')].filter(t => t.offsetHeight > 30).map(t => t.textContent)`);
  check('英語でもタブ名が折り返さない', wrapped.length === 0, JSON.stringify(wrapped));
  await shot('08-assigned-en.png');
  await click('.tab[data-view=list]');
  await cdp.send('Emulation.setEmulatedMedia', { features: [] });

  await click('.tab[data-view=settings]');
  await evl(`${sel}.value = 'ja'; document.querySelector('#form').requestSubmit();`);
  await waitFor('日本語に戻る', `document.querySelector('.tab[data-view=settings]').textContent === '設定'`, 20000);
  check('日本語に戻せる', true);
})().catch(e => {
  check(`例外: ${e.message}`, false);
}).finally(async () => {
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  console.log(`screenshots: ${OUT}`);
  try { cdp?.close(); } catch {}
  try { mainCdp?.close(); } catch {}
  if (app) app.kill();
  if (m) await m.close();
  process.exit(failed.length ? 1 : 0);
});
