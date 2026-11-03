// 純粋な計算だけを集めたファイル。electron も document も知らない。
// main.js は require()、renderer.js は <script src="lib.js"> で読む。
// 変更してもよいのは「引数だけで結果が決まる」関数だけ。I/O はここに書かない。

const CONFIG_DEFAULTS = { baseUrl: '', intervalSec: 60, notify: true, insecure: false, autoStart: false };

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

const todoRepo = t => t.project?.path_with_namespace ?? t.group?.full_path ?? '(なし)';
const issueRepo = i => i.references?.full?.replace(/[#!]\d+$/, '') ?? String(i.project_id);
const shortName = p => p.split('/').pop();

// ---------- 表示用の文字列 ----------
// 'YYYY-MM-DD' → 表示文字列と色クラス（超過: 赤 / 3日以内: 橙）
// today は注入可能。既定は実行日のため、テストでは固定の日付を渡す
function dueInfo(date, prefix = '期限', today = new Date()) {
  const base = new Date(today);
  base.setHours(0, 0, 0, 0);
  const d = new Date(`${date}T00:00:00`);
  const days = Math.round((d - base) / 86400000);
  const rest = days < 0 ? `${-days}日超過` : days === 0 ? '今日まで' : `あと${days}日`;
  return {
    text: `${prefix} ${d.getMonth() + 1}/${d.getDate()} (${rest})`,
    cls: `due${days < 0 ? ' over' : days <= 3 ? ' soon' : ''}`,
  };
}

// ISO 時刻 → 「たった今」「3時間前」などの経過表示
function ago(iso, now = Date.now()) {
  const m = Math.floor((now - new Date(iso)) / 60000);
  if (m < 1) return 'たった今';
  if (m < 60) return `${m}分前`;
  if (m < 1440) return `${Math.floor(m / 60)}時間前`;
  return `${Math.floor(m / 1440)}日前`;
}

// ブラウザでは module が無いのでこの行は効かない。Node（テスト）だけ通る
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CONFIG_DEFAULTS, apiUrl, mergeConfig, intervalSec,
    freshTodos, todoRepo, issueRepo, shortName, dueInfo, ago,
  };
}
