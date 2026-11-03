const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  CONFIG_DEFAULTS, apiUrl, mergeConfig, intervalSec,
  freshTodos, todoRepo, issueRepo, shortName, dueInfo, ago,
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
  const d = dueInfo('2026-11-01', '期限', TODAY);
  assert.equal(d.cls, 'due over');
  assert.equal(d.text, '期限 11/1 (2日超過)');
});

test('dueInfo: 今日と3日以内は橙（soon）', () => {
  assert.equal(dueInfo('2026-11-03', '期限', TODAY).cls, 'due soon');
  assert.equal(dueInfo('2026-11-06', '期限', TODAY).cls, 'due soon');
  assert.equal(dueInfo('2026-11-03', '期限', TODAY).text, '期限 11/3 (今日まで)');
  assert.equal(dueInfo('2026-11-06', '期限', TODAY).text, '期限 11/6 (あと3日)');
});

test('dueInfo: 4日以降は色なし', () => {
  assert.equal(dueInfo('2026-11-07', '期限', TODAY).cls, 'due');
});

test('dueInfo: prefix を変えられる（マイルストーン期限）', () => {
  assert.equal(dueInfo('2026-11-10', 'MS期限', TODAY).text, 'MS期限 11/10 (あと7日)');
});

test('dueInfo: 渡した today を書き換えない', () => {
  const before = TODAY.getTime();
  dueInfo('2026-11-05', '期限', TODAY);
  assert.equal(TODAY.getTime(), before);
});

// ---------- ago ----------
const NOW = new Date('2026-11-03T12:00:00').getTime();
const minsAgo = m => ago(new Date(NOW - m * 60000).toISOString(), NOW);

test('ago: 経過時間の表示', () => {
  assert.equal(minsAgo(0), 'たった今');
  assert.equal(minsAgo(59), '59分前');
  assert.equal(minsAgo(60), '1時間前');
  assert.equal(minsAgo(180), '3時間前');
  assert.equal(minsAgo(1440), '1日前');
  assert.equal(minsAgo(2880), '2日前');
});

// ---------- リポジトリ名の抽出 ----------
test('todoRepo: プロジェクト → グループ → (なし) の順に落とす', () => {
  assert.equal(todoRepo({ project: { path_with_namespace: 'group/proj' } }), 'group/proj');
  assert.equal(todoRepo({ group: { full_path: 'group' } }), 'group');
  assert.equal(todoRepo({}), '(なし)');
});

test('issueRepo: references.full の末尾 #12 !34 を落とす', () => {
  assert.equal(issueRepo({ references: { full: 'group/proj!12' } }), 'group/proj');
  assert.equal(issueRepo({ references: { full: 'group/proj#7' } }), 'group/proj');
  assert.equal(issueRepo({ project_id: 7 }), '7');
});

test('shortName: 末尾の名前だけ残す', () => {
  assert.equal(shortName('group/sub/proj'), 'proj');
});
