// 純粋な計算だけを集めたファイル。electron も document も知らない。
// main.js は require()、renderer.js は <script src="lib.js"> で読む。
// 変更してもよいのは「引数だけで結果が決まる」関数だけ。I/O はここに書かない。

const LANGS = ['ja', 'en'];
const CONFIG_DEFAULTS = { baseUrl: '', intervalSec: 60, notify: true, insecure: false, autoStart: false, lang: 'ja' };

// ---------- 表示文字列 ----------
// {name} の形 for 差し込み。翻訳が欠けていたら日本語に落ちる
const UI = {
  ja: {
    appTitle: 'Notice Me, Senpai!',
    tabList: '通知', tabAssigned: '担当', tabSettings: '設定', refresh: '更新',
    loading: '取得中…', statusCount: '{n} 件',
    emptyTodos: '通知はありません', emptyAssigned: 'アサインされた作業アイテムはありません',
    done: '完了', all: 'すべて', noneRepo: '(なし)',
    duePrefix: '期限', msDuePrefix: 'MS期限', dueToday: '今日まで', noDueDate: '期限なし',
    dueIn: 'あと{n}日', dueOver: '{n}日超過', assignedTab: '担当 {n}', assignedTabOver: '担当 {n} (超過{m})',
    assignedLimit: '{n} 件まで表示',
    agoNow: 'たった今', agoMin: '{n}分前', agoHour: '{n}時間前', agoDay: '{n}日前',
    lblBaseUrl: 'GitLab URL',
    lblToken: 'Personal Access Token（スコープ: read_api。完了操作もするなら api）',
    lblInterval: '取得間隔（秒, 最小15）', lblLang: '表示言語 / Language',
    chkNotify: '新着時にデスクトップ通知',
    chkAutoStart: 'Windows ログイン時に起動（最小化）',
    chkInsecure: '証明書エラーを無視（自己署名証明書のオンプレ用）',
    btnSave: '保存', saved: '保存しました',
    hintToken: 'トークンは Windows の DPAPI で暗号化して保存されます。',
    tokenSaved: '保存済み（変更時のみ入力）', tokenNew: 'glpat-xxxxxxxx',
    trayOpen: '開く', trayRefresh: '今すぐ更新', trayQuit: '終了', trayTooltip: 'NMS - 未読 {n} 件',
    notifNew: 'GitLab: 新着 {n} 件', notifFrom: 'GitLab: {name}',
    errNotConfigured: '未設定です。設定タブで URL とトークンを入力してください。',
    errInvalidToken: 'トークンが無効です (401)',
    errFetch: '取得失敗: {msg}', errDone: '完了処理に失敗: {msg}',
    errAssigned: '担当の取得に失敗: {msg}（通知は更新しました）', errBadResponse: '応答の形式が不正です', errTimeout: '応答がありません',
  },
  en: {
    appTitle: 'Notice Me, Senpai!',
    tabList: 'Notifications', tabAssigned: 'Assigned', tabSettings: 'Settings', refresh: 'Refresh',
    loading: 'Loading…', statusCount: '{n} to-dos',
    emptyTodos: 'No notifications', emptyAssigned: 'No work items assigned to you',
    done: 'Done', all: 'All', noneRepo: '(none)',
    duePrefix: 'Due', msDuePrefix: 'Milestone', dueToday: 'today', noDueDate: 'No due date',
    dueIn: 'in {n}d', dueOver: '{n}d overdue', assignedTab: 'Assigned {n}', assignedTabOver: 'Assigned {n} ({m} overdue)',
    assignedLimit: 'Showing the first {n}',
    agoNow: 'just now', agoMin: '{n}m ago', agoHour: '{n}h ago', agoDay: '{n}d ago',
    lblBaseUrl: 'GitLab URL',
    lblToken: 'Personal Access Token (scope: read_api; api if you use Done)',
    lblInterval: 'Polling interval (seconds, min 15)', lblLang: 'Language / 表示言語',
    chkNotify: 'Desktop notification on new items',
    chkAutoStart: 'Start on Windows sign-in (minimized)',
    chkInsecure: 'Ignore certificate errors (self-signed on-prem)',
    btnSave: 'Save', saved: 'Saved',
    hintToken: 'Tokens are stored encrypted with Windows DPAPI.',
    tokenSaved: 'Saved (type only to change)', tokenNew: 'glpat-xxxxxxxx',
    trayOpen: 'Open', trayRefresh: 'Refresh now', trayQuit: 'Quit', trayTooltip: 'NMS - {n} unread',
    notifNew: 'GitLab: {n} new', notifFrom: 'GitLab: {name}',
    errNotConfigured: 'Not configured. Set the URL and token in the Settings tab.',
    errInvalidToken: 'Invalid token (401)',
    errFetch: 'Fetch failed: {msg}', errDone: 'Could not mark as done: {msg}',
    errAssigned: 'Could not fetch assigned items: {msg} (To-Dos are up to date)', errBadResponse: 'Unexpected response format', errTimeout: 'No response',
  },
};

