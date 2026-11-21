// ETag による条件付きリクエスト（If-None-Match / 304）の純粋な部分。
// get は ({ etag }) => Promise<{ status, etag?, body?, xTotal? }> を注入する。
// GitLab は ETag を Redis で管理し、変わらなければ DB を叩かずに 304 を返す。
// https://docs.gitlab.com/development/polling/
//
// 注意: GitLab の ETag ミドルウェアはクエリパラメータを見ないため、
// キーは完全 URL で持つ。レスポンスに ETag が無ければ、ただのフル取得として扱う。

function newEtagStore() {
  return { entries: {}, requests: new Map() };
}

// 304 は本文も件数も前回値を使う。200 は件数ヘッダーの増減も変更として扱う。
async function fetchWithEtag(store, key, get) {
  const entry = store.entries[key];
  const request = {};
  store.requests.set(key, request);
  try {
    const res = await get({ etag: entry?.etag });
    if (res.status === 304) {
      if (!entry) throw new Error('ETag 304 without a cached entry');
      // 304 に x-total が付いていれば新しい方を使う（GitLab は通常再送しないが、付く実装でも件数を古くしない）
      const xTotal = res.xTotal ?? entry.xTotal;
      const changed = xTotal !== entry.xTotal;
      return { status: 304, changed, body: entry.body, xTotal };
    }
    if (res.status < 200 || res.status >= 300) return { status: res.status, changed: false };

    const xTotal = res.xTotal ?? null;
    const changed = !entry || entry.xTotal !== xTotal || JSON.stringify(entry.body) !== JSON.stringify(res.body);
    const body = changed ? res.body : entry.body;
    // 接続変更・完了処理・後続の取得で無効になった応答はキャッシュに戻さない。
    if (store.requests.get(key) === request) {
      if (res.etag) store.entries[key] = { etag: res.etag, body, xTotal };
      else delete store.entries[key];
    }
    return { status: res.status, changed, body, xTotal };
  } finally {
    if (store.requests.get(key) === request) store.requests.delete(key);
  }
}

// To-Do を完了するなど、サーバ側が確実に変わったときは該当キーを捨てる。
// 次回 poll はフル取得になり、偽 304（古い一覧が返る）を防ぐ。
function invalidate(store, key) {
  delete store.entries[key];
  store.requests.delete(key);
}

// baseUrl / token の変更など、接続まるごと捨てるときは全部消す
function clearEtags(store) {
  store.entries = {};
  store.requests.clear();
}

module.exports = { newEtagStore, fetchWithEtag, invalidate, clearEtags };
