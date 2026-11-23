const $ = s => document.querySelector(s);

// ago / dueInfo / todoRepo / issueRepo / shortName / tr / actionLabel などは lib.js にある（Node でテストできる）
let lang = 'ja';
let current = { todos: [], assigned: [], count: 0 };
let settingsSaveError = null;
const pendingDoneIds = new Set();
// 選択中のフィルタ（'all' = すべて）
const filter = { action: 'all', todoRepo: 'all', assignedRepo: 'all', assignedType: 'all' };

// ---------- タブ ----------
const VIEWS = ['list', 'assigned', 'settings'];
const tabTrack = $('.tab-track');
const tabIndicator = tabTrack.querySelector('.tab-indicator');
const tabs = tabTrack.querySelectorAll('.tab');
function positionTabIndicator() {
  const active = tabTrack.querySelector('.tab.active');
  tabIndicator.style.transform = `translateX(${active.offsetLeft}px)`;
  tabIndicator.style.width = `${active.offsetWidth}px`;
}

tabs.forEach(tab => {
  tab.onclick = () => {
    tabs.forEach(t => t.classList.toggle('active', t === tab));
    for (const v of VIEWS) $(`#${v}`).classList.toggle('hidden', tab.dataset.view !== v);
    positionTabIndicator();
    scheduleChipConnectors();
  };
});

let tabResizeFrame = null;
window.addEventListener('resize', () => {
  if (tabResizeFrame !== null) return;
  tabResizeFrame = requestAnimationFrame(() => {
    tabResizeFrame = null;
    positionTabIndicator();
  });
});

// ---------- チップの接続線 ----------
const svgNS = 'http://www.w3.org/2000/svg';
const chipConnectors = [
  ['#list', '#todoRepos', '#actions', '#todos'],
  ['#assigned', '#assignedRepos', '#assignedTypes', '#assignedItems'],
].map(([view, repos, types, rows]) => {
  const section = $(view);
  const list = $(rows);
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'chip-connector');
  svg.setAttribute('aria-hidden', 'true');
  section.prepend(svg);
  const connector = { section, svg, repos: $(repos), types: $(types), list, hoveredRow: null, renderedRow: null };
  const cardRow = target => target instanceof Element && target.closest('li:not(.empty, .separator)');
  list.addEventListener('mouseover', e => {
    const row = cardRow(e.target);
    if (row?.parentElement !== list || row === cardRow(e.relatedTarget)) return;
    connector.hoveredRow = row;
    scheduleChipConnectors();
  });
  list.addEventListener('mouseout', e => {
    const row = connector.hoveredRow;
    if (!row || row !== cardRow(e.target) || row === cardRow(e.relatedTarget)) return;
    connector.hoveredRow = null;
    scheduleChipConnectors();
  });
  list.addEventListener('transitionend', e => {
    if (e.target === connector.hoveredRow && e.propertyName === 'transform') scheduleChipConnectors();
  });
  return connector;
});
const [todoConnector, assignedConnector] = chipConnectors;

function chipConnectorPath(origin, upper, lower) {
  const x1 = upper.left + upper.width / 2 - origin.left;
  const x2 = lower.left + lower.width / 2 - origin.left;
  const y1 = upper.bottom + 4 - origin.top;
  const y2 = lower.top - 4 - origin.top;
  return `M ${x1} ${y1} V ${(y1 + y2) / 2} H ${x2} V ${y2}`;
}

function rowConnectorPath(origin, chip, bar, list, row) {
  const startX = chip.left + chip.width / 2 - origin.left;
  const startY = chip.bottom + 4;
  // バーと一覧が接していても、一覧の上パディング内で最上段のカードより手前に曲がる。
  const bendY = Math.min(Math.max((bar.bottom + list.top) / 2, startY + 2), row.top - 2);
  const gutterX = row.left - 12 - origin.left;
  const endX = row.left - 4 - origin.left;
  const endY = row.top + row.height / 2 - origin.top;
  return `M ${startX} ${startY - origin.top} V ${bendY - origin.top} H ${gutterX} V ${endY} H ${endX}`;
}