// GitLab の action_name のラベル
const ACTIONS = {
  ja: {
    assigned: 'アサイン', mentioned: 'メンション', directly_addressed: 'メンション',
    build_failed: 'CI失敗', marked: 'To-Do追加', approval_required: '承認依頼',
    unmergeable: 'マージ不可', merge_train_removed: 'マージトレイン除外',
    review_requested: 'レビュー依頼', member_access_requested: 'アクセス要求',
    review_submitted: 'レビュー完了',
  },
  en: {
    assigned: 'Assigned', mentioned: 'Mentioned', directly_addressed: 'Mentioned',
    build_failed: 'CI failed', marked: 'To-Do added', approval_required: 'Approval requested',
    unmergeable: 'Unmergeable', merge_train_removed: 'Out of merge train',
    review_requested: 'Review requested', member_access_requested: 'Access requested',
    review_submitted: 'Review submitted',
  },
};

const TYPES = { MergeRequest: 'MR', Issue: 'Issue', WorkItem: 'Work item', Commit: 'Commit', Epic: 'Epic', DesignManagement__Design: 'Design' };

// 担当タブの issue_type のラベル
const WORK_ITEM_TYPES = {
  ja: { issue: 'Issue', incident: 'インシデント', test_case: 'テストケース', task: 'タスク' },
  en: { issue: 'Issue', incident: 'Incident', test_case: 'Test case', task: 'Task' },
};

// 担当の取得件数の上限（per_page）
const ASSIGNED_LIMIT = 100;

// 担当の取得を待つ上限（ミリ秒）
const ASSIGNED_TIMEOUT_MS = 30000;

// 翻訳。lang が無ければ日本語、key が無ければ key をそのまま返す
function tr(lang, key, vars) {
  let s = UI[lang]?.[key] ?? UI.ja[key] ?? key;
  for (const name of Object.keys(vars ?? {})) s = s.split(`{${name}}`).join(String(vars[name]));
  return s;
}

// 未知の action_name は GitLab の生の値をそのまま出す
const actionLabel = (lang, name) => ACTIONS[lang]?.[name] ?? ACTIONS.ja[name] ?? name;

// ---------- 設定 ----------
// GitLab API の URL。baseUrl の末尾スラッシュを揃える
function apiUrl(baseUrl, p) {
  return `${String(baseUrl).replace(/\/+$/, '')}/api/v4${p}`;
}

// 保存する設定をマージする。トークンが空欄なら既存のものを維持する
function mergeConfig(prev, input) {
  return {
    ...prev,
    baseUrl: String(input.baseUrl || '').trim(),
    intervalSec: Number(input.intervalSec) || CONFIG_DEFAULTS.intervalSec,
    notify: !!input.notify,
    insecure: !!input.insecure,
    autoStart: !!input.autoStart,
    lang: LANGS.includes(input.lang) ? input.lang : prev.lang ?? CONFIG_DEFAULTS.lang,
    token: input.token ? String(input.token).trim() : prev.token,
  };
}

// ポーリング間隔（秒）。最小 15 秒
function intervalSec(value) {
  return Math.max(15, Number(value) || CONFIG_DEFAULTS.intervalSec);
}

// ---------- GitLab のデータ ----------
// 既知の ID（Set）に含まれない To-Do を返す。knownIds が null の初回は空
function freshTodos(knownIds, todos) {
  return knownIds ? todos.filter(t => !knownIds.has(t.id)) : [];
}

