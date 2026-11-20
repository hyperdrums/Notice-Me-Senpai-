// MR 一覧の差分をプロジェクト単位で追う。Issue ごとの問い合わせはしない。
const DAY = 86_400_000;
const BACKFILL = 7 * DAY;
const RETENTION = 14 * DAY;
const OVERLAP = 2 * 60_000;
const MAX_PAGES = 20;
const ISSUE_LIMIT = 1000;
const HISTORY_LIMIT = 30;
const validId = n => Number.isSafeInteger(n) && n > 0;
const validPair = row => validId(row?.project_id) && validId(row?.iid);
const keyOf = row => `${row.project_id}:${row.iid}`;
const asTime = value => typeof value === 'string' ? Date.parse(value) : NaN;
const issueSummary = ({ project_id, iid, title, web_url }) => ({ project_id, iid, title, web_url });
const mrSummary = ({ id, project_id, iid, title, web_url, state, draft, work_in_progress }) =>
  ({ id, project_id, iid, title, web_url, state, draft: draft ?? work_in_progress ?? false });

function newMrCache() {
  return { projects: {}, issues: {}, mrs: {}, history: [] };
}

function rememberIssues(cache, issues, now) {
  for (const row of issues) {
    if (!validPair(row) || (row.issue_type && row.issue_type !== 'issue')) continue;
    cache.issues[keyOf(row)] = { issue: issueSummary(row), seenAt: now };
  }
  const kept = Object.entries(cache.issues).filter(([, e]) => e.seenAt >= now - RETENTION)
    .sort((a, b) => b[1].seenAt - a[1].seenAt).slice(0, ISSUE_LIMIT);
  cache.issues = Object.fromEntries(kept);
  cache.history = cache.history.filter(e => asTime(e.at) >= now - RETENTION).slice(0, HISTORY_LIMIT);
  const projects = new Set(kept.map(([, e]) => String(e.issue.project_id)));
  for (const key of Object.keys(cache.projects)) if (!projects.has(key)) delete cache.projects[key];
  for (const [key, e] of Object.entries(cache.mrs)) {
    if (!projects.has(String(e.mr.project_id)) ||
        (e.updatedAt < now - BACKFILL - OVERLAP && !e.issueKeys.some(k => cache.issues[k]))) delete cache.mrs[key];
  }
  return [...projects].map(Number);
}

function mrView(cache) {
  const relatedMrsByIssue = {};
  for (const e of Object.values(cache.mrs)) {
    for (const key of e.issueKeys) {
      if (cache.issues[key]) (relatedMrsByIssue[key] ??= []).push(e.mr);
    }
  }
  for (const rows of Object.values(relatedMrsByIssue)) rows.sort((a, b) => b.iid - a.iid);
  return { relatedMrsByIssue, recentMrUpdates: cache.history };
}

async function* pages(get, path, params) {
  for (let page = 1, i = 0; i < MAX_PAGES; i++) {
    const query = new URLSearchParams({ ...params, per_page: '100', page: String(page) });
    const { rows, nextPage } = await get(`${path}?${query}`);
    if (!Array.isArray(rows)) throw new Error('Invalid GitLab list response');
    yield rows;
    const next = Number(nextPage);
    if (!Number.isSafeInteger(next) || next <= page) return;
    page = next;
  }
  throw new Error('GitLab MR pagination limit exceeded');
}

function eventTypes(previous, mr, createdAt, observedSince, upper) {
  const types = [];
  if (!previous && createdAt >= observedSince && createdAt <= upper) types.push('issued');
  if (previous?.mr.state !== mr.state) {
    if (mr.state === 'closed' || mr.state === 'merged') types.push(mr.state);
    else if (mr.state === 'opened' && previous) types.push('reopened');
  }
  return types;
}

// 完了したページの MR は記録するが、照合に失敗したら時刻カーソルは進めない。
// 次回は同じ窓を再読込し、既に照合した id / updated_at を再照合しない。
async function syncMrProject(cache, projectId, upper, get) {
  const previousUpper = cache.projects[projectId];
  const lower = Math.min(upper, previousUpper == null ? upper - BACKFILL : previousUpper - OVERLAP);
  const root = `/projects/${projectId}/merge_requests`;
  const params = { state: 'all', scope: 'all', updated_after: new Date(lower).toISOString(),
    updated_before: new Date(upper).toISOString(), order_by: 'updated_at', sort: 'asc' };
  for await (const rows of pages(get, root, params)) {
    for (const row of rows) {
      const updatedAt = asTime(row?.updated_at);
      if (!validPair(row) || row.project_id !== projectId || !validId(row.id) || !Number.isFinite(updatedAt)) {
        throw new Error('Invalid GitLab MR');
      }
      if (updatedAt > upper) continue;
      const key = keyOf(row);
      const previous = cache.mrs[key];
      if (previous?.updatedAt >= updatedAt) continue;
      const links = new Set();
      for await (const issues of pages(get, `${root}/${row.iid}/closes_issues`, {})) {
        for (const issue of issues) if (validPair(issue)) links.add(keyOf(issue));
      }
      const mr = mrSummary(row);
      const issueKeys = [...links];
      // 最初のバックフィルは現況のみ。既知の MR は観測した最終状態への変化を記録する。
      if (previousUpper != null) {
        for (const type of eventTypes(previous, mr, asTime(row.created_at), lower, upper)) {
          const at = type === 'issued' ? row.created_at : row.updated_at;
          for (const issueKey of issueKeys) {
            const issue = cache.issues[issueKey]?.issue;
            if (issue) cache.history.push({ issue, mr, type, at });
          }
        }
        cache.history.sort((a, b) => asTime(b.at) - asTime(a.at));
        cache.history.length = Math.min(cache.history.length, HISTORY_LIMIT);
      }
      cache.mrs[key] = { mr, updatedAt, issueKeys };
    }
  }
  cache.projects[projectId] = upper;
}

module.exports = { newMrCache, rememberIssues, mrView, syncMrProject };
