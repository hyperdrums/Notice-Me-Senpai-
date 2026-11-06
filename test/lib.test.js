const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  LANGS, CONFIG_DEFAULTS, TYPES, UI, ACTIONS, ASSIGNED_LIMIT, tr, actionLabel,
  apiUrl, mergeConfig, intervalSec, freshTodos, todoRepo, issueRepo, shortName, dueInfo, ago,
  todoRef, workItemType, workItemTypeLabel, splitByDue, countOverdue, reachedLimit, assignedPatch, assignedTabLabel,
} = require('../src/lib.js');

// ---------- apiUrl ----------
test('apiUrl: baseUrl の末尾スラッシュを揃える', () => {
  assert.equal(apiUrl('https://gitlab.com', '/todos'), 'https://gitlab.com/api/v4/todos');
  assert.equal(apiUrl('https://gitlab.com/', '/todos'), 'https://gitlab.com/api/v4/todos');
  assert.equal(apiUrl('https://gitlab.example.com///', '/todos?state=pending'),
    'https://gitlab.example.com/api/v4/todos?state=pending');
});

// ---------- mergeConfig ----------
test('mergeConfig: トークンが空欄なら既存を維持する', () => {
  const prev = { token: 'glpat-old' };
  assert.equal(mergeConfig(prev, { token: '' }).token, 'glpat-old');
  assert.equal(mergeConfig(prev, {}).token, 'glpat-old');
  assert.equal(mergeConfig(prev, { token: '  glpat-new  ' }).token, 'glpat-new');
});

test('mergeConfig: 入力値を正しい型に直す', () => {
  const c = mergeConfig({ token: 't' }, {
    baseUrl: '  https://gitlab.com  ', intervalSec: '120', notify: 1, insecure: 0, autoStart: true,
  });
  assert.equal(c.baseUrl, 'https://gitlab.com');
  assert.equal(c.intervalSec, 120);
  assert.equal(c.notify, true);
  assert.equal(c.insecure, false);
  assert.equal(c.autoStart, true);
});

test('mergeConfig: 取得間隔が不正なら既定の 60 秒', () => {
  assert.equal(mergeConfig({}, { intervalSec: 'abc' }).intervalSec, CONFIG_DEFAULTS.intervalSec);
  assert.equal(mergeConfig({}, { intervalSec: '' }).intervalSec, CONFIG_DEFAULTS.intervalSec);
});

test('mergeConfig: 言語は既定値と指定値、未知の値は据え置き', () => {
  assert.equal(mergeConfig({ lang: 'ja' }, {}).lang, 'ja');
  assert.equal(mergeConfig({ lang: 'ja' }, { lang: 'en' }).lang, 'en');
  assert.equal(mergeConfig({ lang: 'en' }, { lang: 'de' }).lang, 'en');   // 無い言語は無視
  assert.equal(CONFIG_DEFAULTS.lang, 'ja');
});

// ---------- intervalSec ----------
test('intervalSec: 最小 15 秒、不正値は既定', () => {
  assert.equal(intervalSec(60), 60);
  assert.equal(intervalSec(5), 15);
  assert.equal(intervalSec(0), CONFIG_DEFAULTS.intervalSec);
  assert.equal(intervalSec(undefined), CONFIG_DEFAULTS.intervalSec);
});

// ---------- freshTodos ----------
test('freshTodos: 初回（knownIds が null）は新着なし扱い', () => {
  assert.deepEqual(freshTodos(null, [{ id: 1 }, { id: 2 }]), []);
});