const todoRepo = (t, lang = 'ja') => t.project?.path_with_namespace ?? t.group?.full_path ?? tr(lang, 'noneRepo');
const issueRepo = i => i.references?.full?.replace(/[#!]\d+$/, '') ?? String(i.project_id);
const shortName = p => p.split('/').pop();

// To-Do の参照番号。MR だけ !、それ以外（WorkItem を含む）は #。iid が無ければ空
const todoRef = t => (t.target?.iid != null ? `${t.target_type === 'MergeRequest' ? '!' : '#'}${t.target.iid}` : '');

// issue_type が無ければ Issue として扱う
const workItemType = i => i.issue_type || 'issue';

// 未知の issue_type は GitLab の生の値をそのまま出す
const workItemTypeLabel = (lang, type) => WORK_ITEM_TYPES[lang]?.[type] ?? WORK_ITEM_TYPES.ja[type] ?? type;

// 期限ありを近い順に並べ、期限なしと分けて返す。渡した配列は書き換えない
function splitByDue(items) {
  const dated = items.filter(i => i.due_date).sort((a, b) => a.due_date.localeCompare(b.due_date));
  return { dated, undated: items.filter(i => !i.due_date) };
}

// 期限超過の件数。期限なしは超過に数えない（dueInfo に null を渡さないよう dated だけ見る）
function countOverdue(items, opts = {}) {
  return splitByDue(items).dated.filter(i => dueInfo(i.due_date, opts).cls.includes('over')).length;
}

// x-total ヘッダの値を数にする。無い・読めないときは null
const parseTotal = xTotal => (/^\d+$/.test(xTotal ?? '') ? Number(xTotal) : null);

// 上限に達したか。x-total が無い・読めないときは返ってきた件数で判断する
function reachedLimit(xTotal, n, limit = ASSIGNED_LIMIT) {
  const total = parseTotal(xTotal);
  return total !== null ? total > limit : n >= limit;
}

// 担当の取得結果（Promise.allSettled の 1 要素）→ state への差分。
// 失敗時は前回の一覧を残すため、assigned には触らない
function assignedPatch(result, lang = 'ja') {
  if (result.status === 'rejected') {
    return { assignedError: tr(lang, 'errAssigned', { msg: result.reason?.message ?? String(result.reason) }) };
  }
  const { items, xTotal } = result.value;
  return { assigned: items, assignedLimited: reachedLimit(xTotal, items.length), assignedTotal: parseTotal(xTotal) ?? items.length, assignedError: null };
}

// ---------- 表示用の文字列 ----------
// 担当タブのラベル。件数は全リポジトリの合計で、絞り込みの影響を受けない。
// total は上限で切られる前の総数（x-total）。超過数は取得できた分だけで数える
function assignedTabLabel(items, opts = {}) {
  const { lang = 'ja', total } = opts;
  if (!items.length) return tr(lang, 'tabAssigned');
  const over = countOverdue(items, opts);
  const n = total ?? items.length;
  return over
    ? tr(lang, 'assignedTabOver', { n, m: over })
    : tr(lang, 'assignedTab', { n });
}


// 'YYYY-MM-DD' → 表示文字列と色クラス（超過: 赤 / 3日以内: 橙）
// opts = { prefix, today, lang }。today は注入可能。既定は実行日のため、テストでは固定の日付を渡す
function dueInfo(date, opts = {}) {
  const { today = new Date(), lang = 'ja' } = opts;
  const prefix = opts.prefix ?? tr(lang, 'duePrefix');
  const base = new Date(today);
  base.setHours(0, 0, 0, 0);
  const d = new Date(`${date}T00:00:00`);
  const days = Math.round((d - base) / 86400000);
  const rest = days < 0 ? tr(lang, 'dueOver', { n: -days })
    : days === 0 ? tr(lang, 'dueToday')
      : tr(lang, 'dueIn', { n: days });
  return {
    text: `${prefix} ${d.getMonth() + 1}/${d.getDate()} (${rest})`,
    cls: `due${days < 0 ? ' over' : days <= 3 ? ' soon' : ''}`,
  };
}

// ISO 時刻 → 「たった今」「3時間前」などの経過表示
function ago(iso, opts = {}) {
  const { now = Date.now(), lang = 'ja' } = opts;
  const m = Math.floor((now - new Date(iso)) / 60000);
  if (m < 1) return tr(lang, 'agoNow');
  if (m < 60) return tr(lang, 'agoMin', { n: m });
  if (m < 1440) return tr(lang, 'agoHour', { n: Math.floor(m / 60) });
  return tr(lang, 'agoDay', { n: Math.floor(m / 1440) });
}

// ブラウザでは module が無いのでこの行は効かない。Node（テスト）だけ通る
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    LANGS, CONFIG_DEFAULTS, TYPES, UI, ACTIONS, WORK_ITEM_TYPES, ASSIGNED_LIMIT, ASSIGNED_TIMEOUT_MS, tr, actionLabel,
    apiUrl, mergeConfig, intervalSec, freshTodos, todoRepo, issueRepo, shortName, dueInfo, ago,
    todoRef, workItemType, workItemTypeLabel, splitByDue, countOverdue, reachedLimit, assignedPatch, assignedTabLabel,
  };
}