function updateChipConnectorPath(svg, target, d, sameRow = false) {
  const previous = svg.querySelector(`[data-target="${target}"]`);
  if (d === (previous?.getAttribute('d') ?? '')) return;
  if (!d) {
    previous.remove();
    return;
  }
  if (sameRow && previous) {
    // ホバー移動後の座標補正では描画アニメーションを再起動しない。
    previous.setAttribute('d', d);
    return;
  }
  // 更新した線だけを差し替えて描画アニメーションを再生する。
  const path = document.createElementNS(svgNS, 'path');
  path.dataset.target = target;
  path.setAttribute('d', d);
  path.setAttribute('pathLength', '1');
  if (previous) previous.replaceWith(path);
  else if (target === 'type') svg.prepend(path);
  else svg.append(path);
}

let chipConnectorFrame = null;
function scheduleChipConnectors() {
  if (chipConnectorFrame !== null) return;
  chipConnectorFrame = requestAnimationFrame(() => {
    chipConnectorFrame = null;
    for (const connector of chipConnectors) {
      const { section, svg, repos, types, list } = connector;
      if (section.classList.contains('hidden')) {
        connector.hoveredRow = null;
        connector.renderedRow = null;
        svg.replaceChildren();
        continue;
      }
      const repo = repos.querySelector('.chip.active');
      const type = types.querySelector('.chip.active')?.getBoundingClientRect();
      const row = connector.hoveredRow;
      const origin = svg.getBoundingClientRect();
      updateChipConnectorPath(svg, 'type', repo && type ? chipConnectorPath(origin, repo.getBoundingClientRect(), type) : '');
      const rowPath = type && row
        ? rowConnectorPath(origin, type, types.getBoundingClientRect(), list.getBoundingClientRect(), row.getBoundingClientRect())
        : '';
      updateChipConnectorPath(svg, 'row', rowPath, row === connector.renderedRow);
      connector.renderedRow = row;
    }
  });
}
window.addEventListener('resize', scheduleChipConnectors);

// ---------- 言語 ----------
// data-i18n の文言と操作ラベルを現在の言語で表示する
function applyI18n() {
  document.documentElement.lang = lang === 'en' ? 'en' : 'ja';
  document.title = tr(lang, 'appTitle');
  for (const e of document.querySelectorAll('[data-i18n]')) {
    const label = tr(lang, e.dataset.i18n);
    if (e.hasAttribute('data-i18n-icon')) {
      // アイコンのみのボタンは文言を aria-label / title に入れる（SVG を消さない）
      e.setAttribute('aria-label', label);
      e.title = label;
    } else {
      e.textContent = label;
    }
  }
  // ラベル専用（aria-label と title を翻訳で埋める）
  for (const e of document.querySelectorAll('[data-i18n-label]')) {
    const label = tr(lang, e.dataset.i18nLabel);
    e.setAttribute('aria-label', label);
    e.title = label;
  }
}

// ---------- 共通 ----------
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function renderWarning(control, label, warning, title = '') {
  if (!warning) {
    if (title) control.title = title;
    else control.removeAttribute('title');
    control.removeAttribute('aria-label');
    return;
  }
  const badge = el('span', 'warning-count');
  badge.setAttribute('aria-hidden', 'true');
  control.title = title ? `${title} · ${warning}` : warning;
  control.setAttribute('aria-label', `${label} (${warning})`);
  control.append(badge);
}

