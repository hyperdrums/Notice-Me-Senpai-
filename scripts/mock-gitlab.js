// GitLab REST API のモック。GUI の手動確認と e2e テスト用（依存ゼロ）
//
//   単体で起動:  node scripts/mock-gitlab.js [port]
//   テストから:  const mock = require('./mock-gitlab.js'); await mock.start()
//
// /api/v4 以外はテスト用の制御口（__ で始まる）
//   /__fail?target=todos|issues|done|mergeRequests|closesIssues&status=500  API を失敗させる（status=0 で解除）
//   /__mr-transition?event=issued|merged|closed|reopen-issue  MR と Issue の状態を進める
//   /__assigned-total?n=150                 /issues の x-total を上書きする（n=none で省く、n なしで解除）
//   /__assigned-count?n=150                 /issues の件数を期限なしで水増しする（n なしで解除）
//   /__hang-issues?on=1                     /issues に応答しない（on=0 で解除し、止めていた分にも応答する）

const http = require('node:http');

const TOKEN = 'glpat-mock-token';

const iso = minAgo => new Date(Date.now() - minAgo * 60000).toISOString();
const day = offset => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};

// GitLab の To-Do 1 件っぽい形
function makeTodo(o) {
  return {
    id: 0,
    project_id: 1,
    author: { id: 1, name: '田中 太郎', username: 'tanaka' },
    action_name: 'assigned',
    target_type: 'Issue',
    target: { iid: 1, title: '' },
    body: '',
    state: 'pending',
    created_at: iso(5),
    updated_at: iso(5),
    ...o,
  };
}

function makeIssue(o) {
  return {
    id: 100,
    iid: 100,
    project_id: 1,
    title: '',
    state: 'opened',
    issue_type: 'issue',
    labels: [],
    references: { full: 'group/proj-a#100' },
    web_url: `http://127.0.0.1/group/proj-a/-/issues/${o.iid ?? 100}`,
    ...o,
  };
}

// 初期データ: 期限切れ / 今日 / 4 日以降 / 期限なしを混ぜる
function initialTodos(base) {
  return [
    makeTodo({
      id: 101, action_name: 'review_requested', target_type: 'MergeRequest',
      target: { iid: 42, title: 'ログイン周りのリファクタリング' },
      project: { id: 1, name_with_namespace: 'Group / Proj A', path_with_namespace: 'group/proj-a' },
      target_url: `${base}/group/proj-a/-/merge_requests/42`,
      created_at: iso(0),
    }),
    makeTodo({
      id: 102, action_name: 'assigned', target_type: 'Issue',
      target: { iid: 17, title: 'タスクバーのバッジが二重に表示される', due_date: day(-2) },
      project: { id: 1, name_with_namespace: 'Group / Proj A', path_with_namespace: 'group/proj-a' },
      author: { id: 2, name: '佐藤 花子', username: 'sato' },
      body: 'Windows 11 で再現するという報告あり',
      target_url: `${base}/group/proj-a/-/issues/17`,
      created_at: iso(130),
    }),
    makeTodo({
      id: 103, action_name: 'mentioned', target_type: 'MergeRequest',
      target: { iid: 7, title: 'CI: electron-builder のキャッシュを最適化' },
      project: { id: 2, name_with_namespace: 'Other / Proj B', path_with_namespace: 'other/proj-b' },
      author: { id: 3, name: '鈴木 一郎', username: 'suzuki' },
      target_url: `${base}/other/proj-b/-/merge_requests/7`,
      created_at: iso(1500),
    }),
    makeTodo({
      id: 104, action_name: 'assigned', target_type: 'WorkItem',
      target: { iid: 21, title: 'リリース手順の整理', due_date: null, milestone: { due_date: day(2) } },
      project: { id: 2, name_with_namespace: 'Other / Proj B', path_with_namespace: 'other/proj-b' },
      target_url: `${base}/other/proj-b/-/issues/21`,
      created_at: iso(1560),
    }),
  ];
}

