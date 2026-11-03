const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  LANGS, CONFIG_DEFAULTS, TYPES, UI, ACTIONS, tr, actionLabel,
  apiUrl, mergeConfig, intervalSec, freshTodos, todoRepo, issueRepo, shortName, dueInfo, ago,
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

// ---------- 翻訳 ----------
test('tr: 言語で切り替わり、{n} を差し込む', () => {
  assert.equal(tr('ja', 'tabList'), '通知');
  assert.equal(tr('en', 'tabList'), 'Notifications');
  assert.equal(tr('ja', 'statusCount', { n: 4 }), '4 件');
  assert.equal(tr('en', 'statusCount', { n: 4 }), '4 to-dos');
  assert.equal(tr('en', 'dueTabOver', { n: 3, m: 1 }), 'Due 3 (1 overdue)');
});

test('tr: 未知の lang は日本語、未知の key はそのまま返す', () => {
  assert.equal(tr('fr', 'tabList'), '通知');
  assert.equal(tr('en', 'shikatanai_key'), 'shikatanai_key');
});

test('tr: 差し込み変数が無くても壊れない', () => {
  assert.equal(tr('en', 'emptyTodos'), 'No notifications');
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
// GitHub のアンカー生成（小文字化 + 記号除去 + 空白→ハイフン）を真似る
const slug = (s) =>
  s.trim().toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').replace(/ +/g, '-');

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