// 選択肢を並べ、クリックで filter[key] を切り替える。消えた選択肢は 'all' に戻す
function renderChips(container, key, entries, labelOf = v => v, titleOf = () => '', overdueOf) {
  if (filter[key] !== 'all' && !entries.has(filter[key])) filter[key] = 'all';
  const focused = container.contains(document.activeElement) ? document.activeElement.dataset.value : undefined;
  container.replaceChildren();
  scheduleChipConnectors();
  if (entries.size === 0) return;
  const all = [...entries.values()].reduce((sum, n) => sum + n, 0);
  for (const [value, n] of [['all', all], ...entries]) {
    const label = value === 'all' ? tr(lang, 'all') : labelOf(value);
    const active = filter[key] === value;
    const c = el(overdueOf ? 'button' : 'span', `chip${active ? ' active' : ''}`);
    c.append(`${label} `, el('span', 'chip-count', n));
    const title = value === 'all' ? '' : titleOf(value);
    if (overdueOf) {
      c.type = 'button';
      c.dataset.value = value;
      c.setAttribute('aria-pressed', String(active));
      const overdue = overdueOf(value);
      renderWarning(c, c.textContent, overdue ? tr(lang, 'tabOverdue', { n: overdue }) : '', title);
    } else {
      c.title = title;
    }
    c.onclick = () => { filter[key] = value; render(current); };
    container.append(c);
    if (focused === value || (value === 'all' && focused !== undefined && !entries.has(focused))) {
      c.focus({ preventScroll: true });
    }
  }
}