// GitLab と同じく期限が近い順、期限なしは末尾。#17 は issue_type の無い応答を再現する
function initialIssues(count = 0) {
  const issues = [
    makeIssue({ id: 217, iid: 17, title: 'タスクバーのバッジが二重に表示される', due_date: day(-2), labels: ['bug'], issue_type: undefined, references: { full: 'group/proj-a#17' } }),
    makeIssue({ id: 222, iid: 22, title: '設定画面のトークン欄にプレースホルダ', due_date: day(1), references: { full: 'group/proj-a#22' } }),
    makeIssue({ id: 225, iid: 25, title: '確認手順を書き出す', issue_type: 'task', due_date: day(3), references: { full: 'group/proj-a#25' } }),
    makeIssue({ id: 223, iid: 23, project_id: 2, title: 'README にスクリーンショットを載せる', due_date: day(14), references: { full: 'other/proj-b#23' }, web_url: 'http://127.0.0.1/other/proj-b/-/issues/23' }),
    makeIssue({ id: 224, iid: 24, title: '期限なしの Issue', due_date: null, references: { full: 'group/proj-a#24' } }),
    makeIssue({ id: 226, iid: 26, project_id: 2, title: '期限なしのタスク', issue_type: 'task', due_date: null, references: { full: 'other/proj-b#26' }, web_url: 'http://127.0.0.1/other/proj-b/-/issues/26' }),
    makeIssue({ id: 227, iid: 27, project_id: 3, title: '期限なしのインシデント', issue_type: 'incident', due_date: null, references: { full: 'other/proj-c#27' }, web_url: 'http://127.0.0.1/other/proj-c/-/issues/27' }),
  ];
  for (let iid = 1000; issues.length < count; iid++) issues.push(makeIssue({ id: iid, iid, title: `水増し ${iid}`, due_date: null }));
  return issues;
}

const mrFixture = (id, iid, project_id, path, title, closes, fields = {}) => ({
  closes,
  path,
  row: { id, iid, project_id, target_project_id: project_id, title, state: 'opened', draft: false,
    created_at: iso(120), updated_at: iso(60), ...fields },
});

const initialMrs = () => [
  mrFixture(342, 42, 1, 'group/proj-a', 'バッジの重複表示を修正する', [999, 217]),
  mrFixture(343, 43, 1, 'group/proj-a', '通知バッジの回帰テストを追加する', [217], { updated_at: iso(59) }),
  mrFixture(345, 45, 2, 'other/proj-b', 'README の画像を更新する', [223], { draft: true }),
  mrFixture(349, 49, 2, 'other/proj-b', '追跡範囲より古い MR', [223], { created_at: iso(12000), updated_at: iso(12000) }),
];

function advanceMrFixture(state, event) {
  // 同じイベントを繰り返しても時刻が逆転しない。GUI は前の同期を待ってから次に進む。
  const updated_at = new Date().toISOString();
  const mr = (project, iid) => state.mrs.find(({ row }) => row.project_id === project && row.iid === iid)?.row;
  const issue = state.issues.find(i => i.id === 217);
  if (event === 'issued' && !mr(1, 46)) {
    state.mrs.push(mrFixture(346, 46, 1, 'group/proj-a', 'バッジ更新の回帰テストを追加する', [217],
      { created_at: updated_at, updated_at }));
  } else if (event === 'merged' && mr(1, 42).state !== 'merged') {
    Object.assign(mr(1, 42), { state: 'merged', merged_at: updated_at, updated_at });
    if (issue) Object.assign(issue, { state: 'closed', closed_at: updated_at, updated_at });
  } else if (event === 'closed' && mr(2, 45).state !== 'closed') {
    Object.assign(mr(2, 45), { state: 'closed', closed_at: updated_at, updated_at });
  } else if (event === 'reopen-issue' && issue?.state === 'closed') {
    Object.assign(issue, { state: 'opened', closed_at: null, updated_at });
  } else return false;
  return true;
}

const initialState = () => ({
  issues: initialIssues(), mrs: initialMrs(), done: [], pushed: 0,
  fail: { todos: 0, issues: 0, done: 0, mergeRequests: 0, closesIssues: 0 },
  assignedTotal: null, hangIssues: false, issuesQuery: null,
  mrListRequests: [], closesIssueRequests: [], perIssueRequests: [],
  // ETag 検証（#20）: URL ごとの ETag と、If-None-Match が当たって 304 を返した回数
  etags: new Map(), etagOff: false, conditionalHits: 0, conditionalHitsByList: { todos: 0, issues: 0 },
});

