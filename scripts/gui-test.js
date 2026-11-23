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
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mock = require('./mock-gitlab.js');
const { tr } = require('../src/lib.js');

const REPO = path.join(__dirname, '..');
const OUT = path.join(REPO, 'dist', 'gui-test');
const PHASE12_OUT = path.join(REPO, 'dist', 'ui-pop-tech-phase12');
const BUILD_LABEL = `BUILD ${require('../package.json').version}`;
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

async function checkChipConnector(label, view, repos, types) {
  const matches = `(() => {
    const svg = document.querySelector('#${view} > svg.chip-connector[aria-hidden="true"]');
    const path = svg?.querySelector('path');
    if (!path?.getTotalLength() || path.getAnimations().length) return false;
    const origin = svg.getBoundingClientRect();
    const repo = document.querySelector('#${repos} .chip.active').getBoundingClientRect();
    const type = document.querySelector('#${types} .chip.active').getBoundingClientRect();
    const start = path.getPointAtLength(0);
    const end = path.getPointAtLength(path.getTotalLength());
    const near = (actual, expected) => Math.abs(actual - expected) < 0.5;
    return near(start.x + origin.left, repo.left + repo.width / 2)
      && near(end.x + origin.left, type.left + type.width / 2)
      && near(start.y + origin.top, repo.bottom + 4)
      && near(end.y + origin.top, type.top - 4);
  })()`;
  check(label, await waitFor(label, matches, 5000));
}
async function shot(name, dir = OUT) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`        → ${path.relative(REPO, file)}`);
}

// OS の配色設定を変えても、ネイティブコントロールを含め同じダークの画面になる。
// 検証方法: 全要素（::before / ::after の疑似要素と寸法を含む）の計算スタイルを
// ダーク/ライトで比較し、差分をプロパティ名と両値で報告する。
// #status は更新時刻が秒で動くため、比較中だけ textContent を空にする。
async function checkDarkTheme(label) {
  // hover/active のトランジション途中の値（drop-shadow のpx等）が採取間でズレて誤検出しないよう、
  // 採取中だけ各要素の style に transition/animation を止める値を当てる（静的な計算値に固定）。
  // CSP style-src 'self' では <style> 注入が弾かれるため、DOM API の element.style を使う
  const freeze = () => evl(`(() => {
    for (const el of document.querySelectorAll('*')) {
      el.style.setProperty('transition', 'none', 'important');
      el.style.setProperty('animation', 'none', 'important');
    }
  })()`);
  const collect = () => evl(`(() => {
    const restore = [];
    for (const e of document.querySelectorAll('#status')) { restore.push([e, e.textContent]); e.textContent = ''; }
    const keyOf = (el, i) => el.id ? '#' + el.id
      : (typeof el.className === 'string' && el.className.trim())
        ? el.tagName.toLowerCase() + '.' + el.className.trim().split(/\\s+/).join('.')
        : el.tagName.toLowerCase() + '[#' + i + ']';
    const snap = (el, pseudo) => {
      const cs = getComputedStyle(el, pseudo);
      const out = [];
      for (let i = 0; i < cs.length; i++) { const p = cs[i]; out.push(p + '=' + cs.getPropertyValue(p)); }
      return out.join('\\u0001');
    };
    const parts = [];
    [...document.querySelectorAll('*')].forEach((el, i) => {
      const k = keyOf(el, i);
      const r = el.getBoundingClientRect();
      parts.push(k + '\\u0002' + Math.round(r.x) + ',' + Math.round(r.y) + 'x' + Math.round(r.width) + 'x' + Math.round(r.height) + '\\u0002' + snap(el, null));
      parts.push(k + '::before\\u0002\\u0002' + snap(el, '::before'));
      parts.push(k + '::after\\u0002\\u0002' + snap(el, '::after'));
    });
    for (const [e, t] of restore) e.textContent = t;
    return parts.join('\\u0003');
  })()`);
  const diff = (a, b) => {
    const pa = a.split('\u0003'), pb = b.split('\u0003');
    const out = [];
    let n = 0;
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      if (pa[i] === pb[i]) continue;
      const [ka, ra, sa = ''] = (pa[i] || '').split('\u0002');
      const [kb, rb, sb = ''] = (pb[i] || '').split('\u0002');
      if (ka !== kb || ra !== rb) { out.push(`${ka} @${ra} → ${kb} @${rb}`); n++; continue; }
      const va = sa.split('\u0001'), vb = sb.split('\u0001');
      for (let j = 0; j < Math.max(va.length, vb.length); j++) {
        if (va[j] === vb[j]) continue;
        out.push(`${ka} ${va[j]} → ${vb[j]}`);
        n++;
      }
    }
    return { head: out.slice(0, 20), total: n };
  };
  const captures = {};
  for (const scheme of ['dark', 'light']) {
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    const styles = await evl(`({
      emulated: matchMedia('(prefers-color-scheme: ${scheme})').matches,
      schemes: [...document.querySelectorAll('html, select, input')].map(e => getComputedStyle(e).colorScheme),
    })`);
    check(`${label}: OS ${scheme} 設定でもルートと設定入力は dark`,
      styles.emulated && styles.schemes.every(v => v === 'dark'), JSON.stringify(styles));
    await freeze();
    captures[scheme] = await collect();
  }
  await cdp.send('Emulation.setEmulatedMedia', { features: [] });
  const d = diff(captures.dark, captures.light);
  check(`${label}: OS の明暗設定で描画が変わらない`, d.total === 0,
    d.total === 0 ? '' : `${d.total} 件の差分（先頭 20 件）\n` + d.head.join('\n'));
}

let app = null;
let m = null;

async function startApp(profile) {
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
}