test('freshTodos: 既知の ID を除いて残す', () => {
  const known = new Set([1, 2]);
  const fresh = freshTodos(known, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.deepEqual(fresh, [{ id: 3 }]);
});

test('freshTodos: 変わらなければ空', () => {
  assert.deepEqual(freshTodos(new Set([1]), [{ id: 1 }]), []);
});

// ---------- dueInfo ----------
const TODAY = new Date('2026-11-03T12:00:00');

test('dueInfo: 期限を過ぎたら赤（over）', () => {
  const d = dueInfo('2026-11-01', { prefix: '期限', today: TODAY });
  assert.equal(d.cls, 'due over');
  assert.equal(d.text, '期限 11/1 (2日超過)');
});

test('dueInfo: 今日と3日以内は橙（soon）', () => {
  assert.equal(dueInfo('2026-11-03', { today: TODAY }).cls, 'due soon');
  assert.equal(dueInfo('2026-11-06', { today: TODAY }).cls, 'due soon');
  assert.equal(dueInfo('2026-11-03', { today: TODAY }).text, '期限 11/3 (今日まで)');
  assert.equal(dueInfo('2026-11-06', { today: TODAY }).text, '期限 11/6 (あと3日)');
});

test('dueInfo: 4日以降は色なし', () => {
  assert.equal(dueInfo('2026-11-07', { today: TODAY }).cls, 'due');
});

test('dueInfo: prefix を変えられる（マイルストーン期限）', () => {
  assert.equal(dueInfo('2026-11-10', { prefix: 'MS期限', today: TODAY }).text, 'MS期限 11/10 (あと7日)');
});

test('dueInfo: prefix を省略すると言語で決まる', () => {
  assert.equal(dueInfo('2026-11-10', { today: TODAY, lang: 'en' }).text, 'Due 11/10 (in 7d)');
  assert.equal(dueInfo('2026-11-01', { today: TODAY, lang: 'en' }).text, 'Due 11/1 (2d overdue)');
});

test('dueInfo: 渡した today を書き換えない', () => {
  const before = TODAY.getTime();
  dueInfo('2026-11-05', { today: TODAY });
  assert.equal(TODAY.getTime(), before);
});

// ---------- ago ----------
const NOW = new Date('2026-11-03T12:00:00').getTime();
const minsAgo = (m, lang) => ago(new Date(NOW - m * 60000).toISOString(), { now: NOW, lang });

test('ago: 経過時間の表示', () => {
  assert.equal(minsAgo(0), 'たった今');
  assert.equal(minsAgo(59), '59分前');
  assert.equal(minsAgo(60), '1時間前');
  assert.equal(minsAgo(180), '3時間前');
  assert.equal(minsAgo(1440), '1日前');
  assert.equal(minsAgo(2880), '2日前');
});

test('ago: 英語', () => {
  assert.equal(minsAgo(0, 'en'), 'just now');
  assert.equal(minsAgo(45, 'en'), '45m ago');
  assert.equal(minsAgo(180, 'en'), '3h ago');
  assert.equal(minsAgo(2880, 'en'), '2d ago');
});

// ---------- リポジトリ名の抽出 ----------
test('todoRepo: プロジェクト → グループ → (なし) の順に落とす', () => {
  assert.equal(todoRepo({ project: { path_with_namespace: 'group/proj' } }), 'group/proj');
  assert.equal(todoRepo({ group: { full_path: 'group' } }), 'group');
  assert.equal(todoRepo({}), '(なし)');
  assert.equal(todoRepo({}, 'en'), '(none)');
});

test('issueRepo: references.full の末尾 #12 !34 を落とす', () => {
  assert.equal(issueRepo({ references: { full: 'group/proj!12' } }), 'group/proj');
  assert.equal(issueRepo({ references: { full: 'group/proj#7' } }), 'group/proj');
  assert.equal(issueRepo({ project_id: 7 }), '7');
});

test('shortName: 末尾の名前だけ残す', () => {
  assert.equal(shortName('group/sub/proj'), 'proj');
});

// ---------- 作業アイテムタブ ----------
test('workItemType: issue_type が無ければ issue', () => {
  assert.equal(workItemType({ issue_type: 'task' }), 'task');
  assert.equal(workItemType({}), 'issue');
  assert.equal(workItemType({ issue_type: null }), 'issue');
});

test('workItemTypeLabel: 日英のラベル', () => {
  assert.deepEqual(['issue', 'incident', 'test_case', 'task'].map(t => workItemTypeLabel('ja', t)),
    ['Issue', 'インシデント', 'テストケース', 'タスク']);
  assert.deepEqual(['issue', 'incident', 'test_case', 'task'].map(t => workItemTypeLabel('en', t)),
    ['Issue', 'Incident', 'Test case', 'Task']);
});

test('workItemTypeLabel: 未知の種別は生の値を返す', () => {
  assert.equal(workItemTypeLabel('ja', 'future_type'), 'future_type');
  assert.equal(workItemTypeLabel('en', 'future_type'), 'future_type');
});

test('splitByDue: 期限が近い順に並べ、期限なしを分ける', () => {
  const items = [
    { iid: 1, due_date: null }, { iid: 2, due_date: '2026-12-01' }, { iid: 3 },
    { iid: 4, due_date: '2026-11-01' }, { iid: 5, due_date: '2026-11-15' },
  ];
  const { dated, undated } = splitByDue(items);
  assert.deepEqual(dated.map(i => i.iid), [4, 5, 2]);
  assert.deepEqual(undated.map(i => i.iid), [1, 3]);
});

test('splitByDue: 渡した配列を書き換えない', () => {
  const items = [{ iid: 1, due_date: '2026-12-01' }, { iid: 2, due_date: '2026-11-01' }];
  splitByDue(items);
  assert.deepEqual(items.map(i => i.iid), [1, 2]);
});

test('countOverdue: 期限なしは超過に数えない（今日までも超過ではない）', () => {
  const items = [
    { due_date: '2026-11-01' }, { due_date: '2026-11-02' }, { due_date: '2026-11-03' },
    { due_date: '2026-11-04' }, { due_date: null }, {},
  ];
  assert.equal(countOverdue(items, { today: TODAY }), 2);
});

test('assignedTabLabel: 合計と、あれば超過数', () => {
  const over = [{ due_date: '2026-11-01' }, { due_date: null }, {}];
  const noOver = [{ due_date: '2026-11-10' }, { due_date: null }];
  assert.equal(assignedTabLabel(over, { today: TODAY }), '作業アイテム 3 (超過1)');
  assert.equal(assignedTabLabel(over, { today: TODAY, lang: 'en' }), 'Work items 3 (1 overdue)');
  assert.equal(assignedTabLabel(noOver, { today: TODAY }), '作業アイテム 2');
  assert.equal(assignedTabLabel(noOver, { today: TODAY, lang: 'en' }), 'Work items 2');
  assert.equal(assignedTabLabel([{}], { today: TODAY }), '作業アイテム 1');
});

test('assignedTabLabel: total があれば取得できた行数より優先する', () => {
  const over = [{ due_date: '2026-11-01' }, {}];
  assert.equal(assignedTabLabel(over, { today: TODAY, total: 150 }), '作業アイテム 150 (超過1)');
  assert.equal(assignedTabLabel(over, { today: TODAY, total: 150, lang: 'en' }), 'Work items 150 (1 overdue)');
  assert.equal(assignedTabLabel([{}], { today: TODAY, total: 150 }), '作業アイテム 150');
  assert.equal(assignedTabLabel(over, { today: TODAY, total: null }), '作業アイテム 2 (超過1)');
});

test('assignedTabLabel: 0 件ならタブ名だけ', () => {
  assert.equal(assignedTabLabel([]), '作業アイテム');
  assert.equal(assignedTabLabel([], { lang: 'en' }), 'Work items');
});

test('reachedLimit: x-total があれば上限を超えたかで決まる', () => {
  assert.equal(reachedLimit('101', 100), true);
  assert.equal(reachedLimit('100', 100), false);   // ちょうど 100 件は全件取れている
  assert.equal(reachedLimit('12', 12), false);
  assert.equal(ASSIGNED_LIMIT, 100);
});

test('reachedLimit: x-total が無ければ返ってきた件数で決まる', () => {
  assert.equal(reachedLimit(null, 100), true);
  assert.equal(reachedLimit(undefined, 100), true);
  assert.equal(reachedLimit('', 100), true);
  assert.equal(reachedLimit('abc', 100), true);
  assert.equal(reachedLimit(null, 99), false);
});

test('assignedPatch: 成功なら一覧を差し替えてエラーを消す', () => {
  const items = [{ id: 1 }];
  assert.deepEqual(
    assignedPatch({ status: 'fulfilled', value: { items, xTotal: '1' } }),
    { assigned: items, assignedLimited: false, assignedTotal: 1, assignedError: null },
  );
  const full = Array.from({ length: 100 }, (_, id) => ({ id }));
  assert.equal(assignedPatch({ status: 'fulfilled', value: { items: full, xTotal: '150' } }).assignedLimited, true);
});

test('assignedPatch: 総数は x-total、無ければ返ってきた件数', () => {
  const full = Array.from({ length: 100 }, (_, id) => ({ id }));
  assert.equal(assignedPatch({ status: 'fulfilled', value: { items: full, xTotal: '150' } }).assignedTotal, 150);
  assert.equal(assignedPatch({ status: 'fulfilled', value: { items: full, xTotal: null } }).assignedTotal, 100);
  assert.equal(assignedPatch({ status: 'fulfilled', value: { items: full, xTotal: 'abc' } }).assignedTotal, 100);
});

test('assignedPatch: 失敗なら前回の一覧に触らず、部分的な失敗だと分かる文言を返す', () => {
  const failed = { status: 'rejected', reason: new Error('HTTP 500') };
  assert.deepEqual(assignedPatch(failed), { assignedError: '作業アイテムの取得に失敗: HTTP 500（To-Do は更新しました）' });
  assert.deepEqual(assignedPatch(failed, 'en'),
    { assignedError: 'Could not fetch work items: HTTP 500 (To-Dos are up to date)' });
});

test('assignedPatch: バッジの件数（count）を決して変えない', () => {
  const ok = assignedPatch({ status: 'fulfilled', value: { items: [{ id: 1 }], xTotal: '1' } });
  const ng = assignedPatch({ status: 'rejected', reason: new Error('x') });
  assert.ok(!('count' in ok));
  assert.ok(!('count' in ng));
});

test('todoRef: MR は !、WorkItem を含むそれ以外は #', () => {
  assert.equal(todoRef({ target_type: 'MergeRequest', target: { iid: 3 } }), '!3');
  assert.equal(todoRef({ target_type: 'Issue', target: { iid: 3 } }), '#3');
  assert.equal(todoRef({ target_type: 'WorkItem', target: { iid: 3 } }), '#3');
  assert.equal(todoRef({ target_type: 'Commit', target: {} }), '');
  assert.equal(todoRef({ target_type: 'Issue' }), '');
});

// ---------- 翻訳 ----------
test('tr: 言語で切り替わり、{n} を差し込む', () => {
  assert.equal(tr('ja', 'tabList'), 'To-Do');
  assert.equal(tr('en', 'tabList'), 'To-Do');
  assert.equal(tr('ja', 'statusCount', { n: 4 }), '4 件');
  assert.equal(tr('en', 'statusCount', { n: 4 }), '4 to-dos');
  assert.equal(tr('en', 'assignedTabOver', { n: 3, m: 1 }), 'Work items 3 (1 overdue)');
  assert.equal(tr('ja', 'assignedLimit', { n: 100 }), '100 件まで表示');
  assert.equal(tr('en', 'assignedLimit', { n: 100 }), 'Showing the first 100');
});

test('tr: 未知の lang は日本語、未知の key はそのまま返す', () => {
  assert.equal(tr('fr', 'tabAssigned'), '作業アイテム');
  assert.equal(tr('en', 'shikatanai_key'), 'shikatanai_key');
});

test('tr: 差し込み変数が無くても壊れない', () => {
  assert.equal(tr('en', 'emptyTodos'), 'No To-Dos');
});

test('actionLabel: GitLab の action_name をラベルにする', () => {
  assert.equal(actionLabel('ja', 'review_requested'), 'レビュー依頼');
  assert.equal(actionLabel('en', 'review_requested'), 'Review requested');
  assert.equal(actionLabel('ja', 'build_failed'), 'CI失敗');
  assert.equal(actionLabel('en', 'build_failed'), 'CI failed');
});

test('actionLabel: 未知の action は GitLab の生の値を返す', () => {
  assert.equal(actionLabel('en', 'future_action'), 'future_action');
});

test('翻訳: ja と en でキーが揃っている', () => {
  assert.deepEqual(Object.keys(UI.en).sort(), Object.keys(UI.ja).sort());
  assert.deepEqual(Object.keys(ACTIONS.en).sort(), Object.keys(ACTIONS.ja).sort());
});

test('翻訳: 差し込み変数が ja/en で揃っている', () => {
  const vars = s => (s.match(/\{\w+\}/g) ?? []).sort().join(',');
  for (const key of Object.keys(UI.ja)) {
    assert.equal(vars(UI.en[key]), vars(UI.ja[key]), `key=${key}`);
  }
});

test('翻訳: 空文字の訳がない', () => {
  for (const lang of LANGS) {
    for (const [key, value] of Object.entries(UI[lang])) {
      assert.ok(String(value).length > 0, `${lang}.${key} が空`);
    }
  }
});

test('TYPES: target_type の略称', () => {
  assert.equal(TYPES.MergeRequest, 'MR');
  assert.equal(TYPES.Issue, 'Issue');
  assert.equal(TYPES.WorkItem, 'Work item');
  assert.equal(TYPES.Epic, 'Epic');
});

// ---------- 言語設定が見つけられるか ----------
test('言語セレクトは日英どちらの表記も持つ', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
  assert.match(html, /<option value="ja">日本語 \(Japanese\)<\/option>/);
  assert.match(html, /<option value="en">English \(英語\)<\/option>/);
});

