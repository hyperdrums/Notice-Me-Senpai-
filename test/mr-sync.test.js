const { test } = require('node:test');
const assert = require('node:assert/strict');
const { newMrCache, rememberIssues, mrView, syncMrProject } = require('../src/mr-sync.js');

const t0 = Date.parse('2026-11-20T00:00:00Z');
const iso = t => new Date(t).toISOString();
const issue = { project_id: 1, iid: 17, title: 'Issue', web_url: 'https://example.test/a/-/issues/17' };
const buildMr = (iid, state, createdAt, updatedAt = createdAt) => ({ id: 1000 + iid, project_id: 1, iid, state,
  title: `MR ${iid}`, web_url: `https://example.test/a/-/merge_requests/${iid}`, created_at: iso(createdAt), updated_at: iso(updatedAt) });

function gitLab(initial = []) {
  const requests = [];
  const stub = { requests, rows: initial, failLookup: null };
  stub.get = async endpoint => {
    const { pathname, searchParams } = new URL(endpoint, 'https://example.test');
    requests.push({ pathname, params: Object.fromEntries(searchParams) });
    const lookup = pathname.match(/\/(\d+)\/closes_issues$/);
    if (Number(lookup?.[1]) === stub.failLookup) throw new Error('lookup failed');
    if (lookup) return { rows: [{ ...issue, project_id: 2 }, issue], nextPage: '' };
    const page = Number(searchParams.get('page'));
    const rows = stub.rows.filter(row => row.updated_at >= searchParams.get('updated_after') && row.updated_at <= searchParams.get('updated_before'));
    return { rows: rows.slice(page - 1, page), nextPage: page < rows.length ? page + 1 : '' };
  };
  return stub;
}

test('MR delta: backfill is silent, overlapping pages do not recheck unchanged MRs', async () => {
  const cache = newMrCache();
  const stub = gitLab([buildMr(1, 'opened', t0 - 1000), buildMr(2, 'merged', t0 - 100)]);
  assert.deepEqual(rememberIssues(cache, [issue], t0), [1]);
  await syncMrProject(cache, 1, t0, stub.get);
  assert.deepEqual(mrView(cache).relatedMrsByIssue['1:17'].map(mr => mr.iid), [2, 1]);
  assert.deepEqual(stub.requests.filter(r => !r.pathname.endsWith('closes_issues')).map(r => r.params.page), ['1', '2']);
  assert.equal(stub.requests[0].params.state, 'all');
  assert.equal(stub.requests[0].params.updated_before, iso(t0));
  assert.equal(stub.requests[0].params.updated_after, iso(t0 - 7 * 86400000));
  await syncMrProject(cache, 1, t0 + 1000, stub.get);
  assert.equal(stub.requests.filter(r => r.pathname.endsWith('closes_issues')).length, 2);
  assert.equal(cache.projects[1], t0 + 1000);
});

test('MR delta: state changes update the related MR without an event history', async () => {
  const cache = newMrCache();
  const stub = gitLab();
  rememberIssues(cache, [issue], t0);
  await syncMrProject(cache, 1, t0, stub.get);
  for (const [i, state] of ['opened', 'closed', 'opened', 'merged'].entries()) {
    const now = t0 + (i + 1) * 1000;
    stub.rows = [buildMr(42, state, t0 + 1000, now)];
    assert.deepEqual(rememberIssues(cache, state === 'merged' ? [] : [issue], now), [1]);
    await syncMrProject(cache, 1, now, stub.get);
  }
  assert.ok(!('recentMrUpdates' in mrView(cache)));
  assert.ok(!('history' in cache));
  assert.equal(mrView(cache).relatedMrsByIssue['1:17'][0].state, 'merged');
});

test('MR delta: failed relation leaves cursor intact and completed work deduplicated on retry', async () => {
  const cache = newMrCache();
  const stub = gitLab();
  rememberIssues(cache, [issue], t0);
  await syncMrProject(cache, 1, t0, stub.get);
  stub.rows = [buildMr(1, 'opened', t0 + 1000), buildMr(2, 'opened', t0 + 2000)];
  stub.failLookup = 2;
  await assert.rejects(syncMrProject(cache, 1, t0 + 3000, stub.get), /lookup failed/);
  assert.equal(cache.projects[1], t0);
  stub.failLookup = null;
  await syncMrProject(cache, 1, t0 + 4000, stub.get);
  assert.equal(stub.requests.filter(r => r.pathname.endsWith('/1/closes_issues')).length, 1);
  assert.deepEqual(mrView(cache).relatedMrsByIssue['1:17'].map(mr => mr.iid), [2, 1]);
});

test('MR delta: no polling after remembered Issues expire', () => {
  const cache = newMrCache();
  rememberIssues(cache, [issue, { ...issue, project_id: 3, issue_type: 'task' }], t0);
  assert.deepEqual(rememberIssues(cache, [], t0 + 15 * 86400000), []);
});
