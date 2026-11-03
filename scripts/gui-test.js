// GUI の e2e テスト。モック GitLab に対して本物のアプリを起動し、
// Chrome DevTools Protocol で画面を読み、期待どおりに描画されているか確かめる。
//
//   npm run test:gui
//
// 依存ゼロ（Node 組み込みの fetch / WebSocket を使う）。
// スクリーンショットは dist/gui-test/ に出る（gitignore 済み）。
// ウィンドウが実際に映るので、実行中は画面に注意すること。

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mock = require('./mock-gitlab.js');

const REPO = path.join(__dirname, '..');
const OUT = path.join(REPO, 'dist', 'gui-test');
const CDP_PORT = 9333;
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

let app = null;
let m = null;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  m = await mock.start({ quiet: true });
  const profile = path.join(os.tmpdir(), 'opencode', 'nms-gui-profile');
  fs.rmSync(profile, { recursive: true, force: true });

  // 1) 設定を DPAPI で書き込む（Electron を一瞬走らせる）
  await new Promise((resolve, reject) => {
    const p = spawn(ELECTRON, [
      path.join('scripts', 'mock-config.js'),
      `--user-data-dir=${profile}`, `--mock-url=${m.url}`, `--mock-token=${m.token}`,
    ], { cwd: REPO, stdio: 'ignore' });
    p.on('exit', code => code === 0 ? resolve() : reject(new Error(`mock-config exit ${code}`)));
  });
  console.log(`設定を書き込み: ${m.url}\n`);

  // 2) アプリを起動（DevTools プロトコル有効）
  app = spawn(ELECTRON, ['.', `--user-data-dir=${profile}`, `--remote-debugging-port=${CDP_PORT}`],
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
  console.log('アプリ起動，画面に接続');

  // 3) モックのデータが描画される
  await waitFor('通知一覧 4 件', `document.querySelectorAll('#todos li').length === 4`);
  check('通知タブに 4 件描画', (await count('#todos li')) === 4);

  const status = await evl(`document.querySelector('#status').textContent`);
  check('ヘッダに件数と更新時刻', /4 件/.test(status), status);
  check('エラーバー非表示', (await evl(`document.querySelector('#error').style.display`)) === 'none');

  const tags = await evl(`[...document.querySelectorAll('#todos .tag')].map(e => e.textContent).join(',')`);
  check('種別ラベル', tags === 'レビュー依頼,アサイン,メンション,アサイン', tags);

  const meta = await evl(`[...document.querySelectorAll('#todos .meta')].map(e => e.textContent).join('|')`);
  check('経過時間（たった今/時間前/日前）',
    /たった今/.test(meta) && /2時間前/.test(meta) && /1日前/.test(meta), meta.slice(0, 48) + '…');
  await shot('01-list.png');

  // 4) 期限の色分け
  const over = await count('#todos .due.over');
  const soon = await count('#todos .due.soon');
  check('期限切れは赤（over）', over === 1, `${over} 件`);
  check('3日以内は橙（soon）', soon === 1, `${soon} 件`);
  const dues = await evl(`[...document.querySelectorAll('#todos .due')].map(e => e.textContent).join(' | ')`);
  check('マイルストーン期限も表示', dues.includes('MS期限'), dues);

  // 5) 期限タブ
  const dueTab = await evl(`document.querySelector('#dueTab').textContent`);
  check('期限タブのラベル（超過数込み）', dueTab === '期限 3 (超過1)', dueTab);
  await click('.tab[data-view=due]');
  await waitFor('期限一覧 3 件', `document.querySelectorAll('#issues li').length === 3`);
  check('期限なし Issue は除外', (await count('#issues li')) === 3);
  const order = await evl(`[...document.querySelectorAll('#issues .title')].map(e => e.textContent.split(' ')[0]).join('|')`);
  check('期限が近い順', order === '#17|#22|#23', order);
  await shot('02-due.png');

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
      HTMLCanvasElement.prototype.toDataURL = function (...a) { window.__draws++; return orig.apply(this, a); };`,
  });
  await cdp.send('Page.reload');
  await waitFor('再読み込み後に一覧', `document.querySelectorAll('#todos li').length === 3`, 20000);
  await waitFor('バッジ画像を描画', `window.__draws >= 2`, 10000);
  const draws = await evl(`window.__draws`);
  check('バッジ画像を描画して main に渡す', draws >= 2, `${draws} 回描画`);

  // 9) 新着（このとき Windows のトーストが出るはず）
  await m.push();
  await waitFor('新着がポーリングで反映', `document.querySelectorAll('#todos li').length === 4`, 30000);
  check('新着 To-Do がポーリングで増える', (await count('#todos li')) === 4);
  const fresh = await evl(`document.querySelector('#todos li .title').textContent`);
  check('新着が先頭に表示', fresh.includes('モックから押した新着'), fresh);
  await shot('04-new-arrival.png');

  // 10) preload の公開面
  const api = await evl(`Object.keys(window.api).sort().join(',')`);
  check('preload の IPC 面', api.includes('done') && api.includes('setBadge'), api);

  // 11) 言語の切り替え（Issue #5）
  const sel = `document.querySelector('select[name=lang]')`;
  await click('.tab[data-view=settings]');
  const options = await evl(`[...${sel}.options].map(o => o.value).join(',')`);
  check('設定に言語の選択がある', options === 'ja,en', options);
  check('既定は日本語', (await evl(`${sel}.value`)) === 'ja');

  await evl(`${sel}.value = 'en'; document.querySelector('#form').requestSubmit();`);
  await waitFor('英語に切り替わる', `document.querySelector('.tab[data-view=list]').textContent === 'Notifications'`, 20000);
  const tabs = await evl(`[...document.querySelectorAll('.tab')].map(e => e.textContent).join('|')`);
  check('タブが英語になる', tabs.startsWith('Notifications|') && tabs.endsWith('|Settings'), tabs);
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
  await click('.tab[data-view=settings]');
  const saveEn = await evl(`document.querySelector('button[type=submit]').textContent`);
  check('保存ボタンが Save', saveEn === 'Save', saveEn);
  const hintEn = await evl(`document.querySelector('#form p.hint').textContent`);
  check('ヒントも英語', hintEn.includes('DPAPI'), hintEn);
  await click('.tab[data-view=list]');
  await shot('05-english.png');

  await click('.tab[data-view=settings]');
  await evl(`${sel}.value = 'ja'; document.querySelector('#form').requestSubmit();`);
  await waitFor('日本語に戻る', `document.querySelector('.tab[data-view=list]').textContent === '通知'`, 20000);
  check('日本語に戻せる', true);
})().catch(e => {
  check(`例外: ${e.message}`, false);
}).finally(async () => {
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  console.log(`screenshots: ${OUT}`);
  try { cdp?.close(); } catch {}
  if (app) app.kill();
  if (m) await m.close();
  process.exit(failed.length ? 1 : 0);
});