async function start({ port = 0, quiet = false } = {}) {
  const log = (...a) => { if (!quiet) console.log(...a); };
  const state = { todos: null, ...initialState() };
  let etagSeq = 1;
  const held = []; // __hang-issues で止めている /issues の応答

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    const base = `http://127.0.0.1:${server.address().port}`;
    if (!state.todos) state.todos = initialTodos(base);

    const send = (code, body, headers = {}) => {
      const data = body === null ? '' : JSON.stringify(body);
      res.writeHead(code, { 'content-type': 'application/json', ...headers });
      res.end(data);
    };

    // ---- テスト用の制御口 ----
    if (p === '/__health') return send(200, { ok: true });
    if (p === '/__state') return send(200, state);
    if (p === '/__reset') { Object.assign(state, initialState(), { todos: initialTodos(base) }); return send(200, state); }
    if (p === '/__fail') {
      const target = url.searchParams.get('target');
      if (!(target in state.fail)) return send(400, { message: `mock: unknown target ${target}` });
      state.fail[target] = Number(url.searchParams.get('status')) || 0;
      return send(200, state.fail);
    }
    if (p === '/__assigned-total') {
      state.assignedTotal = url.searchParams.get('n');
      return send(200, { assignedTotal: state.assignedTotal });
    }
    if (p === '/__assigned-count') {
      state.issues = initialIssues(Number(url.searchParams.get('n')) || 0);
      return send(200, { count: state.issues.length });
    }
    if (p === '/__hang-issues') {
      state.hangIssues = url.searchParams.get('on') === '1';
      if (!state.hangIssues) held.splice(0).forEach(respond => respond());
      return send(200, { hangIssues: state.hangIssues });
    }
    if (p === '/__etag-off') {
      state.etagOff = true;
      return send(200, { etagOff: true });
    }
    if (p === '/__mr-transition') {
      const event = url.searchParams.get('event');
      return advanceMrFixture(state, event) ? send(200, { event }) : send(409, { message: `mock: cannot apply ${event}` });
    }
    if (p === '/__push') {
      state.pushed++;
      const t = makeTodo({
        id: 900 + state.pushed, action_name: 'mentioned', target_type: 'Issue',
        target: { iid: 90, title: `モックから押した新着 ${state.pushed}` },
        project: { id: 1, name_with_namespace: 'Group / Proj A', path_with_namespace: 'group/proj-a' },
        target_url: `${base}/group/proj-a/-/issues/90`,
        created_at: iso(0),
      });
      state.todos.unshift(t);
      return send(200, t);
    }

    // ---- GitLab API のふり ----
    if (req.headers['private-token'] !== TOKEN) return send(401, { message: '401 Unauthorized' });

    // 304 では通常 x-total を省く。To-Do はページ本文が同じまま総数が変わる場合もある。
    const sendList = (list, rows, headers) => {
      if (state.etagOff) return send(200, rows, headers);
      const body = JSON.stringify(rows);
      let entry = state.etags.get(req.url);
      if (entry?.body !== body) {
        entry = { body, etag: `W/"${etagSeq++}"`, total: headers['x-total'] };
        state.etags.set(req.url, entry);
      }
      if (req.headers['if-none-match'] === entry.etag) {
        state.conditionalHits++;
        state.conditionalHitsByList[list]++;
        const responseHeaders = { etag: entry.etag };
        if (list === 'todos' && entry.total !== headers['x-total']) {
          responseHeaders['x-total'] = headers['x-total'];
          responseHeaders['x-total-pages'] = headers['x-total-pages'];
        }
        res.writeHead(304, responseHeaders);
        return res.end();
      }
      return send(200, rows, { etag: entry.etag, ...headers });
    };

    if (p === '/api/v4/todos' && state.fail.todos) return send(state.fail.todos, { message: 'mock failure' });
    if (p === '/api/v4/issues' && state.fail.issues) return send(state.fail.issues, { message: 'mock failure' });

    if (p === '/api/v4/todos') {
      const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
      const perPage = Math.max(1, Number(url.searchParams.get('per_page')) || 20);
      const requestedState = url.searchParams.get('state');
      const rows = state.todos.filter(t => !requestedState || t.state === requestedState);
      if (url.searchParams.get('order_by') === 'id') {
        const direction = url.searchParams.get('sort') === 'asc' ? 1 : -1;
        rows.sort((a, b) => direction * (a.id - b.id));
      }
      return sendList('todos', rows.slice((page - 1) * perPage, page * perPage), {
        'x-total': String(rows.length),
        'x-total-pages': String(Math.ceil(rows.length / perPage)),
      });
    }
    if (p === '/api/v4/issues') {
      state.issuesQuery = Object.fromEntries(url.searchParams);
      // GitLab と同じく per_page で切る（既定 20）。x-total は切る前の総数
      const respond = () => {
        const requestedState = url.searchParams.get('state');
        const matches = state.issues.filter(i => !requestedState || requestedState === 'all' || requestedState === i.state);
        const total = state.assignedTotal ?? String(matches.length);
        const rows = matches.slice(0, Number(url.searchParams.get('per_page')) || 20);
        sendList('issues', rows, total === 'none' ? {} : { 'x-total': total });
      };
      if (state.hangIssues) { held.push(respond); return; }
      return respond();
    }
    const pageOf = rows => {
      // 小さいモックでも実際のページ送りを検証できるよう、上限を 1 件にする。
      const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
      return send(200, rows.slice(page - 1, page), {
        'x-next-page': page < rows.length ? String(page + 1) : '',
        'x-total': String(rows.length),
      });
    };
    const listMr = p.match(/^\/api\/v4\/projects\/(\d+)\/merge_requests$/);
    if (listMr && req.method === 'GET') {
      const projectId = Number(listMr[1]);
      const query = Object.fromEntries(url.searchParams);
      const after = Date.parse(query.updated_after);
      const before = Date.parse(query.updated_before);
      const rows = state.mrs.filter(({ row }) => row.project_id === projectId
        && (query.state === 'all' || row.state === query.state)
        && Date.parse(row.updated_at) >= after && Date.parse(row.updated_at) <= before)
        .sort((a, b) => a.row.updated_at.localeCompare(b.row.updated_at) || a.row.id - b.row.id)
        .map(({ row, path }) => ({ ...row, web_url: `${base}/${path}/-/merge_requests/${row.iid}` }));
      state.mrListRequests.push({ projectId, query, matched: rows.map(r => r.iid) });
      if (state.fail.mergeRequests) return send(state.fail.mergeRequests, { message: 'mock failure' });
      if (!Number.isFinite(after) || !Number.isFinite(before) || after > before) return send(400, { message: 'mock: invalid MR time range' });
      return pageOf(rows);
    }
    const closesIssues = p.match(/^\/api\/v4\/projects\/(\d+)\/merge_requests\/(\d+)\/closes_issues$/);
    if (closesIssues && req.method === 'GET') {
      const projectId = Number(closesIssues[1]);
      const iid = Number(closesIssues[2]);
      state.closesIssueRequests.push({ projectId, iid, page: Number(url.searchParams.get('page')) || 1 });
      if (state.fail.closesIssues) return send(state.fail.closesIssues, { message: 'mock failure' });
      const mr = state.mrs.find(({ row }) => row.project_id === projectId && row.iid === iid);
      if (!mr) return send(404, { message: 'mock: MR not found' });
      return pageOf(mr.closes.map(id => state.issues.find(i => i.id === id)
        ?? makeIssue({ id, iid: id, title: '自分の担当ではない Issue' })));
    }
    if (/^\/api\/v4\/projects\/\d+\/issues\/\d+(?:\/|$)/.test(p)) state.perIssueRequests.push(p);
    const done = p.match(/^\/api\/v4\/todos\/(\d+)\/mark_as_done$/);
    if (done && req.method === 'POST') {
      if (state.fail.done) return send(state.fail.done, { message: 'mock failure' });
      const id = Number(done[1]);
      const hit = state.todos.find(t => t.id === id);
      if (!hit) return send(404, { message: '404 Not Found' });
      state.todos = state.todos.filter(t => t.id !== id);
      state.done.push({ id, at: new Date().toISOString() });
      return send(204, null);
    }
    return send(404, { message: `mock: no route ${p}` });
  });

  await new Promise(r => server.listen(port, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  log(`mock GitLab: ${url}  token: ${TOKEN}`);

  return {
    url, token: TOKEN, server, state,
    push: () => fetch(`${url}/__push`).then(r => r.json()),
    snapshot: () => fetch(`${url}/__state`).then(r => r.json()),
    fail: (target, status) => fetch(`${url}/__fail?target=${target}&status=${status}`).then(r => r.json()),
    setAssignedTotal: n => fetch(`${url}/__assigned-total${n == null ? '' : `?n=${n}`}`).then(r => r.json()),
    setAssignedCount: n => fetch(`${url}/__assigned-count${n == null ? '' : `?n=${n}`}`).then(r => r.json()),
    hangIssues: on => fetch(`${url}/__hang-issues?on=${on ? 1 : 0}`).then(r => r.json()),
    etagOff: () => fetch(`${url}/__etag-off`).then(r => r.json()),
    transitionMr: async event => {
      const r = await fetch(`${url}/__mr-transition?event=${event}`);
      if (!r.ok) throw new Error(`MR fixture ${event}: HTTP ${r.status}`);
      return r.json();
    },
    close: () => new Promise(r => { server.close(r); server.closeAllConnections(); }),
  };
}

module.exports = { start, TOKEN };

if (require.main === module) {
  const port = Number(process.argv[2]) || 8080;
  start({ port, quiet: false }).then(m => {
    console.log('アプリの「設定」に次を入力してください。');
    console.log(`  GitLab URL : ${m.url}`);
    console.log(`  Token      : ${m.token}`);
    console.log('新着の通知を出したいときは別ターミナルで: curl -X POST ' + m.url + '/__push');
  });
}
