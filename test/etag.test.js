const { test } = require('node:test');
const assert = require('node:assert/strict');
const { newEtagStore, fetchWithEtag, invalidate, clearEtags } = require('../src/etag.js');

const key = 'https://gitlab.test/api/v4/todos?state=pending&per_page=100';

test('ETag: 初回は ETag 無しで取り、2 回目は If-None-Match を付ける', async () => {
  const store = newEtagStore();
  const seen = [];
  const makeGet = (body, etag = 'W/"1"') => async ({ etag: sent }) => {
    seen.push(sent);
    if (sent === etag) return { status: 304 };
    return { ok: true, status: 200, etag, body };
  };
  const get = makeGet([{ id: 1 }]);
  const first = await fetchWithEtag(store, key, get);
  assert.equal(first.status, 200);
  assert.equal(first.changed, true);
  const second = await fetchWithEtag(store, key, get);
  assert.equal(second.status, 304);
  assert.equal(second.changed, false);
  assert.deepEqual(second.body, [{ id: 1 }]);
  assert.deepEqual(seen, [undefined, 'W/"1"']);
});

test('ETag: 200 でも中身が変わらなければ changed: false', async () => {
  const store = newEtagStore();
  const res = await fetchWithEtag(store, key, async () => ({ ok: true, status: 200, etag: 'W/"1"', body: [{ id: 1 }] }));
  assert.equal(res.changed, true);   // 初回は「変わった」扱い（状態の初期化が必要なので）
  const again = await fetchWithEtag(store, key, async () => ({ ok: true, status: 200, etag: 'W/"2"', body: [{ id: 1 }] }));
  assert.equal(again.status, 200);
  assert.equal(again.changed, false);  // ETag は変わったが中身は同じ
  const changed = await fetchWithEtag(store, key, async () => ({ ok: true, status: 200, etag: 'W/"3"', body: [{ id: 1 }, { id: 2 }] }));
  assert.equal(changed.changed, true);
});

test('ETag: 304 は前回の x-total を使い、200 は x-total だけの変更も検出する', async () => {
  const store = newEtagStore();
  const get = async ({ etag }) => etag
    ? { status: 304 }
    : { status: 200, etag: 'W/"a"', body: [1, 2], xTotal: '2' };
  await fetchWithEtag(store, key, get);
  const again = await fetchWithEtag(store, key, get);
  assert.equal(again.status, 304);
  assert.equal(again.changed, false);
  assert.equal(again.xTotal, '2');
  const noTotal = await fetchWithEtag(store, key, async () => ({ status: 200, etag: 'W/"a"', body: [1, 2] }));
  assert.equal(noTotal.changed, true);
  assert.equal(noTotal.xTotal, null);
});

test('ETag: ETag ヘッダが無い応答は毎回フル取得（古いオンプレやプロキシ）', async () => {
  const store = newEtagStore();
  await fetchWithEtag(store, key, async () => ({ status: 200, etag: 'W/"1"', body: [1] }));
  const seen = [];
  const get = async ({ etag }) => { seen.push(etag); return { status: 200, body: [1] }; };
  await fetchWithEtag(store, key, get);
  await fetchWithEtag(store, key, get);
  assert.deepEqual(seen, ['W/"1"', undefined]);
  assert.deepEqual(store.entries, {});
});

test('ETag: invalidate 後は If-None-Match を送らない（done 後の偽 304 防止）', async () => {
  const store = newEtagStore();
  const get = async ({ etag }) => etag ? { status: 304 } : { ok: true, status: 200, etag: 'W/"1"', body: [1] };
  await fetchWithEtag(store, key, get);
  let finish;
  const inFlight = fetchWithEtag(store, key, () => new Promise(resolve => { finish = resolve; }));
  invalidate(store, key);
  finish({ status: 200, etag: 'W/"old"', body: [0] });
  await inFlight;
  const after = await fetchWithEtag(store, key, get);
  assert.equal(after.status, 200);
  assert.equal(after.changed, true);
});

test('ETag: clearEtags で接続まるごとのリセット', async () => {
  const store = newEtagStore();
  await fetchWithEtag(store, key, async () => ({ ok: true, status: 200, etag: 'W/"1"', body: [1] }));
  clearEtags(store);
  // 消えた後は If-None-Match 無しで取り直す
  let sent;
  await fetchWithEtag(store, key, async ({ etag }) => { sent = etag; return { ok: true, status: 200, etag: 'W/"2"', body: [1] }; });
  assert.equal(sent, undefined);
});

test('ETag: 304 に x-total が付いていれば新しい方を使い、変わっていれば changed', async () => {
  const store = newEtagStore();
  await fetchWithEtag(store, key, async () => ({ ok: true, status: 200, etag: 'W/"a"', body: [1, 2], xTotal: '2' }));
  const same = await fetchWithEtag(store, key, async () => ({ status: 304, xTotal: '2' }));
  assert.equal(same.changed, false);
  const grown = await fetchWithEtag(store, key, async () => ({ status: 304, xTotal: '3' }));
  assert.equal(grown.changed, true);
  assert.equal(grown.xTotal, '3');
  assert.deepEqual(grown.body, [1, 2]);
});

test('ETag: 304 なのにキャッシュが無い異常系は例外', async () => {
  const store = newEtagStore();
  await assert.rejects(fetchWithEtag(store, key, async () => ({ status: 304 })), /without a cached entry/);
});
