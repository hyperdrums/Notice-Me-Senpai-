const $ = s => document.querySelector(s);

// ago / dueInfo / todoRepo / issueRepo / shortName / tr / actionLabel は lib.js にある（Node でテストできる）
let lang = 'ja';
let current = { todos: [], issues: [], count: 0 };
// 選択中のフィルタ（'all' = すべて）
const filter = { action: 'all', todoRepo: 'all', dueRepo: 'all' };

// ---------- タブ ----------
const VIEWS = ['list', 'due', 'settings'];
document.querySelectorAll('.tab').forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
    for (const v of VIEWS) $(`#${v}`).classList.toggle('hidden', tab.dataset.view !== v);
  };
});

// ---------- 言語 ----------
// HTML 側に置いた固定文言を data-i18n で置き換える
function applyI18n() {
  document.documentElement.lang = lang === 'en' ? 'en' : 'ja';
  document.title = tr(lang, 'appTitle');
  for (const e of document.querySelectorAll('[data-i18n]')) e.textContent = tr(lang, e.dataset.i18n);
}

// ---------- 共通 ----------
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// 選択肢を並べ、クリックで filter[key] を切り替える。消えた選択肢は 'all' に戻す
function renderChips(container, key, entries, labelOf = v => v, titleOf = () => '') {
  if (filter[key] !== 'all' && !entries.has(filter[key])) filter[key] = 'all';
  container.replaceChildren();
  if (entries.size === 0) return;
  const total = [...entries.values()].reduce((a, b) => a + b, 0);
  for (const [value, n] of [['all', total], ...entries]) {
    const label = value === 'all' ? tr(lang, 'all') : labelOf(value);
    const c = el('span', `chip${filter[key] === value ? ' active' : ''}`, `${label} ${n}`);
    c.title = value === 'all' ? '' : titleOf(value);
    c.onclick = () => { filter[key] = value; render(current); };
    container.append(c);
  }
}

function countBy(items, keyOf) {
  const m = new Map();
  for (const it of items) m.set(keyOf(it), (m.get(keyOf(it)) ?? 0) + 1);
  return m;
}

// ---------- 通知タブ ----------
function renderTodos(todos, error) {
  renderChips($('#todoRepos'), 'todoRepo', countBy(todos, t => todoRepo(t, lang)), shortName, p => p);
  const inRepo = todos.filter(t => filter.todoRepo === 'all' || todoRepo(t, lang) === filter.todoRepo);
  const actionOf = t => actionLabel(lang, t.action_name);
  renderChips($('#actions'), 'action', countBy(inRepo, actionOf));
  const shown = inRepo.filter(t => filter.action === 'all' || actionOf(t) === filter.action);

  const ul = $('#todos');
  ul.replaceChildren();
  if (!shown.length && !error) ul.append(el('li', 'empty', tr(lang, 'emptyTodos')));
  for (const t of shown) {
    const li = el('li');
    const main = el('div', 'main');
    const title = el('div', 'title');
    title.append(el('span', 'tag', actionOf(t)));
    const ref = t.target?.iid != null ? ` ${t.target_type === 'MergeRequest' ? '!' : '#'}${t.target.iid}` : '';
    title.append(`${TYPES[t.target_type] ?? t.target_type}${ref} ${t.target?.title ?? ''}`);
    const meta = el('div', 'meta');
    // アサインは期限を表示（Issue の期限、なければマイルストーンの期限）
    if (t.action_name === 'assigned') {
      const due = dueInfoOr(t, lang);
      if (due) meta.append(el('span', due.cls, due.text), ' · ');
    }
    meta.append(`${t.project?.name_with_namespace ?? t.group?.full_name ?? ''} · ${t.author?.name ?? ''} · ${ago(t.created_at, { lang })}`);
    main.append(title, meta);
    if (t.body) main.append(el('div', 'body', t.body));
    const btn = el('button', null, tr(lang, 'done'));
    btn.title = lang === 'en' ? 'Mark this To-Do as done on GitLab' : 'GitLab 上で To-Do を完了にする';
    btn.onclick = e => { e.stopPropagation(); btn.disabled = true; window.api.done(t.id); };
    li.append(main, btn);
    li.onclick = () => window.api.open(t.target_url);
    ul.append(li);
  }
}

// To-Do の期限。Issue の期限がなければマイルストーンを見る
function dueInfoOr(t, lang) {
  if (t.target?.due_date) return dueInfo(t.target.due_date, { lang });
  if (t.target?.milestone?.due_date) return dueInfo(t.target.milestone.due_date, { prefix: tr(lang, 'msDuePrefix'), lang });
  return null;
}

