const { test } = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('../scripts/mock-gitlab.js');
const { apiUrl } = require('../src/lib.js');
const { fetchTodos } = require('../src/todos.js');

const fixtures = count => Array.from({ length: count }, (_, index) => ({ id: index + 1, state: 'pending' }));

async function mockTodos(t, count) {
  const mock = await start({ quiet: true });
  t.after(() => mock.close());
  mock.state.todos = fixtures(count).reverse();
  const requests = [];
  async function poll(previous) {
    requests.length = 0;
    return fetchTodos(mock.url, async (path, { etag }) => {
      const url = new URL(apiUrl(mock.url, path));
      const headers = { 'PRIVATE-TOKEN': mock.token };
      if (etag) headers['If-None-Match'] = etag;
      const res = await fetch(url, { headers });
      const xTotal = res.headers.get('x-total');
      requests.push({ page: Number(url.searchParams.get('page')), status: res.status, xTotal,
        totalPages: res.headers.get('x-total-pages') });
      if (res.status === 304) return { status: 304, xTotal };
      assert.equal(res.status, 200);
      return { status: res.status, body: await res.json(), etag: res.headers.get('etag'), xTotal };
    }, previous);
  }
  return { mock, requests, poll };
}

test('To-Do: 150 件を 2 ページで取得し、304 のときに結合配列を再利用する', async t => {
  const { mock, requests, poll } = await mockTodos(t, 150);
  const first = await poll();
  assert.deepEqual(requests, [
    { page: 1, status: 200, xTotal: '150', totalPages: '2' },
    { page: 2, status: 200, xTotal: '150', totalPages: '2' },
  ]);
  assert.deepEqual(first.todos, fixtures(150));
  assert.equal(first.count, 150);
  assert.equal(first.changed, true);

  const second = await poll(first);
  assert.deepEqual(requests, [
    { page: 1, status: 304, xTotal: null, totalPages: null },
    { page: 2, status: 304, xTotal: null, totalPages: null },
  ]);
  assert.equal(second.count, 150);
  assert.equal(second.changed, false);
  assert.strictEqual(second.todos, first.todos);

  const added = await mock.push();
  const third = await poll(second);
  assert.deepEqual(requests.map(({ page, status }) => [page, status]), [[1, 304], [2, 200]]);
  assert.equal(third.count, 151);
  assert.equal(third.changed, true);
  assert.notStrictEqual(third.todos, second.todos);
  assert.deepEqual(third.todos, [...second.todos, added]);

  const fourth = await poll(third);
  assert.deepEqual(requests.map(({ status }) => status), [304, 304]);
  assert.equal(fourth.count, 151);
  assert.equal(fourth.changed, false);
  assert.strictEqual(fourth.todos, third.todos);

  await poll();
  assert.deepEqual(requests.map(({ status }) => status), [200, 200]);
});

test('To-Do: 総数が 500 件を超えても 5 ページで打ち切る', async t => {
  const { requests, poll } = await mockTodos(t, 501);
  const result = await poll();
  assert.deepEqual(requests.map(({ page }) => page), [1, 2, 3, 4, 5]);
  assert.equal(requests[4].totalPages, '6');
  assert.equal(result.count, 501);
  assert.deepEqual(result.todos, fixtures(500));
});

test('To-Do: x-total が無ければ短いページで止まり、結合長を件数にする', async () => {
  const rows = fixtures(150);
  const pages = [];
  const get = async path => {
    const page = Number(new URLSearchParams(path.split('?')[1]).get('page'));
    pages.push(page);
    return { status: 200, body: rows.slice((page - 1) * 100, page * 100), etag: '"same"' };
  };
  const first = await fetchTodos('https://gitlab.test', get);
  const second = await fetchTodos('https://gitlab.test', get, first);
  assert.deepEqual(pages, [1, 2, 1, 2]);
  assert.equal(second.count, 150);
  assert.equal(second.changed, false);
  assert.notStrictEqual(second.todos, first.todos);
});

test('To-Do: 100 件ちょうどでも翌 poll の 304 を使い、追加時に次のページを読む', async t => {
  const { mock, requests, poll } = await mockTodos(t, 100);
  const first = await poll();
  assert.deepEqual(requests.map(({ page }) => page), [1]);
  const second = await poll(first);
  assert.deepEqual(requests.map(({ status }) => status), [304]);
  assert.strictEqual(second.todos, first.todos);

  await mock.push();
  const third = await poll(second);
  assert.deepEqual(requests.map(({ page, status }) => [page, status]), [[1, 304], [2, 200]]);
  assert.equal(third.count, 101);
  assert.equal(third.todos.length, 101);
});