async function stopApp() {
  cdp?.close();
  mainCdp?.close();
  cdp = mainCdp = null;
  if (app?.exitCode === null && app.signalCode === null) {
    const exited = once(app, 'exit');
    app.kill();
    await exited;
  }
  app = null;
}

async function checkConfigMessage(key, settingsKey = key) {
  const message = id => `document.querySelector(${JSON.stringify('#' + id)}).textContent`;
  await waitFor('設定タブが開く', `!document.querySelector('#settings').classList.contains('hidden') && ${message('error')}`);
  const lang = await evl('document.documentElement.lang');
  check(`起動時の設定エラー (${key})`, (await evl(message('error'))) === tr(lang, key)
    && (await evl(message('settingsMessage'))) === (settingsKey ? tr(lang, settingsKey) : ''));
  await click('.tab[data-view=list]');
  check(`一覧タブに案内を表示 (${key})`, await evl(`getComputedStyle(document.querySelector('#error')).display !== 'none'`));
  await click('.tab[data-view=settings]');
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(PHASE12_OUT, { recursive: true });
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
  await startApp(profile);
  if (!(await evlMain(STUB_MAIN))) throw new Error('main プロセスの差し替えに失敗');
  console.log('アプリ起動，画面に接続');

  // 3) モックのデータが描画される
  await waitFor('To-Do 一覧 4 件', `document.querySelectorAll('#todos li').length === 4`);
  check('To-Do タブに 4 件描画', (await count('#todos li')) === 4);
  await checkChipConnector('Activity の接続線がアクティブなチップに合う', 'list', 'todoRepos', 'actions');

  const activityPaths = `document.querySelectorAll('#list > .chip-connector > path')`;
  const activityRows = `document.querySelectorAll('#todos > li:not(.empty, .separator)')`;
  await evl(`window.__activityRepoPath = ${activityPaths}[0]`);
  for (const index of [0, 2]) {
    const hoverPoint = await evl(`(() => {
      const row = ${activityRows}[${index}].getBoundingClientRect();
      return { x: row.left + row.width / 2, y: row.top + row.height / 2 };
    })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...hoverPoint });
    const hoverLineMatches = `(() => {
      const [repoPath, rowPath] = ${activityPaths};
      if (repoPath !== window.__activityRepoPath || rowPath?.dataset.target !== 'row'
        || rowPath.getAttribute('pathLength') !== '1' || rowPath.getAnimations().length) return false;
      const origin = rowPath.ownerSVGElement.getBoundingClientRect();
      const chip = document.querySelector('#actions .chip.active').getBoundingClientRect();
      const cards = Array.from(${activityRows}, card => card.getBoundingClientRect());
      const row = cards[${index}];
      const d = rowPath.getAttribute('d');
      if (d.replace(/[^A-Z]/g, '') !== 'MVHVH') return false;
      const [x, y, bendY, gutterX, endY, endX] = d.split(' ').filter(token => !'MVH'.includes(token)).map(Number);
      const points = [[x, y], [x, bendY], [gutterX, bendY], [gutterX, endY], [endX, endY]];
      const near = (actual, expected) => Math.abs(actual - expected) < 0.5;
      const clearsCards = points.slice(1).every(([x2, y2], i) => {
        const [x1, y1] = points[i];
        return cards.every(card => Math.max(x1, x2) + origin.left + 1 <= card.left
          || Math.max(y1, y2) + origin.top + 1 <= card.top
          || Math.min(y1, y2) + origin.top - 1 >= card.bottom);
      });
      return near(x + origin.left, chip.left + chip.width / 2) && near(y + origin.top, chip.bottom + 4)
        && bendY > y && endY > bendY && gutterX >= 1
        && near(gutterX + origin.left, row.left - 6) && near(endX + origin.left, row.left - 4)
        && near(endY + origin.top, row.top + row.height / 2) && clearsCards;
    })()`;
    const label = `Activity のホバー線がカードを避けて ${index + 1} 行目の左辺中央に伸びる`;
    check(label, await waitFor(label, hoverLineMatches, 5000));
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
  check('Activity のホバー解除では分類チップまでの線が残る',
    await waitFor('Activity のホバー解除', `(() => {
      const paths = ${activityPaths};
      return paths.length === 1 && paths[0] === window.__activityRepoPath
        && Array.from(${activityRows}).every(row => !row.getAnimations({ subtree: true }).length);
    })()`, 5000));

  const status = await evl(`document.querySelector('#status').textContent`);
  check('ヘッダに件数と更新時刻', /4 件/.test(status), status);
  check('エラーバー非表示', await evl(`document.querySelector('#error').classList.contains('hidden')`));

  const tags = await evl(`[...document.querySelectorAll('#todos .tag')].map(e => e.textContent).join(',')`);
  check('種別ラベル', tags === 'レビュー依頼,アサイン,メンション,アサイン', tags);

  // #18: To-Do の種類は分類なので無彩色の1色。期限は行の右端、絞り込みチップに色の点は付けない
  const tagTones = await evl(`[...document.querySelectorAll('#todos .tag')].map(e => [...e.classList].find(c => c.startsWith('t-'))).join(',')`);
  check('To-Do の種類ラベルは無彩色', tagTones === 't-muted,t-muted,t-muted,t-muted', tagTones);
  const colors = await evl(`[...new Set([...document.querySelectorAll('#todos .tag')].map(e => getComputedStyle(e).color))]`);
  const [r, g, b] = (colors[0] ?? '').match(/\d+/g)?.map(Number) ?? [0, 255, 0];
  check('To-Do の種類ラベルは無彩色の1色', colors.length === 1 && Math.max(r, g, b) - Math.min(r, g, b) < 32, JSON.stringify(colors));
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
  await checkDarkTheme('To-Do 一覧');

  // 4) 期限の色分け
  const over = await count('#todos .due.over');
  const soon = await count('#todos .due.soon');
  check('期限切れは赤（over）', over === 1, `${over} 件`);
  check('3日以内は期限間近（soon）', soon === 1, `${soon} 件`);
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
  const assignedTabState = `(() => {
    const tab = document.querySelector('#assignedTab');
    const badges = tab.querySelectorAll('.warning-count');
    const badge = badges[0];
    return {
      label: tab.textContent, ariaLabel: tab.getAttribute('aria-label'), title: tab.title,
      count: badges.length, hidden: badge?.getAttribute('aria-hidden'),
      color: badge ? getComputedStyle(badge).backgroundColor : null,
    };
  })()`;
  const checkAssignedWarning = async (description, warning) => {
    const tab = await evl(assignedTabState);
    const valid = warning
      ? tab.count === 1 && tab.hidden === 'true' && tab.color === 'rgb(255, 36, 66)'
        && tab.ariaLabel === `Items (${warning})` && tab.title === warning
      : tab.count === 0 && tab.ariaLabel === null && tab.title === '';
    check(description, tab.label === 'Items' && valid, JSON.stringify(tab));
  };
  const chipWarnings = (bar = '#assigned') => evl(`Array.from(document.querySelectorAll(${JSON.stringify(`${bar} .chip:has(.warning-count)`)}), chip => {
    const badge = chip.querySelector('.warning-count');
    const { width, height } = badge.getBoundingClientRect();
    const tabBadge = document.querySelector('#assignedTab .warning-count');
    const bs = getComputedStyle(badge), ts = getComputedStyle(tabBadge);
    const samePaint = bs.backgroundColor === ts.backgroundColor && bs.clipPath === ts.clipPath;
    return { value: chip.dataset.value, name: chip.getAttribute('aria-label'), title: chip.title,
      valid: chip.tagName === 'BUTTON' && chip.querySelectorAll('.warning-count').length === 1
        && badge.getAttribute('aria-hidden') === 'true' && width === 12 && height === 12 && samePaint };
  })`);
  const titlebarState = `(() => {
    const titlebar = document.querySelector('.window-titlebar');
    const drag = titlebar.querySelector('.window-drag');
    const build = drag.querySelector('#build-version');
    const buildRect = build.getBoundingClientRect();
    const rect = drag.getBoundingClientRect();
    const titlebarRect = titlebar.getBoundingClientRect();
    const [minimizeRect, closeRect] = ['#win-minimize', '#win-close'].map(selector =>
      document.querySelector(selector).getBoundingClientRect());
    const style = node => getComputedStyle(node);
    return {
      width: window.innerWidth,
      build: build.textContent, buildVisible: buildRect.width > 0 && build.scrollWidth <= build.clientWidth,
      bannerVisible: style(titlebar).backgroundImage.includes('titlebar-banner.png'),
      fits: buildRect.left >= rect.left
        && buildRect.right <= rect.right && rect.right < minimizeRect.left
        && minimizeRect.width > 0 && minimizeRect.right < closeRect.left
        && closeRect.width > 0 && closeRect.right <= titlebarRect.right,
      drag: style(drag).getPropertyValue('-webkit-app-region'),
      pointerEvents: style(build).pointerEvents,
    };
  })()`;
  await waitFor('ビルドバージョンを取得', `document.querySelector('#build-version').textContent.length > 0`);
  const normalTitlebar = await evl(titlebarState);
  check('520px のタイトルバーにバナー背景と package.json の BUILD を表示し、ドラッグできる',
    normalTitlebar.width === 520 && normalTitlebar.bannerVisible && normalTitlebar.build === BUILD_LABEL
      && normalTitlebar.buildVisible && normalTitlebar.fits && normalTitlebar.drag === 'drag'
      && normalTitlebar.pointerEvents === 'none',
    JSON.stringify(normalTitlebar));
  check('Activity の chip に Items の警告を混ぜない', (await count('#list .chip .warning-count')) === 0);
  await shot('titlebar-build.png', PHASE12_OUT);
  const q = (await m.snapshot()).issuesQuery;
  check('作業アイテムの取得条件（自分の未完了を期限順に 100 件）',
    q?.scope === 'assigned_to_me' && q?.state === 'opened' && q?.order_by === 'due_date' && q?.sort === 'asc' && q?.per_page === '100',
    JSON.stringify(q));
  await checkAssignedWarning('Items と警告バッジを表示し、超過数は読み上げとツールチップで伝える', '期限超過 1 件');
  await click('.tab[data-view=assigned]');
  await waitFor('作業アイテム一覧 7 件', `document.querySelectorAll(${JSON.stringify(ROWS)}).length === 7`);
  await checkChipConnector('Items の接続線がアクティブなチップに合う', 'assigned', 'assignedRepos', 'assignedTypes');
  check('タブ切替で非表示の Activity のパスを空にする', (await count('#list .chip-connector path')) === 0);
  await checkDarkTheme('作業アイテム');
  const projectWarnings = await chipWarnings('#assignedRepos');
  const typeWarnings = await chipWarnings('#assignedTypes');
  check('期限超過があるプロジェクトと All にだけ同じ赤ひし形の警告を付ける',
    projectWarnings.map(chip => chip.value).join('|') === 'all|group/proj-a'
      && projectWarnings.every(chip => chip.valid && chip.name.endsWith('(期限超過 1 件)'))
      && projectWarnings[0].title === '期限超過 1 件' && projectWarnings[1].title === 'group/proj-a · 期限超過 1 件',
    JSON.stringify(projectWarnings));
  check('種別の All と Issue にも警告を付ける',
    typeWarnings.map(chip => chip.value).join('|') === 'all|issue' && typeWarnings.every(chip => chip.valid));
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
  check('種別のチップ', typeChips === 'All 7|Issue 4|タスク 2|インシデント 1', typeChips);
  await shot('02-assigned.png');

  // 配色の優先度（#18）: 期限超過が最も強く、絞り込みの選択中は警告色を使わず、MR 状態は種別ラベルと別の形
  await waitFor('MR 状態のバッジ', `document.querySelector('#assignedItems .mr-status')`);
  const look = await evl(`(() => {
    const s = q => getComputedStyle(document.querySelector(q));
    const over = s('#assignedItems .due.over'), plain = s('#assignedItems .due:not(.soon):not(.over)');
    const chip = document.querySelector('#assignedTypes .chip.active'), tag = s(${JSON.stringify(itemTags)});
    const mr = document.querySelector('#assignedItems .mr-status');
    const tags = [...document.querySelectorAll(${JSON.stringify(itemTags)})].filter(e => !e.classList.contains('t-danger'));
    return { overWeight: over.fontWeight, overColor: over.color, plainColor: plain.color,
      chipBg: getComputedStyle(chip, '::before').backgroundColor,
      tagBg: tag.backgroundColor, tagColors: [...new Set(tags.map(e => getComputedStyle(e).color))],
      mrText: mr && getComputedStyle(mr).color, mrMarkColor: mr && getComputedStyle(mr, '::before').color,
      mrBorder: mr && getComputedStyle(mr).borderTopWidth, mrMark: mr && getComputedStyle(mr, '::before').content };
  })()`);
  // 無彩色の判定。補足文字のグレー（#6e7781 など）はわずかに青みがあり RGB の幅が 19 前後になるので、
  // 有彩色（MR の緑・紫・赤は幅 100 以上）と確実に分けられる 32 未満を無彩色とみなす
  const neutral = c => { const [r, g, b] = c.match(/\d+/g).map(Number); return Math.max(r, g, b) - Math.min(r, g, b) < 32; };
  check('期限超過は太字で通常の期限と色が違う', Number(look.overWeight) >= 700 && look.overColor !== look.plainColor, JSON.stringify(look));
  const [chipR, chipG, chipB] = look.chipBg.match(/\d+/g).map(Number);
  check('絞り込みの選択中はライム系（赤を使わない）', chipG > chipR && chipR > chipB, look.chipBg);
  check('種別ラベルは塗らず、インシデント以外は無彩色の1色',
    /rgba\(0, 0, 0, 0\)|transparent/.test(look.tagBg) && look.tagColors.length === 1 && neutral(look.tagColors[0]), JSON.stringify(look.tagColors));
  check('MR 状態は枠なし・文字は控えめ・色は記号だけ',
    look.mrBorder === '0px' && neutral(look.mrText) && !neutral(look.mrMarkColor) && /[●○✓✕?]/.test(look.mrMark ?? ''),
    `${look.mrBorder} / ${look.mrText} / ${look.mrMarkColor} / ${look.mrMark}`);

  await evl(`document.querySelector('#assignedTypes .chip[data-value="task"]').focus()`);
  const enterKey = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 };
  await cdp.send('Input.dispatchKeyEvent', { ...enterKey, type: 'keyDown', text: '\r' });
  await cdp.send('Input.dispatchKeyEvent', { ...enterKey, type: 'keyUp' });
  await waitFor('タスクのみ', `document.querySelectorAll(${JSON.stringify(ROWS)}).length === 2`);
  check('キーボード Enter で種別を絞り込める', (await count(ROWS)) === 2);
  check('キーボードで選択した chip は再描画後もフォーカスと選択状態を持つ', await evl(
    `document.activeElement.matches('#assignedTypes .chip[data-value="task"][aria-pressed="true"]')`));
  await checkAssignedWarning('絞り込みで超過行が隠れてもタブの警告を保つ', '期限超過 1 件');
  check('種別で絞り込んでもプロジェクトの警告を保つ', (await chipWarnings('#assignedRepos')).length === 2);
  await clickChip('#assignedRepos', 'proj-b');
  await checkChipConnector('Items の接続線がリポジトリの選択に追従する', 'assigned', 'assignedRepos', 'assignedTypes');
  check('プロジェクトを絞ると種別の警告も選択中のプロジェクトに対応する',
    (await count('#assignedTypes .chip')) === 3 && (await chipWarnings('#assignedTypes')).length === 0
      && (await chipWarnings('#assignedRepos')).length === 2);
  await clickChip('#assignedRepos', 'proj-c');
  await waitFor('proj-c のみ', `document.querySelectorAll(${JSON.stringify(ROWS)}).length === 1`);
  check('種別が 1 つなら種別の行を隠す', (await count('#assignedTypes .chip')) === 0);
  const noTypePath = `!document.querySelector('#assigned .chip-connector path')`;
  check('Items の分類チップが消えるとパスを空にする', await waitFor('Items の接続線が消える', noTypePath, 5000));
  await clickChip('#assignedRepos', 'All');
  await waitFor('全件に戻す', `document.querySelectorAll(${JSON.stringify(ROWS)}).length === 7`);
  check('隠れた種別の選択は解除される', (await count('#assignedTypes .chip.active')) === 1
    && (await evl(`document.querySelector('#assignedTypes .chip.active').textContent`)).startsWith('All '));

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
  await waitFor('ポーリングで新規 MR のバッジが出る',
    `${badgeState(1, 17, 1, 46)} === 'オープン'`, 45000);
  await m.transitionMr('merged');
  await refreshMrs();
  await waitFor('マージで Issue が一覧から消える',
    `!document.querySelector(${JSON.stringify(itemRow(1, 17))})
    && document.querySelectorAll(${JSON.stringify(ROWS)}).length === 6`);
  await m.transitionMr('closed');
  await refreshMrs();
  await waitFor('未マージのクローズはマージと別表示で Issue を閉じない',
    `${badgeState(2, 23, 2, 45)} === 'クローズ（未マージ）'`);

  const beforeRepeat = await m.snapshot();
  await refreshMrs();
  await waitUntil('差分同期で前回と重なる MR が再び返る', async () => {
    const snap = await m.snapshot();
    return snap.mrListRequests.slice(beforeRepeat.mrListRequests.length)
      .some(({ projectId, matched }) => projectId === 2 && matched.includes(45));
  });
  const afterRepeat = await m.snapshot();
  check('重なる時刻窓でも、同じ MR の同じ更新は再照合しない',
    afterRepeat.closesIssueRequests.length === beforeRepeat.closesIssueRequests.length,
    `照合 ${beforeRepeat.closesIssueRequests.length} → ${afterRepeat.closesIssueRequests.length}`);
  check('個別 Issue の MR 有無確認リクエストは発生しない', afterRepeat.perIssueRequests.length === 0,
    JSON.stringify(afterRepeat.perIssueRequests));
  check('MR の同期は To-Do の件数に加算されない', (await count('#todos li')) === 4
    && (await evl('window.api.getState().then(s => s.count)')) === 4);
  await shot('07-related-mrs-ja.png');

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
    (await count('#todos li')) === 4 &&
    await evl(`document.querySelector('#error').classList.contains('hidden') && ${badgeState(2, 23, 2, 45)} === 'クローズ（未マージ）'`));
  await m.fail('mergeRequests', 0);
  await m.transitionMr('reopen-issue'); // 後続の既存テストでは初期の7件が必要。
  await refreshMrs();
  await waitFor('MR 同期成功でエラーが消え、再オープンした Issue が戻る',
    `document.querySelector('#mrSyncError').hidden && document.querySelectorAll(${JSON.stringify(ROWS)}).length === 7`);

  // 6) 絞り込み
  await click('.tab[data-view=list]');
  const chips = await evl(`[...document.querySelectorAll('#todoRepos .chip')].map(e => e.textContent).join('|')`);
  const repoCounts = await evl(`[...document.querySelectorAll('#todoRepos .chip > .chip-count')].map(e => e.textContent).join('|')`);
  check('リポジトリのチップと件数バッジ', chips.includes('proj-a 2') && chips.includes('proj-b 2') && repoCounts === '4|2|2',
    `${chips} / ${repoCounts}`);
  await clickChip('#todoRepos', 'proj-b');
  await waitFor('proj-b のみ', `document.querySelectorAll('#todos li').length === 2`);
  check('リポジトリで絞り込み', (await count('#todos li')) === 2);
  await clickChip('#actions', 'メンション');
  await waitFor('種別でも絞り込み', `document.querySelectorAll('#todos li').length === 1`);
  check('種別でも絞り込み', (await count('#todos li')) === 1);
  await checkChipConnector('Activity の接続線がリポジトリと分類の選択に追従する', 'list', 'todoRepos', 'actions');
  await shot('03-filtered.png');
  await clickChip('#todoRepos', 'All');
  await clickChip('#actions', 'All');
  await waitFor('全件に戻す', `document.querySelectorAll('#todos li').length === 4`);

  // 7) 「完了」ボタン → 押した瞬間に反応し、失敗時は復元、成功時は一覧から消える
  const head = await evl(`document.querySelector('#todos li .title').textContent`);
  const doneRow = `[...document.querySelectorAll('#todos li')].find(row =>
    row.querySelector('.title')?.textContent === ${JSON.stringify(head)})`;
  const openedBeforeDone = await evlMain('globalThis.__opened.length');
  await m.fail('done', 500);
  await click('#todos .done-button');
  await waitFor('完了に失敗すると行とボタンが元に戻る', `(() => {
    const row = ${doneRow};
    const error = document.querySelector('#error');
    return row && !row.classList.contains('done-pending') && !row.querySelector('button').disabled
      && !error.classList.contains('hidden') && error.textContent.includes('完了処理に失敗');
  })()`);
  check('完了失敗時はエラーを表示して再試行できる', (await m.snapshot()).done.length === 0);
  await m.fail('done', 0);

  const pending = await evl(`(() => {
    const row = ${doneRow};
    const button = row.querySelector('button');
    button.click();
    const immediate = row.classList.contains('done-pending') && button.disabled;
    render(current);
    const redrawn = ${doneRow};
    return { immediate, afterRender: redrawn !== row
      && redrawn.classList.contains('done-pending') && redrawn.querySelector('button').disabled };
  })()`);
  check('完了クリック直後に行が処理中になり、ボタンが無効になる', pending.immediate);
  check('再描画後も完了処理中の表示とボタンの無効状態を維持する', pending.afterRender);
  await waitUntil('モック側で完了', async () => (await m.snapshot()).done.length === 1);
  await waitFor('一覧から消える', `!(${doneRow}) && document.querySelectorAll('#todos li').length === 3`);
  check('完了ボタンで To-Do が消える', true, `先頭: ${head.slice(0, 12)}…`);
  check('完了ボタンは行の URL を開かない', await evlMain('globalThis.__opened.length') === openedBeforeDone);
  const snap = await m.snapshot();
  check('mark_as_done が呼ばれた', snap.done.length === 1 && snap.done[0].id === 101, JSON.stringify(snap.done));

  // 8) バッジの描画 → main に渡す流れ。preload は凍結していてフックできないので、
  //    canvas のサイズと main に届く IPC の内容を記録してから再読み込みする
  await evlMain(`(() => {
    const { ipcMain, nativeImage } = process.mainModule.require('electron');
    ipcMain.once('badge', (_event, badge) => {
      globalThis.__badgePayload = {
        keys: Object.keys(badge).sort(),
        count: badge.count,
        size: nativeImage.createFromDataURL(badge.overlay).getSize(),
      };
    });
  })()`);
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__draws = [];
      const orig = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function (...a) {
        window.__draws.push([this.width, this.height]);
        return orig.apply(this, a);
      };
      const origText = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (t, ...a) { window.__badge = t; return origText.call(this, t, ...a); };`,
  });
  await cdp.send('Page.reload');
  await waitFor('再読み込み後に一覧', `document.querySelectorAll('#todos li').length === 3`, 20000);
  await waitFor('バッジ画像を描画', `window.__draws.length > 0`, 10000);
  await waitUntil('バッジ IPC が main に届く', () => evlMain('globalThis.__badgePayload'));
  const draws = await evl(`window.__draws`);
  const payload = await evlMain('globalThis.__badgePayload');
  check('16px のバッジ画像を描画して main に渡す', draws.every(([w, h]) => w === 16 && h === 16)
    && payload.keys.join(',') === 'count,overlay' && payload.count === 3
    && payload.size.width === 16 && payload.size.height === 16, `${draws.length} 回描画`);
  // 作業アイテムは 7 件あるが、バッジの件数は To-Do だけ
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
  const errorShown = `!document.querySelector('#error').classList.contains('hidden')`;
  const errorHidden = `document.querySelector('#error').classList.contains('hidden')`;
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
  const todoHitsBeforeRecovery = (await m.snapshot()).conditionalHitsByList.todos;
  await m.fail('todos', 0);
  await click('#refresh');
  await waitFor('To-Do の失敗が消える', errorHidden);
  check('304 でも To-Do のエラーが消える', (await evl(errorText)) === ''
    && (await m.snapshot()).conditionalHitsByList.todos > todoHitsBeforeRecovery);

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
  const assignedTotalIs = n => `window.api.getState().then(state => state.assignedTotal === ${n})`;
  check('上限未満ならお知らせなし', await evl(limitHidden));
  await m.setAssignedCount(150);
  await click('#refresh');
  await waitFor('上限のお知らせが出る', `!${limitHidden}`);
  const limitText = await evl(`document.querySelector('#assignedLimit').textContent`);
  check('上限のお知らせ', limitText === '100 件まで表示', limitText);
  check('取得するのは 100 件まで', (await count(ROWS)) === 100);
  check('x-total の総数を状態に保持', await evl(assignedTotalIs(150)));
  await checkAssignedWarning('取得上限に達しても Items と警告バッジを表示する', '期限超過 1 件');
  await m.setAssignedTotal('151');
  await click('#refresh');
  await waitFor('一覧が同じでも総数だけ更新する', assignedTotalIs(151));
  // x-total が無くても、100 件返ってきたら上限とみなす
  await m.setAssignedTotal('none');
  await click('#refresh');
  await waitFor('x-total が無ければ取得件数の 100 件を保持する', assignedTotalIs(100));
  check('x-total なしで 100 件ならお知らせを出す', !(await evl(limitHidden)));
  await m.setAssignedCount(null);
  await click('#refresh');
  await waitFor('x-total なしで 7 件', `document.querySelectorAll(${JSON.stringify(ROWS)}).length === 7`);
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

  // 9-6) Issue #20: ETag による条件付きリクエスト
  const before304 = await m.snapshot();
  const notificationsBefore304 = (await shownBodies()).length;
  await evl('window.api.refresh()');
  const after304 = await m.snapshot();
  check('To-Do と作業アイテムの両方で 304 が戻る', after304.conditionalHits > before304.conditionalHits
    && after304.conditionalHitsByList.todos > before304.conditionalHitsByList.todos
    && after304.conditionalHitsByList.issues > before304.conditionalHitsByList.issues);
  check('304 でも一覧を保ち、重複通知しない', (await count('#todos li')) === 6 && (await count(ROWS)) === 7
    && (await shownBodies()).length === notificationsBefore304);
  await m.push();
  await waitFor('304 のあとも新着を拾える', `document.querySelectorAll('#todos li').length === 7`);
  check('304 のあとも新着を通知する', (await shownBodies()).includes('モックから押した新着 4'));
  // ETag を無効にしたサーバでも、200 の本文から一覧を更新できる。
  await m.etagOff();
  await m.setAssignedCount(8);
  await evl('window.api.refresh()');
  await waitFor('ETag なしのフル取得で一覧を更新する', `document.querySelectorAll(${JSON.stringify(ROWS)}).length === 8`);
  check('ETag なしでも To-Do と作業アイテムを表示できる', (await count('#todos li')) === 7 && (await count(ROWS)) === 8);
  await m.setAssignedCount(null);
  await evl('window.api.refresh()');
  await waitFor('作業アイテムを 7 件に戻す', `document.querySelectorAll(${JSON.stringify(ROWS)}).length === 7`);

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

  const checkFixedLabels = async (locale, refreshLabel, settingsLabel) => {
    const out = await evl(`(() => {
      const refresh = document.querySelector('#refresh');
      const out = {
        tabs: [...document.querySelectorAll('.tab')].map(e => e.textContent),
        chips: [...document.querySelectorAll('.bar .chip:first-child')].map(e => e.textContent),
        refreshText: refresh.textContent.trim(),
        refreshIcon: !!refresh.querySelector('svg[aria-hidden="true"] path'),
        refreshLabel: refresh.getAttribute('aria-label'),
        refreshTitle: refresh.title,
        settingsTab: document.querySelector('.tab[data-view=settings]'),
      };
      out.settingsText = out.settingsTab.textContent.trim();
      out.settingsIcon = !!out.settingsTab.querySelector('svg[aria-hidden="true"]');
      out.settingsLabel = out.settingsTab.getAttribute('aria-label');
      out.settingsTitle = out.settingsTab.title;
      return out;
    })()`);
    delete out.settingsTab;
    check(`${locale}: タブは Activity / Items / 設定アイコン`,
      out.tabs[0] === 'Activity' && out.tabs[1] === 'Items'
        && out.settingsText === '' && out.settingsIcon
        && out.settingsLabel === settingsLabel && out.settingsTitle === settingsLabel,
      `${out.tabs.join('|')} / settings=${out.settingsText} label=${out.settingsLabel}`);
    check(`${locale}: 絞り込みの先頭は All`,
      out.chips.length === 4 && out.chips.every(text => /^All \d+$/.test(text)), out.chips.join('|'));
    check(`${locale}: 更新はアイコン表示、aria-label と title は翻訳済み`,
      out.refreshIcon && out.refreshText === '' && out.refreshLabel === refreshLabel && out.refreshTitle === refreshLabel);
  };
  await checkFixedLabels('ja', '更新', 'Settings');
  await evl(`${sel}.value = 'en'; document.querySelector('#form').requestSubmit();`);
  await waitFor('英語に切り替わる', `document.documentElement.lang === 'en'`, 20000);
  await checkFixedLabels('en', 'Refresh', 'Settings');
  const tagsEn = await evl(`[...document.querySelectorAll('#todos .tag')].map(e => e.textContent).join(',')`);
  check('種別ラベルが英語', /Mentioned/.test(tagsEn) && /Assigned/.test(tagsEn) && !/メンション/.test(tagsEn), tagsEn);
  const doneEn = await evl(`document.querySelector('#todos button').getAttribute('aria-label')`);
  check('完了ボタンの読み上げ名が Done', doneEn === 'Done', doneEn);
  const statusEn = await evl(`document.querySelector('#status').textContent`);
  check('ヘッダが英語', /\d+ to-dos/.test(statusEn), statusEn);
  const dueEn = await evl(`[...document.querySelectorAll('#todos .due')].map(e => e.textContent).join(' | ')`);
  check('期限表示が英語', dueEn.includes('overdue') && dueEn.includes('Milestone'), dueEn);
  await checkAssignedWarning('英語の Items タブに警告バッジと超過数の補助文言を表示する', '1 overdue');
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
  await shot('ui-settings.png');
  await checkDarkTheme('設定');
  await click('.tab[data-view=list]');
  await shot('05-english.png');
  // README の 2 枚目（英語の作業アイテムタブ）。
  await click('.tab[data-view=assigned]');
  const headerProblems = `(() => {
    const header = document.querySelector('header');
    const bounds = header.getBoundingClientRect();
    return [...header.children].flatMap(element => {
      if (element.matches('.spacer:empty')) return [];
      if (!element.matches('.tab, #status, #refresh')) return [element.tagName];
      const rect = element.getBoundingClientRect();
      const outside = rect.width === 0 || rect.left < bounds.left || rect.right > bounds.right;
      const clippedTab = element.matches('.tab') && element.scrollWidth > element.clientWidth;
      const icon = element.querySelector('svg')?.getBoundingClientRect();
      const clippedIcon = element.id === 'refresh' && (!icon || icon.width === 0 ||
        icon.left < rect.left || icon.right > rect.right || icon.top < rect.top || icon.bottom > rect.bottom);
      const badge = element.querySelector('.warning-count')?.getBoundingClientRect();
      // 警告バッジはタブ/チップの左上角に意図的にはみ出して配置するため、サイズだけを検証する
      const clippedBadge = badge && (badge.width < 10 || badge.width > 14);
      return outside || clippedTab || clippedIcon || clippedBadge ? [element.id || element.textContent] : [];
    });
  })()`;
  const normalWithWarning = await evl(headerProblems);
  const englishWarnings = await chipWarnings();
  check('英語の chip は 1 overdue を読み上げ名とツールチップで伝える',
    englishWarnings.length === 4 && englishWarnings.every(chip => chip.valid
      && chip.title.endsWith('1 overdue') && chip.name.endsWith('(1 overdue)')));
  await shot('items-with-warning.png', PHASE12_OUT);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 640, deviceScaleFactor: 1, mobile: false });
  const narrowWidth = await evl('window.innerWidth');
  const narrowWithWarning = await evl(headerProblems);
  const narrowTitlebar = await evl(titlebarState);
  const narrowWarnings = await chipWarnings();
  check('320px でもバナー画像、BUILD、最小化・閉じるボタンが収まる',
    narrowWidth === 320 && narrowTitlebar.bannerVisible && narrowTitlebar.buildVisible && narrowTitlebar.fits
      && await evl('document.documentElement.scrollWidth === document.documentElement.clientWidth')
      && narrowWarnings.length === 4 && narrowWarnings.every(chip => chip.valid), JSON.stringify(narrowTitlebar));
  await shot('items-320.png', PHASE12_OUT);
  await shot('english-320.png');
  await click('.tab[data-view=list]');
  check('320px でも Activity 行の完了ボタンが収まる', narrowWidth === 320 && await evl(`(() => {
    const buttons = [...document.querySelectorAll('#todos .done-button')];
    return buttons.length > 0 && document.documentElement.scrollWidth === document.documentElement.clientWidth
      && buttons.every(button => {
        const tile = button.getBoundingClientRect();
        const row = button.closest('li').getBoundingClientRect();
        return tile.width > 0 && row.right <= window.innerWidth && tile.right <= row.right;
      });
  })()`));
  await click('.tab[data-view=assigned]');
  const overdueIssue = m.state.issues.find(i => i.id === 217);
  const overdueDate = overdueIssue.due_date;
  overdueIssue.due_date = m.state.issues.find(i => i.id === 222).due_date;
  await evl('window.api.refresh()');
  await waitFor('期限超過が解消するとタブのバッジが消える', `(${assignedTabState}).count === 0`);
  await checkAssignedWarning('期限超過がなければ Items だけを表示する', '');
  check('超過が解消すると chip の警告バッジと補助文言も消える',
    (await chipWarnings()).length === 0
      && (await count('#assigned .chip[aria-label], #assigned .chip[title*="overdue"]')) === 0
      && (await count('#assignedRepos .chip[title="group/proj-a"]')) === 1);
  const narrowWithoutWarning = await evl(headerProblems);
  await shot('english-320-no-warning.png');
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  const normalWithoutWarning = await evl(headerProblems);
  await shot('items-without-warning.png', PHASE12_OUT);
  overdueIssue.due_date = overdueDate;
  await evl('window.api.refresh()');
  await waitFor('期限超過が戻るとタブのバッジを再表示する', `(${assignedTabState}).count === 1`);
  check('期限超過が戻ると chip の警告を再表示する', (await chipWarnings()).length === 4);
  check('英語の通常幅と 320px 幅で警告の有無にかかわらずヘッダが収まる',
    narrowWidth === 320 && [normalWithWarning, normalWithoutWarning, narrowWithWarning, narrowWithoutWarning].every(problems => problems.length === 0),
    JSON.stringify({ normalWithWarning, normalWithoutWarning, narrowWidth, narrowWithWarning, narrowWithoutWarning }));
  await shot('08-assigned-en.png');
  await click('.tab[data-view=list]');

  await click('.tab[data-view=settings]');
  await evl(`${sel}.value = 'ja'; document.querySelector('#form').requestSubmit();`);
  await waitFor('日本語に戻る', `document.documentElement.lang === 'ja'`, 20000);
  check('日本語に戻せる', (await evl(`document.querySelector('#refresh').getAttribute('aria-label')`)) === '更新');

  await stopApp();
  const configFile = path.join(profile, 'config.json');
  const previous = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  fs.unlinkSync(configFile);
  await startApp(profile);
  await checkConfigMessage('errNotConfigured', null);
  await stopApp();

  fs.writeFileSync(configFile, '{ invalid');
  await startApp(profile);
  await checkConfigMessage('errConfigRead');
  await stopApp();

  const broken = JSON.stringify({ ...previous, lang: 'en', tokenEnc: Buffer.from('invalid ciphertext').toString('base64') });
  fs.writeFileSync(configFile, broken);
  await startApp(profile);
  await waitFor('保存済みの表示言語を適用する', `document.documentElement.lang === 'en'`);
  await checkConfigMessage('errTokenDecrypt');
  check('復号に失敗しても URL、取得間隔、表示言語を維持する', await evl(`(() => {
    const f = document.querySelector('#form');
    return f.baseUrl.value === ${JSON.stringify(previous.baseUrl)}
      && Number(f.intervalSec.value) === ${previous.intervalSec} && f.elements.lang.value === 'en';
  })()`));
  check('設定タブに復号エラーを一つだけ表示する', await evl(`
    getComputedStyle(document.querySelector('#settingsMessage')).display !== 'none'
      && getComputedStyle(document.querySelector('#error')).display === 'none'
  `));

  const submit = `document.querySelector('#form').requestSubmit()`;
  const saveReady = `!document.querySelector('#form button[type=submit]').disabled`;
  await evl(submit);
  await waitFor('空欄での保存が完了する', saveReady);
  check('空欄で保存しても暗号化データと再入力の案内を維持する',
    fs.readFileSync(configFile, 'utf8') === broken
      && (await evl(`document.querySelector('#settingsMessage').textContent`)) === tr('en', 'errTokenDecrypt'));

  await evlMain(`(() => {
    const { safeStorage } = process.mainModule.require('electron');
    globalThis.__encryptionAvailable = safeStorage.isAsyncEncryptionAvailable;
    safeStorage.isAsyncEncryptionAvailable = async () => false;
  })()`);
  await evl(`document.querySelector('#form').token.value = ${JSON.stringify(m.token)}; ${submit}`);
  const settingsText = `document.querySelector('#settingsMessage').textContent`;
  await waitFor('暗号化機能を利用できない案内を表示する', `${settingsText} === ${JSON.stringify(tr('en', 'errEncryptionUnavailable'))}`);
  check('暗号化を利用できない場合は設定を保存せずに案内する',
    (await evl(`Boolean(document.querySelector('#form').token.value)`)) && fs.readFileSync(configFile, 'utf8') === broken);
  await evlMain(`process.mainModule.require('electron').safeStorage.isAsyncEncryptionAvailable = globalThis.__encryptionAvailable; true`);
  await evl(submit);
  await waitFor('トークンの再入力で取得が再開する', `
    !${settingsText} && document.querySelector('#error').classList.contains('hidden')
      && document.querySelector('#status').textContent.includes('to-dos')
  `);
  check('トークンを再入力して保存すると案内が消え、暗号化データが更新される',
    JSON.parse(fs.readFileSync(configFile, 'utf8')).tokenEnc !== JSON.parse(broken).tokenEnc);
})().catch(e => {
  check(`例外: ${e.message}`, false);
}).finally(async () => {
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  console.log(`screenshots: ${OUT}`);
  await stopApp();
  if (m) await m.close();
  process.exit(failed.length ? 1 : 0);
});
