const { newEtagStore, fetchWithEtag } = require('./etag.js');
const { apiUrl } = require('./lib.js');

const PAGE_SIZE = 100;
const MAX_PAGES = 5;

async function fetchTodos(baseUrl, get, previous) {
  // 途中で失敗しても、次の poll は最後に反映したキャッシュから始める。
  const etagStore = newEtagStore();
  Object.assign(etagStore.entries, previous?.etagStore.entries);
  const pages = [];
  let total = previous?.total ?? null;
  let length = 0;
  let rebuild = false;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const path = `/todos?state=pending&per_page=${PAGE_SIZE}&order_by=id&sort=asc&page=${page}`;
    const result = await fetchWithEtag(etagStore, apiUrl(baseUrl, path), async options => {
      const res = await get(path, options);
      // 別ページの古い x-total で、今回受け取った総数を上書きしない。
      if (res.status !== 304 || res.xTotal != null) {
        total = res.xTotal == null ? null : Number(res.xTotal);
      }
      return res;
    });
    pages.push(result.body);
    length += result.body.length;
    rebuild ||= result.status !== 304;
    if (result.body.length < PAGE_SIZE || (total != null && length >= total)) break;
  }

  const count = Number.isFinite(total) ? total : length;
  const changed = !previous || count !== previous.count || pages.length !== previous.pages.length
    || pages.some((body, index) => body !== previous.pages[index]);
  const todos = changed || rebuild ? pages.flat() : previous.todos;
  return { todos, changed, count, total, pages, etagStore };
}

module.exports = { fetchTodos };
