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
    tabList: '通知', tabDue: '期限', tabSettings: '設定', refresh: '更新',
    loading: '取得中…', statusCount: '{n} 件',
    emptyTodos: '通知はありません', emptyIssues: '期限付きのアサイン Issue はありません',
    done: '完了', all: 'すべて', noneRepo: '(なし)',
    duePrefix: '期限', msDuePrefix: 'MS期限', dueToday: '今日まで',
    dueIn: 'あと{n}日', dueOver: '{n}日超過', dueTab: '期限 {n}', dueTabOver: '期限 {n} (超過{m})',
    agoNow: 'たった今', agoMin: '{n}分前', agoHour: '{n}時間前', agoDay: '{n}日前',
    lblBaseUrl: 'GitLab URL',
    lblToken: 'Personal Access Token（スコープ: read_api。完了操作もするなら api）',
    lblInterval: '取得間隔（秒, 最小15）', lblLang: '表示言語',
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
  },
  en: {
    appTitle: 'Notice Me, Senpai!',
    tabList: 'Notifications', tabDue: 'Due', tabSettings: 'Settings', refresh: 'Refresh',
    loading: 'Loading…', statusCount: '{n} to-dos',
    emptyTodos: 'No notifications', emptyIssues: 'No assigned issues with a due date',
    done: 'Done', all: 'All', noneRepo: '(none)',
    duePrefix: 'Due', msDuePrefix: 'Milestone', dueToday: 'today',
    dueIn: 'in {n}d', dueOver: '{n}d overdue', dueTab: 'Due {n}', dueTabOver: 'Due {n} ({m} overdue)',
    agoNow: 'just now', agoMin: '{n}m ago', agoHour: '{n}h ago', agoDay: '{n}d ago',
    lblBaseUrl: 'GitLab URL',
    lblToken: 'Personal Access Token (scope: read_api; api if you use Done)',
    lblInterval: 'Polling interval (seconds, min 15)', lblLang: 'Language',
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

const TYPES = { MergeRequest: 'MR', Issue: 'Issue', Commit: 'Commit', Epic: 'Epic', DesignManagement__Design: 'Design' };

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

// ---------- 表示用の文字列 ----------
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
    LANGS, CONFIG_DEFAULTS, TYPES, UI, ACTIONS, tr, actionLabel,
    apiUrl, mergeConfig, intervalSec, freshTodos, todoRepo, issueRepo, shortName, dueInfo, ago,
  };
}
