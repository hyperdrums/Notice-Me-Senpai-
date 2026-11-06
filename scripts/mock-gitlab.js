// GitLab REST API のモック。GUI の手動確認と e2e テスト用（依存ゼロ）
//
//   単体で起動:  node scripts/mock-gitlab.js [port]
//   テストから:  const mock = require('./mock-gitlab.js'); await mock.start()
//
// /api/v4 以外はテスト用の制御口（__ で始まる）
//   /__fail?target=todos|issues&status=500  その API を失敗させる（status=0 で解除）
//   /__assigned-total?n=150                 /issues の x-total を上書きする（n=none で省く、n なしで解除）

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
    web_url: 'http://127.0.0.1/group/proj-a/-/issues/100',
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
      id: 104, action_name: 'assigned', target_type: 'Issue',
      target: { iid: 21, title: 'リリース手順の整理', due_date: null, milestone: { due_date: day(2) } },
      project: { id: 2, name_with_namespace: 'Other / Proj B', path_with_namespace: 'other/proj-b' },
      target_url: `${base}/other/proj-b/-/issues/21`,
      created_at: iso(30),
    }),
  ];
}

// GitLab と同じく期限が近い順、期限なしは末尾。#17 は issue_type の無い応答を再現する
function initialIssues() {
  return [
    makeIssue({ id: 217, iid: 17, title: 'タスクバーのバッジが二重に表示される', due_date: day(-2), labels: ['bug'], issue_type: undefined, references: { full: 'group/proj-a#17' } }),
    makeIssue({ id: 222, iid: 22, title: '設定画面のトークン欄にプレースホルダ', due_date: day(1), references: { full: 'group/proj-a#22' } }),
    makeIssue({ id: 225, iid: 25, title: '確認手順を書き出す', issue_type: 'task', due_date: day(3), references: { full: 'group/proj-a#25' } }),
    makeIssue({ id: 223, iid: 23, title: 'README にスクリーンショットを載せる', due_date: day(14), references: { full: 'other/proj-b#23' } }),
    makeIssue({ id: 224, iid: 24, title: '期限なしの Issue', due_date: null, references: { full: 'group/proj-a#24' } }),
    makeIssue({ id: 226, iid: 26, title: '期限なしのタスク', issue_type: 'task', due_date: null, references: { full: 'other/proj-b#26' } }),
    makeIssue({ id: 227, iid: 27, title: '期限なしのインシデント', issue_type: 'incident', due_date: null, references: { full: 'other/proj-c#27' } }),
  ];
}

const initialState = () => ({ issues: initialIssues(), done: [], pushed: 0, fail: { todos: 0, issues: 0 }, assignedTotal: null });

async function start({ port = 0, quiet = false } = {}) {
  const log = (...a) => { if (!quiet) console.log(...a); };
  const state = { todos: null, ...initialState() };

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

    if (p === '/api/v4/todos' && state.fail.todos) return send(state.fail.todos, { message: 'mock failure' });
    if (p === '/api/v4/issues' && state.fail.issues) return send(state.fail.issues, { message: 'mock failure' });

    if (p === '/api/v4/todos') {
      return send(200, state.todos, { 'x-total': String(state.todos.length) });
    }
    if (p === '/api/v4/issues') {
      const total = state.assignedTotal ?? String(state.issues.length);
      return send(200, state.issues, total === 'none' ? {} : { 'x-total': total });
    }
    const done = p.match(/^\/api\/v4\/todos\/(\d+)\/mark_as_done$/);
    if (done && req.method === 'POST') {
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
    close: () => new Promise(r => server.close(r)),
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