// ---------- 期限タブ ----------
function renderIssues(issues, error) {
  renderChips($('#dueRepos'), 'dueRepo', countBy(issues, issueRepo), shortName, p => p);
  const shown = issues.filter(i => filter.dueRepo === 'all' || issueRepo(i) === filter.dueRepo);
  const over = issues.filter(i => dueInfo(i.due_date, { lang }).cls.includes('over')).length;
  $('#dueTab').textContent = issues.length
    ? (over ? tr(lang, 'dueTabOver', { n: issues.length, m: over }) : tr(lang, 'dueTab', { n: issues.length }))
    : tr(lang, 'tabDue');

  const ul = $('#issues');
  ul.replaceChildren();
  if (!shown.length && !error) ul.append(el('li', 'empty', tr(lang, 'emptyIssues')));
  for (const i of shown) {
    const li = el('li');
    const main = el('div', 'main');
    const due = dueInfo(i.due_date, { lang });
    main.append(
      el('div', 'title', `#${i.iid} ${i.title}`),
      el('div', 'meta'),
    );
    main.lastChild.append(el('span', due.cls, due.text), ` · ${issueRepo(i)}${i.labels?.length ? ` · ${i.labels.join(', ')}` : ''}`);
    li.append(main);
    li.onclick = () => window.api.open(i.web_url);
    ul.append(li);
  }
}

function render(s) {
  current = s;
  $('#error').style.display = s.error ? 'block' : 'none';
  $('#error').textContent = s.error ?? '';
  $('#status').textContent = s.loading ? tr(lang, 'loading')
    : s.updatedAt ? `${tr(lang, 'statusCount', { n: s.count })} / ${new Date(s.updatedAt).toLocaleTimeString()}` : '';
  renderTodos(s.todos, s.error);
  renderIssues(s.issues ?? [], s.error);
  drawBadge(s.count);
}

// ---------- バッジ描画（タスクバーのオーバーレイ & トレイ） ----------
function drawBadge(count) {
  const label = count > 99 ? '99+' : String(count);

  const o = document.createElement('canvas');
  o.width = o.height = 16;
  let g = o.getContext('2d');
  g.fillStyle = '#d93025';
  g.beginPath(); g.arc(8, 8, 8, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#fff';
  g.font = `bold ${label.length > 2 ? 7 : label.length > 1 ? 9 : 11}px Segoe UI`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(label, 8, 8.5);

  const t = document.createElement('canvas');
  t.width = t.height = 32;
  g = t.getContext('2d');
  g.fillStyle = count > 0 ? '#e24329' : '#888';
  g.beginPath(); g.arc(16, 16, 15, 0, Math.PI * 2); g.fill();
  if (count > 0) {
    g.fillStyle = '#fff';
    g.font = `bold ${label.length > 2 ? 13 : label.length > 1 ? 17 : 21}px Segoe UI`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(label, 16, 17);
  }

  window.api.setBadge({ overlay: o.toDataURL(), trayIcon: t.toDataURL(), count });
}

// ---------- 設定 ----------
async function loadForm() {
  const c = await window.api.getConfig();
  const next = LANGS.includes(c.lang) ? c.lang : 'ja';
  const changed = next !== lang;
  lang = next;
  if (changed) { applyI18n(); render(current); }   // 言語が変わったら画面を作り直す
  const f = $('#form');
  f.baseUrl.value = c.baseUrl;
  f.intervalSec.value = c.intervalSec;
  f.notify.checked = c.notify;
  f.autoStart.checked = c.autoStart;
  f.insecure.checked = c.insecure;
  f.elements.lang.value = lang;
  f.token.placeholder = c.hasToken ? tr(lang, 'tokenSaved') : tr(lang, 'tokenNew');
  if (!c.baseUrl || !c.hasToken) document.querySelector('.tab[data-view=settings]').click();
}

$('#form').onsubmit = async e => {
  e.preventDefault();
  const f = e.target;
  await window.api.saveConfig({
    baseUrl: f.baseUrl.value,
    token: f.token.value,
    intervalSec: f.intervalSec.value,
    notify: f.notify.checked,
    autoStart: f.autoStart.checked,
    insecure: f.insecure.checked,
    lang: f.elements.lang.value,
  });
  f.token.value = '';
  $('#saved').textContent = tr(lang, 'saved');
  setTimeout(() => ($('#saved').textContent = ''), 2000);
  loadForm();
};

$('#refresh').onclick = () => window.api.refresh();
window.api.onState(render);
window.api.getState().then(render);
applyI18n();
loadForm();
