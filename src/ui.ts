// SPDX-License-Identifier: AGPL-3.0-only
import type { AvailabilityHistory, Status } from "./index";

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
const stateLabel = {
  unknown: "Awaiting check",
  up: "Operational",
  down: "Unavailable",
  maintenance: "Maintenance",
  paused: "Monitoring paused",
};
function document(title: string, body: string, operator = false) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><link rel="stylesheet" href="/app.css"></head><body><header><a class="brand" href="/">irisbeat</a><nav aria-label="Application"><a href="/"${operator ? "" : ' aria-current="page"'}>Status page</a><a href="/operator"${operator ? ' aria-current="page"' : ""}>Operator</a></nav></header><main>${body}</main><footer><a href="https://github.com/webriot/irisbeat/releases/download/v0.1.0/irisbeat-0.1.0-source.tar.gz">Source (AGPL-3.0-only)</a></footer></body></html>`;
}

function historyMarkup(history: AvailabilityHistory | null | undefined) {
  if (!history) return '<p class="history-unavailable">Bars unavailable</p>';
  return `<div class="availability"><span class="percentage" aria-label="Availability">${history.percentage === null ? "Unavailable" : history.percentage.toFixed(2) + "%"}</span><ol class="history" aria-label="90 UTC days of availability">${history.days.map(day => {
    const label = day.date + " UTC: " + (day.state === "maintenance" ? "Maintenance" : day.state) + "; " + day.successes + " successes, " + day.failures + " failures, " + day.maintenance + " Maintenance";
    return `<li data-key="${day.date}" class="history-day ${day.state}" tabindex="0" aria-label="${label}"><span class="history-detail" aria-hidden="true">${label}</span></li>`;
  }).join("")}</ol></div>`;
}

function statusMarkup(status: Status) {
  const time = (at: number) =>
    `<time datetime="${new Date(at).toISOString()}">${new Date(at).toISOString()}</time>`;
  const banner = status.paused ? "Monitoring paused" : !status.monitors.length
    ? "No Monitors published"
    : status.incidents.some(incident => incident.closedAt === null) || status.monitors.some(monitor => monitor.state === "down")
      ? "Services unavailable"
      : status.monitors.every(monitor => monitor.state === "maintenance")
        ? "Maintenance"
      : status.monitors.every(monitor => monitor.state === "up" || monitor.state === "maintenance") && status.monitors.some(monitor => monitor.state === "maintenance")
        ? "Some services in Maintenance"
      : status.monitors.every(monitor => monitor.state === "up")
        ? "All services operational"
        : "Awaiting check";
  return `<h1>${escape(status.pageName)}</h1>
    <section class="banner" aria-label="Current status"><h2>${escape(banner)}</h2></section>
    <div id="public-monitors">${status.monitors.map((monitor, index) => `<article data-key="${escape(monitor.id)}" aria-labelledby="monitor-name${index || ""}"><div class="ledger-row"><h2 id="monitor-name${index || ""}">${escape(monitor.name)}</h2><span class="status">${stateLabel[monitor.state]}</span></div>${historyMarkup(monitor.history)}</article>`).join("")}</div>
    ${status.monitors.length ? `<section aria-labelledby="incident-heading"><h2 id="incident-heading">Incidents</h2>${status.incidents.length ? `<ul class="incidents">${status.incidents.map((incident) => `<li data-key="${escape(incident.id)}"><article class="incident"><strong>${escape(status.monitors.find(monitor => monitor.id === incident.monitorId)?.name ?? incident.monitorId)} — ${incident.closedAt === null ? "Open" : "Recovered"}</strong><p>Unavailable since ${time(incident.openedAt)}${incident.closedAt === null ? " — Ongoing" : ` — Recovered ${time(incident.closedAt)}`}</p></article></li>`).join("")}</ul>` : "<p>No Incidents</p>"}</section>` : ""}`;
}

export function statusPage(status: Status) {
  return document(status.pageName, `<div id="public-status">${statusMarkup(status)}</div><button id="refresh" type="button">Refresh</button><span id="stale" role="status" hidden>Updates unavailable</span><script src="/status.js" defer></script>`);
}

export function operatorPage(hosted = false) {
  return document(
    "Irisbeat operator",
    `<h1>Monitors</h1>
    <form id="login"><label for="secret">${hosted ? "Access token" : "Installation secret"}</label><input id="secret" type="password" required autocomplete="current-password"><button>Sign in</button></form>
    <section id="editor" hidden>
      <h2 id="paused" hidden>Monitoring paused</h2>
      <table aria-label="Monitors"><thead><tr><th scope="col">Monitor</th><th scope="col">State</th><th scope="col">Publication</th><th scope="col">Actions</th></tr></thead><tbody id="monitor-rows"></tbody></table>
      <form id="maintenance" hidden aria-labelledby="maintenance-heading">
        <h2 id="maintenance-heading">Maintenance</h2>
        <label for="maintenance-end">End time</label><input id="maintenance-end" type="datetime-local" required>
        <p id="maintenance-missing" role="status" hidden>This Monitor was deleted. Cancel to choose another Monitor.</p><button id="save-maintenance">Declare Maintenance</button><button id="cancel-maintenance" type="button">Cancel</button>
      </form>
      <button id="new-monitor" type="button">New Monitor</button>
      <div class="configuration-layout">
        <form id="configuration" hidden aria-labelledby="monitor-settings">
          <h2 id="monitor-settings">New Monitor</h2>
          <label for="name">Monitor name</label><input id="name" name="name" required maxlength="120">
          <label for="kind">Check type</label><select id="kind" name="kind"><option value="http">HTTP(S)</option><option value="tcp">TCP</option><option value="heartbeat">Heartbeat</option></select>
          <output id="heartbeat-path"></output>
          <button id="rotate-heartbeat" type="button" hidden>Rotate heartbeat secret</button>
          <output id="heartbeat-credential"></output>
          <fieldset id="http-target"><label for="url">HTTP(S) target</label><input id="url" name="url" type="url" required maxlength="2048"></fieldset>
          <fieldset id="tcp-target" hidden disabled><label for="hostname">Hostname</label><input id="hostname" name="hostname" required maxlength="253" autocapitalize="none" spellcheck="false">
          <label for="port">Port</label><input id="port" name="port" type="number" min="1" max="65535" step="1" required></fieldset>
          <label for="intervalSeconds">Interval (seconds)</label><input id="intervalSeconds" name="intervalSeconds" type="number" min="60" max="86400" step="1" value="60" required>
          <label for="timeoutSeconds">Timeout (seconds)</label><input id="timeoutSeconds" name="timeoutSeconds" type="number" min="1" max="60" step="1" value="10" required>
          <label for="failureThreshold">Consecutive failures</label><input id="failureThreshold" name="failureThreshold" type="number" min="1" max="100" step="1" value="2" required>
          <label for="recoveryThreshold">Consecutive successes</label><input id="recoveryThreshold" name="recoveryThreshold" type="number" min="1" max="100" step="1" value="2" required>
          <label for="silenceSeconds">Silence (seconds)</label><input id="silenceSeconds" name="silenceSeconds" type="number" min="60" max="86400" step="1" value="180" required>
          <label for="recoverySpacingSeconds">Recovery spacing (seconds)</label><input id="recoverySpacingSeconds" name="recoverySpacingSeconds" type="number" min="60" max="86400" step="1" value="60" required>
          <label class="checkbox" for="published"><input id="published" name="published" type="checkbox" checked>Published</label>
          <p id="monitor-missing" role="status" hidden>This Monitor was deleted. Cancel to create a new Monitor.</p><button id="save-monitor">Save Monitor</button><button id="cancel-edit" type="button">Cancel</button>
        </form>
        <aside aria-labelledby="page-settings"><h2 id="page-settings">Status page</h2>
          <form id="page-configuration"><label for="pageName">Page name</label><input id="pageName" name="pageName" required maxlength="120"><button>Save page</button></form>
        </aside>
      </div>
      <form id="webhook" aria-labelledby="webhook-heading">
        <h2 id="webhook-heading">Operator alerts</h2>
        <label for="webhookUrl">HTTPS webhook URL</label><input id="webhookUrl" name="url" type="url" maxlength="2048" autocomplete="off">
        <button>Save webhook</button>
      </form>
      <section aria-labelledby="incident-heading"><h2 id="incident-heading">Incidents</h2><ul id="incidents" class="incidents"></ul></section>
      <div class="actions"><button id="refresh" type="button">Refresh</button><button id="logout" type="button">Sign out</button></div>
    </section>
    <span id="stale" role="status" hidden>Updates unavailable</span>
    <p id="message" role="status" aria-live="polite"></p>
    <script src="/operator.js" defer></script>`,
    true,
  );
}

export const styleSheet = `
:root { color-scheme: light dark; font-family: system-ui, sans-serif; line-height: 1.5; --line: light-dark(#d6dfda, #42544d); }
* { box-sizing: border-box; }
body { max-width: 66rem; margin: auto; padding: 1.5rem; overflow-wrap: anywhere; }
header, nav, .ledger-row, .actions { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
header { padding-bottom: 1.5rem; border-bottom: 1px solid var(--line); }
nav { justify-content: flex-start; }
a { color: inherit; text-underline-offset: .2em; }
.brand { font-size: 1.3rem; font-weight: 700; text-decoration: none; }
[aria-current="page"] { font-weight: 700; }
h1 { font-size: clamp(2rem, 5vw, 3rem); }
h2 { font-size: 1.25rem; }
.banner { padding: 1rem 0 2rem; border-bottom: 1px solid var(--line); }
.banner h2 { font-size: 1.8rem; }
.ledger-row { padding: 1rem 0; border-bottom: 1px solid var(--line); }
table { width: 100%; border-collapse: collapse; margin: 1.5rem 0; }
th, td { padding: 1rem .5rem; text-align: left; border-bottom: 1px solid var(--line); }
.availability { padding: 1rem 0; min-width: 12rem; }
.percentage { font-variant-numeric: tabular-nums; }
.history { position: relative; display: grid; grid-template-columns: repeat(90, minmax(0, 1fr)); gap: 2px; list-style: none; padding: 0; margin: .5rem 0; }
.history:has(.history-day:focus), .history:has(.history-day:hover) { padding-bottom: 5rem; }
.history-detail { display: none; position: absolute; inset: 2.2rem 0 auto; font-size: .875rem; line-height: 1.4; }
.history-day:focus .history-detail, .history:not(:has(.history-day:focus)) .history-day:hover .history-detail { display: block; }
.history-day { height: 1.8rem; background: light-dark(#e6eae8, #35413c); }
.history-day.up { background: light-dark(#19734b, #59c990); }
.history-day.down { background: light-dark(#b52a34, #ff7880); }
.history-day.degraded { background: light-dark(#986500, #e6b64d); }
.history-day.maintenance { background: light-dark(#5454a6, #a4a4ef); }
.history-day.empty { border: 1px dashed var(--line); background: transparent; }
@media (max-width: 44rem) { table, thead, tbody, tr, td { display: block; } thead { position: absolute; clip-path: inset(100%); } td { border: 0; padding: .4rem 0; } tr { border-bottom: 1px solid var(--line); padding: 1rem 0; } }
.configuration-layout { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); gap: 2.5rem; margin: 2rem 0; }
aside { border-left: 1px solid var(--line); padding-left: 1.5rem; }
fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
label { display: block; margin: 1rem 0 .4rem; }
input, select, button { font: inherit; min-height: 2.75rem; max-width: 100%; }
input, select { width: 100%; padding: .5rem; }
.checkbox { display: flex; align-items: center; gap: .5rem; }
input[type="checkbox"] { width: auto; }
td .actions { margin: 0; gap: .5rem; }
button:disabled { cursor: wait; }
[hidden] { display: none !important; }
button { padding: .5rem .9rem; cursor: pointer; }
form button { margin-top: 1rem; }
.text-button { border: 0; background: transparent; color: inherit; padding-left: 0; text-decoration: underline; text-underline-offset: .2em; }
:focus-visible { outline: 2px solid currentColor; outline-offset: 4px; }
.incidents { list-style: none; padding: 0; }
.incident { padding: 1rem 0; border-top: 1px solid var(--line); }
.incident p { margin-bottom: 0; }
.actions { justify-content: flex-start; margin-top: 2rem; }
#login { max-width: 28rem; }
@media (max-width: 44rem) { .configuration-layout { grid-template-columns: 1fr; gap: 1rem; } aside { border-left: 0; padding-left: 0; } body { padding: 1rem; } }
`;

const refreshScript = `
function reconcile(parent, desired) {
  const keyOf = node => node.nodeType === 1 ? node.getAttribute('data-key') || node.id : null;
  const keys = new Set([...desired.childNodes].map(keyOf).filter(Boolean));
  // Remove deleted identities before ordering, so surviving focused rows need not move.
  for (const node of [...parent.childNodes]) if (keyOf(node) && !keys.has(keyOf(node))) node.remove();
  let cursor = parent.firstChild;
  for (const fresh of [...desired.childNodes]) {
    const key = keyOf(fresh);
    let node = key ? [...parent.childNodes].find(child => keyOf(child) === key) : cursor;
    if (!node || node.nodeType !== fresh.nodeType || node.nodeName !== fresh.nodeName || (!key && keyOf(node))) {
      node = fresh; parent.insertBefore(node, cursor);
    } else {
      if (node !== cursor) parent.insertBefore(node, cursor);
      if (node.nodeType === 3) { if (node.textContent !== fresh.textContent) node.textContent = fresh.textContent; }
      else if (node.nodeType === 1) {
        // Disclosure and history selection belong to the user, not the snapshot.
        const interactive = name => name === 'open' || (node.closest('.history') && ['tabindex', 'aria-current', 'aria-selected'].includes(name));
        for (const attribute of [...node.attributes]) if (!interactive(attribute.name) && !fresh.hasAttribute(attribute.name)) node.removeAttribute(attribute.name);
        for (const attribute of [...fresh.attributes]) if (!interactive(attribute.name) && node.getAttribute(attribute.name) !== attribute.value) node.setAttribute(attribute.name, attribute.value);
        if (fresh.onclick) node.onclick = fresh.onclick;
        reconcile(node, fresh);
      }
    }
    cursor = node.nextSibling;
  }
  while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
}
function pollVisible(refresh, active = () => true) {
  let timer;
  const schedule = () => { clearTimeout(timer); if (!document.hidden) timer = setTimeout(async () => { if (active()) await refresh(); schedule(); }, 60000); };
  document.addEventListener('visibilitychange', () => { schedule(); if (!document.hidden && active()) refresh(); });
  schedule();
}
`;

export const statusScript = `
${refreshScript}
const escape = ${escape.toString()};
const stateLabel = ${JSON.stringify(stateLabel)};
const historyMarkup = ${historyMarkup.toString()};
const statusMarkup = ${statusMarkup.toString()};
let requestId = 0;
async function refresh() {
  const id = ++requestId;
  try {
    const response = await fetch('/api/status');
    if (!response.ok) throw new Error('Request failed');
    const data = await response.json();
    if (id !== requestId) return;
    const desired = document.createElement('div'); desired.innerHTML = statusMarkup(data);
    reconcile(document.getElementById('public-status'), desired);
    document.title = data.pageName;
    document.getElementById('stale').hidden = true;
  } catch { if (id === requestId) document.getElementById('stale').hidden = false; }
}
document.getElementById('refresh').addEventListener('click', refresh);
pollVisible(refresh);
`;

export const operatorScript = `
${refreshScript}
const historyMarkup = ${historyMarkup.toString()};
const byId = id => document.getElementById(id);
const login = byId('login');
const editor = byId('editor');
const form = byId('configuration');
const pageForm = byId('page-configuration');
const webhook = byId('webhook');
const maintenanceForm = byId('maintenance');
const message = byId('message');
const timingDefaults = { intervalSeconds: 60, timeoutSeconds: 10, failureThreshold: 2, recoveryThreshold: 2, silenceSeconds: 180, recoverySpacingSeconds: 60 };
let secret = '';
let editingId = null;
let busy = false;
let requestId = 0;
let hydrated = false;
let session = 0;
let monitors = [];
let canEdit = false;
let hosted = false;
function edit(monitor = null) {
  editingId = monitor?.id || null;
  form.reset();
  byId('monitor-settings').textContent = monitor ? 'Edit Monitor' : 'New Monitor';
  byId('name').value = monitor?.name || '';
  byId('kind').value = monitor?.kind || 'http';
  byId('kind').disabled = editingId !== null;
  byId('url').value = monitor?.url || '';
  byId('hostname').value = monitor?.hostname || '';
  byId('port').value = monitor?.port || '';
  byId('published').checked = monitor?.published ?? true;
  for (const [field, value] of Object.entries(timingDefaults)) byId(field).value = monitor?.[field] ?? value;
  byId('heartbeat-path').textContent = monitor?.kind === 'heartbeat' ? (hosted ? 'POST /heartbeat' : 'POST /heartbeat/' + monitor.id) : '';
  byId('rotate-heartbeat').hidden = !hosted || monitor?.kind !== 'heartbeat';
  byId('heartbeat-credential').textContent = '';
  updateKind();
  updateMissing();
  form.hidden = false;
  byId('name').focus();
}
function cancelEdit() { byId('heartbeat-path').textContent = ''; byId('heartbeat-credential').textContent = ''; editingId = null; form.reset(); form.hidden = true; }
function declareMaintenance(monitor) {
  maintenanceForm.dataset.monitorId = monitor.id;
  byId('maintenance-heading').textContent = monitor.name + ' — Maintenance';
  byId('save-maintenance').textContent = monitor.maintenance ? 'Replace Maintenance' : 'Declare Maintenance';
  const end = new Date(monitor.maintenance?.endsAt ?? Date.now() + 3600000);
  byId('maintenance-end').value = new Date(end.getTime() - end.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  updateMissing();
  maintenanceForm.hidden = false; byId('maintenance-end').focus();
}
function signOut() {
  session++; requestId++; busy = false; hydrated = false; monitors = []; canEdit = false; hosted = false; byId('stale').hidden = true;
  secret = ''; cancelEdit(); maintenanceForm.reset(); delete maintenanceForm.dataset.monitorId; byId('maintenance-heading').textContent = 'Maintenance'; byId('paused').hidden = true; maintenanceForm.hidden = true; pageForm.reset(); webhook.reset(); editor.hidden = true; login.hidden = false;
  byId('monitor-rows').replaceChildren(); byId('incidents').replaceChildren();
  message.textContent = ''; byId('secret').value = ''; byId('secret').focus();
}
function render(data) {
  login.hidden = true; editor.hidden = false;
  hosted = !!data.hosted;
  byId('paused').hidden = !data.paused;
  canEdit = data.permission !== 'reader';
  monitors = data.monitors;
  if (!canEdit) { cancelEdit(); maintenanceForm.reset(); delete maintenanceForm.dataset.monitorId; maintenanceForm.hidden = true; webhook.reset(); pageForm.reset(); hydrated = false; }
  byId('new-monitor').hidden = !canEdit; pageForm.closest('aside').hidden = !canEdit; webhook.hidden = !canEdit;
  if (canEdit && !hydrated) { byId('pageName').value = data.pageName; byId('webhookUrl').value = data.webhookUrl || ''; hydrated = true; }
  updateMissing();
  const rows = data.monitors.flatMap(monitor => {
    const row = document.createElement('tr'); row.dataset.key = monitor.id;
    for (const text of [monitor.name, (${JSON.stringify(stateLabel)})[monitor.state], monitor.published ? 'Published' : 'Private']) {
      const cell = document.createElement('td'); cell.textContent = text; row.append(cell);
    }
    const actions = document.createElement('td');
    const group = document.createElement('div'); group.className = 'actions';
    const path = '/api/operator/monitors/' + encodeURIComponent(monitor.id);
    for (const [label, action] of (canEdit ? [
      ['Edit', () => edit(monitor)],
      [monitor.maintenance ? 'Replace Maintenance' : 'Declare Maintenance', () => declareMaintenance(monitor)],
      ...(monitor.maintenance ? [['End Maintenance', () => {
        const submittedId = maintenanceForm.dataset.monitorId;
        const draft = byId('maintenance-end').value;
        run(path + '/maintenance', 'DELETE', undefined, () => {
          if (submittedId === monitor.id && submittedId === maintenanceForm.dataset.monitorId && draft === byId('maintenance-end').value) maintenanceForm.hidden = true;
        });
      }]] : []),
      [monitor.published ? 'Unpublish' : 'Publish', () => run(path, 'PATCH', { published: !monitor.published })],
      ['Delete', () => { if (confirm('Delete ' + monitor.name + '?')) run(path, 'DELETE'); }]
    ] : [])) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
      button.setAttribute('aria-label', label + ' ' + monitor.name);
      button.dataset.key = label.includes('Maintenance') ? (label === 'End Maintenance' ? 'end-maintenance' : 'maintenance') : ['Publish', 'Unpublish'].includes(label) ? 'publication' : label;
      button.onclick = action; group.append(button);
    }
    actions.append(group); row.append(actions);
    const historyRow = document.createElement('tr'); historyRow.dataset.key = monitor.id + '-history';
    const availability = document.createElement('td'); availability.colSpan = 4;
    availability.setAttribute('aria-label', monitor.name + ' availability');
    availability.innerHTML = historyMarkup(monitor.history); historyRow.append(availability);
    return [row, historyRow];
  });
  if (!rows.length) {
    const row = document.createElement('tr'); const cell = document.createElement('td');
    cell.colSpan = 4; cell.textContent = 'No Monitors'; row.append(cell); rows.push(row);
  }
  const desiredRows = document.createElement('tbody'); desiredRows.append(...rows);
  reconcile(byId('monitor-rows'), desiredRows);
  const incidents = data.incidents.map(incident => {
    const item = document.createElement('li'); item.className = 'incident'; item.dataset.key = incident.id;
    const monitor = data.monitors.find(monitor => monitor.id === incident.monitorId);
    item.textContent = (monitor?.name || incident.monitorName || incident.monitorId) + (monitor ? '' : ' (deleted)') + ' — Unavailable since ' + new Date(incident.openedAt).toISOString() + (incident.closedAt === null ? ' — Ongoing' : ' — Recovered ' + new Date(incident.closedAt).toISOString());
    return item;
  });
  if (!incidents.length) { const item = document.createElement('li'); item.textContent = 'No Incidents'; incidents.push(item); }
  const desiredIncidents = document.createElement('ul'); desiredIncidents.append(...incidents);
  reconcile(byId('incidents'), desiredIncidents);
}
function updateMissing() {
  const missing = editingId && !monitors.some(monitor => monitor.id === editingId);
  byId('monitor-missing').hidden = !missing;
  byId('save-monitor').disabled = !!missing || !canEdit;
  const maintenanceMissing = maintenanceForm.dataset.monitorId && !monitors.some(monitor => monitor.id === maintenanceForm.dataset.monitorId);
  byId('maintenance-missing').hidden = !maintenanceMissing;
  byId('save-maintenance').disabled = !!maintenanceMissing || !canEdit;
}
async function run(path = '/api/operator', method = 'GET', body, after) {
  if (!secret || busy) return;
  const id = ++requestId;
  const credential = secret;
  const currentSession = session;
  const mutation = method !== 'GET';
  if (mutation) busy = true;
  try {
    const response = await fetch(path, {
      method, headers: { Authorization: 'Bearer ' + credential, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (currentSession !== session) return;
    if (response.status === 401 || response.status === 403) { signOut(); message.textContent = 'Sign in required'; return; }
    const data = await response.json();
    if (id !== requestId) return;
    if (!response.ok) throw new Error(data.error || 'Request failed');
    if (data.secret) { byId('heartbeat-credential').textContent = 'Bearer ' + data.secret; }
    else {
      render(data);
      if (method === 'PUT' && path === '/api/operator' && byId('pageName').value === body.pageName) byId('pageName').value = data.pageName;
      if (path === '/api/operator/webhook' && byId('webhookUrl').value === body.url) byId('webhookUrl').value = data.webhookUrl || '';
    }
    byId('stale').hidden = true;
    if (after) after();
    if (mutation) message.textContent = method === 'DELETE' ? (path.endsWith('/maintenance') ? 'Maintenance ended' : 'Deleted') : 'Saved';
  } catch (error) {
    if (id !== requestId) return;
    byId('stale').hidden = false;
    if (mutation) message.textContent = error.message;
  } finally { if (mutation && currentSession === session) busy = false; }
}
function refresh() { return run(); }
pollVisible(refresh, () => !!secret);
function updateKind() {
  const kind = byId('kind').value;
  const heartbeat = kind === 'heartbeat';
  for (const target of ['http', 'tcp']) {
    byId(target + '-target').hidden = kind !== target;
    byId(target + '-target').disabled = kind !== target;
  }
  byId('kind').disabled = !!editingId;
  for (const field of ['timeoutSeconds', 'failureThreshold', 'silenceSeconds', 'recoverySpacingSeconds']) {
    const input = document.getElementById(field);
    const hidden = ['silenceSeconds', 'recoverySpacingSeconds'].includes(field) ? !heartbeat : heartbeat;
    input.disabled = hidden; input.hidden = hidden;
    document.querySelector('label[for="' + field + '"]').hidden = hidden;
  }
  document.querySelector('label[for="intervalSeconds"]').textContent = heartbeat ? 'Expectation (seconds)' : 'Interval (seconds)';
  document.querySelector('label[for="recoveryThreshold"]').textContent = heartbeat ? 'Recovery receipts' : 'Consecutive successes';
}
document.getElementById('kind').addEventListener('change', updateKind);
updateKind();
login.addEventListener('submit', async event => {
  event.preventDefault(); session++; secret = byId('secret').value;
  const submittedSession = session;
  await run();
  if (submittedSession !== session) return;
  byId('secret').value = '';
  if (!editor.hidden) byId(byId('new-monitor').hidden ? 'refresh' : 'new-monitor').focus();
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!canEdit || (editingId && !monitors.some(monitor => monitor.id === editingId))) return;
  const body = { name: byId('name').value, kind: byId('kind').value, published: byId('published').checked };
  if (body.kind === 'tcp') { body.hostname = byId('hostname').value; body.port = Number(byId('port').value); }
  else if (body.kind === 'http') body.url = byId('url').value;
  for (const field of Object.keys(timingDefaults)) { if (!byId(field).disabled) body[field] = Number(byId(field).value); }
  const draft = JSON.stringify([...new FormData(form)]);
  const submittedId = editingId;
  await run('/api/operator/monitors' + (editingId ? '/' + encodeURIComponent(editingId) : ''), editingId ? 'PATCH' : 'POST', body, () => { if (submittedId === editingId && draft === JSON.stringify([...new FormData(form)])) cancelEdit(); });
});
maintenanceForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!canEdit || !monitors.some(monitor => monitor.id === maintenanceForm.dataset.monitorId)) return;
  const submittedId = maintenanceForm.dataset.monitorId;
  const value = byId('maintenance-end').value;
  await run('/api/operator/monitors/' + encodeURIComponent(submittedId) + '/maintenance', 'PUT', { endsAt: new Date(value).getTime() }, () => { if (submittedId === maintenanceForm.dataset.monitorId && value === byId('maintenance-end').value) maintenanceForm.hidden = true; });
});
byId('cancel-maintenance').addEventListener('click', () => { maintenanceForm.hidden = true; });
webhook.addEventListener('submit', async event => { event.preventDefault(); await run('/api/operator/webhook', 'PUT', { url: byId('webhookUrl').value }); });
pageForm.addEventListener('submit', async event => { event.preventDefault(); await run('/api/operator', 'PUT', { pageName: byId('pageName').value }); });
byId('new-monitor').addEventListener('click', () => edit());
byId('rotate-heartbeat').addEventListener('click', () => { if (confirm('Replace this Monitor’s heartbeat secret?')) run('/api/operator/monitors/' + encodeURIComponent(editingId) + '/heartbeat-secret', 'POST'); });
byId('cancel-edit').addEventListener('click', cancelEdit);
byId('refresh').addEventListener('click', refresh);
byId('logout').addEventListener('click', signOut);
`;