function countBy(items, keyOf) {
  const m = new Map();
  for (const it of items) {
    const key = keyOf(it);
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return m;
}

// ---------- To-Do タブ ----------
function renderTodos(todos, error) {
  renderChips($('#todoRepos'), 'todoRepo', countBy(todos, t => todoRepo(t, lang)), shortName, p => p);
  const inRepo = todos.filter(t => filter.todoRepo === 'all' || todoRepo(t, lang) === filter.todoRepo);
  const actionOf = t => actionLabel(lang, t.action_name);
  renderChips($('#actions'), 'action', countBy(inRepo, actionOf));
  const shown = inRepo.filter(t => filter.action === 'all' || actionOf(t) === filter.action);

  const ul = todoConnector.list;
  todoConnector.hoveredRow = null;
  ul.replaceChildren();
  if (!shown.length && !error) ul.append(el('li', 'empty', tr(lang, 'emptyTodos')));
  for (const t of shown) {
    const li = el('li');
    const main = el('div', 'main');
    const title = el('div', 'title');
    title.append(el('span', `tag t-${actionTone(t.action_name)}`, actionOf(t)));
    const ref = todoRef(t);
    title.append(`${TYPES[t.target_type] ?? t.target_type}${ref ? ` ${ref}` : ''} ${t.target?.title ?? ''}`);
    const meta = el('div', 'meta');
    meta.append(`${t.project?.name_with_namespace ?? t.group?.full_name ?? ''} · ${t.author?.name ?? ''} · ${ago(t.created_at, { lang })}`);
    main.append(title, meta);
    if (t.body) main.append(el('div', 'body', t.body));
    // 作業アイテムタブと同じく、期限は行の右端（末尾の枠）にまとめる。
    // アサインだけ期限を出す（Issue の期限、なければマイルストーンの期限）
    const trail = el('div', 'trail');
    const due = t.action_name === 'assigned' ? dueInfoOr(t, lang) : null;
    if (due) trail.append(el('span', due.cls, due.text));
    const btn = el('button', 'done-button');
    btn.type = 'button';
    btn.setAttribute('aria-label', tr(lang, 'done'));
    btn.title = lang === 'en' ? 'Mark this To-Do as done on GitLab' : 'GitLab 上で To-Do を完了にする';
    btn.innerHTML = `<svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="m3 8 3 3 7-7"/>
    </svg>`;
    btn.disabled = pendingDoneIds.has(t.id);
    li.classList.toggle('done-pending', btn.disabled);
    btn.onclick = async e => {
      e.stopPropagation();
      pendingDoneIds.add(t.id);
      li.classList.add('done-pending');
      btn.disabled = true;

      const done = await window.api.done(t.id).catch(() => false);
      pendingDoneIds.delete(t.id);
      if (!done || current.todos.some(todo => todo.id === t.id)) {
        renderTodos(current.todos, current.error);
      }
    };
    li.append(main, trail, btn);
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

// ---------- 作業アイテムタブ ----------
const validItemId = n => Number.isSafeInteger(n) && n > 0;
const itemKey = i => `${i.project_id}:${i.iid}`;

function externalLink(link, url) {
  // 不正なスキームをリンクに設定しない。通常のクリックや Enter は既存の外部ブラウザ経路を使う。
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
  link.href = url;
  const open = e => {
    e.preventDefault();
    e.stopPropagation();
    window.api.open(url);
  };
  link.onclick = open;
  link.onauxclick = e => { if (e.button === 1) open(e); };
}

function relatedMrBadge(mr, issueKey) {
  const kind = mrStatus(mr);
  const status = tr(lang, MR_STATUS_LABELS[kind]);
  const link = el('a', `related-mr-link mr-status s-${kind}`);
  link.dataset.mrKey = itemKey(mr);
  link.dataset.assignedFocus = `${issueKey}:mr:${link.dataset.mrKey}`;
  link.title = mr.title;
  link.setAttribute('aria-label', tr(lang, 'mrLinkLabel', { iid: mr.iid, title: mr.title, state: status }));
  externalLink(link, mr.web_url);
  link.append(`!${mr.iid} `, el('span', 'related-mr-state', status));
  return link;
}

function replaceAssignedRows(list, rows) {
  const active = document.activeElement;
  const focusKey = list.contains(active) ? active.dataset.assignedFocus : null;
  list.replaceChildren(...rows);
  if (focusKey) [...list.querySelectorAll('[data-assigned-focus]')]
    .find(e => e.dataset.assignedFocus === focusKey)?.focus({ preventScroll: true });
}

function assignedRow(i, relatedMrsByIssue) {
  const li = el('li');
  const main = el('div', 'main');
  const issueLink = el('a', 'assigned-item-link');
  externalLink(issueLink, i.web_url);
  const key = validItemId(i.project_id) && validItemId(i.iid) ? itemKey(i) : null;
  if (key) issueLink.dataset.assignedFocus = `${key}:item`;
  const title = el('div', 'title');
  title.append(el('span', `tag t-${workItemTone(workItemType(i))}`, workItemTypeLabel(lang, workItemType(i))), `#${i.iid} ${i.title}`);
  const meta = el('div', 'meta');
  meta.append(`${issueRepo(i)}${i.labels?.length ? ` · ${i.labels.join(', ')}` : ''}`);
  issueLink.append(title, meta);
  main.append(issueLink);
  // 期限は行の右端（末尾の枠）にまとめ、縦に流し見したとき急ぎの行を拾えるようにする
  const trail = el('div', 'trail');
  if (i.due_date) {
    const due = dueInfo(i.due_date, { lang });
    trail.append(el('span', due.cls, due.text));
  }
  li.append(main, trail);
  li.onclick = () => window.api.open(i.web_url);
  if (key && workItemType(i) === 'issue') {
    li.dataset.issueKey = key;
    const mrs = relatedMrsByIssue[key];
    if (Array.isArray(mrs) && mrs.length) {
      const badges = el('div', 'related-mr-badges');
      badges.setAttribute('role', 'group');
      badges.setAttribute('aria-label', tr(lang, 'relatedMrs'));
      badges.append(...mrs.map(mr => relatedMrBadge(mr, key)));
      main.append(badges);
    }
  }
  return li;
}

function renderAssigned(items, limited, error, relatedMrsByIssue = {}) {
  const overdueBy = (group, keyOf) => value => countOverdue(value === 'all' ? group : group.filter(i => keyOf(i) === value));
  renderChips($('#assignedRepos'), 'assignedRepo', countBy(items, issueRepo), shortName, p => p, overdueBy(items, issueRepo));
  const inRepo = items.filter(i => filter.assignedRepo === 'all' || issueRepo(i) === filter.assignedRepo);
  // 種別が 1 つ以下なら選ぶ意味がないので行ごと隠す（空の Map を渡すと選択も 'all' に戻る）
  const types = countBy(inRepo, workItemType);
  renderChips($('#assignedTypes'), 'assignedType', types.size >= 2 ? types : new Map(),
    v => workItemTypeLabel(lang, v), undefined, overdueBy(inRepo, workItemType));
  const shown = inRepo.filter(i => filter.assignedType === 'all' || workItemType(i) === filter.assignedType);
  const tab = $('#assignedTab');
  const { label, warning } = assignedTabLabel(items, { lang });
  tab.textContent = label;
  renderWarning(tab, label, warning);
  $('#assignedLimit').classList.toggle('hidden', !limited);
  $('#assignedLimit').textContent = tr(lang, 'assignedLimit', { n: ASSIGNED_LIMIT });

  const { dated, undated } = splitByDue(shown);
  const row = i => assignedRow(i, relatedMrsByIssue);
  assignedConnector.hoveredRow = null;
  replaceAssignedRows(assignedConnector.list, [
    ...(!shown.length && !error ? [el('li', 'empty', tr(lang, 'emptyAssigned'))] : []),
    ...dated.map(row),
    ...(undated.length ? [el('li', 'separator', tr(lang, 'noDueDate')), ...undated.map(row)] : []),
  ]);
}

function render(s) {
  current = s;
  const message = [s.error, s.assignedError].filter(Boolean).join(' / ');
  $('#error').classList.toggle('hidden', !message);
  $('#error').textContent = message;
  renderSettingsMessage();
  const status = $('#status');
  status.textContent = s.loading ? tr(lang, 'loading') : '';
  if (!s.loading && s.updatedAt) {
    const count = tr(lang, 'statusCount', { n: s.count });
    status.append(s.count > 0 ? el('span', 'status-count', count) : count, ` / ${new Date(s.updatedAt).toLocaleTimeString()}`);
  }
  renderTodos(s.todos, s.error);
  $('#mrSyncError').hidden = !s.mrSyncError;
  renderAssigned(s.assigned ?? [], s.assignedLimited, s.error || s.assignedError, s.relatedMrsByIssue ?? {});
  drawBadge(s.count);
}

// ---------- バッジ描画（タスクバーのオーバーレイ） ----------
function drawBadge(count) {
  const label = count > 99 ? '99+' : String(count);

  const o = document.createElement('canvas');
  o.width = o.height = 16;
  const g = o.getContext('2d');
  g.fillStyle = '#e24329';
  g.beginPath(); g.arc(8, 8, 8, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#fff';
  g.font = `bold ${label.length > 2 ? 7 : label.length > 1 ? 9 : 11}px Segoe UI`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(label, 8, 8.5);

  window.api.setBadge({ overlay: o.toDataURL(), count });
}

// ---------- 設定 ----------
function renderSettingsMessage() {
  const key = settingsSaveError || current.settingsMessage;
  const message = key ? tr(lang, key) : '';
  const banner = $('#settingsMessage');
  banner.classList.toggle('hidden', !message);
  if (banner.textContent !== message) banner.textContent = message;
}

async function loadForm() {
  const c = await window.api.getConfig();
  const next = LANGS.includes(c.lang) ? c.lang : 'ja';
  const changed = next !== lang;
  lang = next;
  if (changed) {
    applyI18n();
    render(current);
    positionTabIndicator();
  }
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
  const button = f.querySelector('button[type=submit]');
  if (button.disabled) return;
  button.disabled = true;
  $('#saved').textContent = '';
  try {
    const { error } = await window.api.saveConfig({
      baseUrl: f.baseUrl.value,
      token: f.token.value,
      intervalSec: f.intervalSec.value,
      notify: f.notify.checked,
      autoStart: f.autoStart.checked,
      insecure: f.insecure.checked,
      lang: f.elements.lang.value,
    });
    settingsSaveError = error;
  } catch {
    settingsSaveError = 'errConfigSave';
  } finally {
    button.disabled = false;
    renderSettingsMessage();
  }
  if (settingsSaveError) return;
  f.token.value = '';
  await loadForm();
  $('#saved').textContent = tr(lang, 'saved');
  setTimeout(() => ($('#saved').textContent = ''), 2000);
};

$('#refresh').onclick = () => window.api.refresh();
$('#win-minimize').onclick = () => window.api.winMinimize();
$('#win-close').onclick = () => window.api.winClose();
window.api.getVersion().then(version => { $('#build-version').textContent = `BUILD ${version}`; });
window.api.onState(render);
window.api.getState().then(render);
applyI18n();
positionTabIndicator();
loadForm();