test('言語のラベルはどちらの言語でも探せる', () => {
  assert.ok(tr('ja', 'lblLang').includes('Language'), tr('ja', 'lblLang'));
  assert.ok(tr('en', 'lblLang').includes('表示言語'), tr('en', 'lblLang'));
});

// ---------- README ----------
// GitHub のアンカー生成（小文字化 → 記号除去 → 空白ごとにハイフン）を再現する。
// github-slugger は空白を 1 つずつハイフンに置き換えるので、連続空白を潰さないこと。
const slug = (s) =>
  s.trim().toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').replace(/ /g, '-');

test('README の目次は全て実際の見出しに解決できる', () => {
  const md = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const headings = new Set(
    [...md.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1]))
  );
  const toc = md.slice(md.indexOf('## 目次'), md.indexOf('## できること'));
  const links = [...toc.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]);
  assert.ok(links.length >= 5, `目次にリンクが無い (${links.length})`);
  for (const l of links) assert.ok(headings.has(l), `対応する見出しが無い: #${l}`);
});

test('README の内部リンクが存在する見出しを指している', () => {
  const md = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const headings = new Set(
    [...md.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1]))
  );
  for (const m of md.matchAll(/\]\(#([^)]+)\)/g)) {
    assert.ok(headings.has(m[1]), `存在しない見出し: #${m[1]}`);
  }
});
