// SPDX-License-Identifier: AGPL-3.0-only
import type { Status } from "./index";

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
};
function document(title: string, body: string, operator = false) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><link rel="stylesheet" href="/app.css">${operator ? "" : '<meta http-equiv="refresh" content="60">'}</head><body><header><a class="brand" href="/">irisbeat</a><nav aria-label="Application"><a href="/"${operator ? "" : ' aria-current="page"'}>Status page</a><a href="/operator"${operator ? ' aria-current="page"' : ""}>Operator</a></nav></header><main>${body}</main></body></html>`;
}

export function statusPage(status: Status) {
  const time = (at: number) =>
    `<time datetime="${new Date(at).toISOString()}">${new Date(at).toISOString()}</time>`;
  const banner = !status.monitors.length
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
  return document(
    status.pageName,
    `<h1>${escape(status.pageName)}</h1>
    <section class="banner" aria-label="Current status"><h2>${escape(banner)}</h2></section>
    ${status.monitors.map((monitor, index) => `<article aria-labelledby="monitor-name${index || ""}"><div class="ledger-row"><h2 id="monitor-name${index || ""}">${escape(monitor.name)}</h2><span class="status">${stateLabel[monitor.state]}</span></div></article>`).join("")}
    ${status.monitors.length ? `<section aria-labelledby="incident-heading"><h2 id="incident-heading">Incidents</h2>${status.incidents.length ? `<ul class="incidents">${status.incidents.map((incident) => `<li><article class="incident"><strong>${escape(status.monitors.find(monitor => monitor.id === incident.monitorId)?.name ?? incident.monitorId)} — ${incident.closedAt === null ? "Open" : "Recovered"}</strong><p>Unavailable since ${time(incident.openedAt)}${incident.closedAt === null ? " — Ongoing" : ` — Recovered ${time(incident.closedAt)}`}</p></article></li>`).join("")}</ul>` : "<p>No Incidents</p>"}</section>` : ""}`,
  );
}

export function operatorPage(hosted = false) {
  return document(
    "Irisbeat operator",
    `<h1>Monitors</h1>
    <form id="login"><label for="secret">${hosted ? "Access token" : "Installation secret"}</label><input id="secret" type="password" required autocomplete="current-password"><button>Sign in</button></form>
    <section id="editor" hidden>
      <table aria-label="Monitors"><thead><tr><th scope="col">Monitor</th><th scope="col">State</th><th scope="col">Publication</th><th scope="col">Actions</th></tr></thead><tbody id="monitor-rows"></tbody></table>
      <form id="maintenance" hidden aria-labelledby="maintenance-heading">
        <h2 id="maintenance-heading">Maintenance</h2>
        <label for="maintenance-end">End time</label><input id="maintenance-end" type="datetime-local" required>
        <button id="save-maintenance">Declare Maintenance</button><button id="cancel-maintenance" type="button">Cancel</button>
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
          <button>Save Monitor</button><button id="cancel-edit" type="button">Cancel</button>
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

export const operatorScript = `
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
  form.hidden = false;
  byId('name').focus();
}
function cancelEdit() { byId('heartbeat-credential').textContent = ''; editingId = null; form.reset(); form.hidden = true; }
function declareMaintenance(monitor) {
  maintenanceForm.dataset.monitorId = monitor.id;
  byId('maintenance-heading').textContent = monitor.name + ' — Maintenance';
  byId('save-maintenance').textContent = monitor.maintenance ? 'Replace Maintenance' : 'Declare Maintenance';
  const end = new Date(monitor.maintenance?.endsAt ?? Date.now() + 3600000);
  byId('maintenance-end').value = new Date(end.getTime() - end.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  maintenanceForm.hidden = false; byId('maintenance-end').focus();
}
function signOut() {
  secret = ''; cancelEdit(); maintenanceForm.hidden = true; pageForm.reset(); webhook.reset(); editor.hidden = true; login.hidden = false;
  byId('monitor-rows').replaceChildren(); byId('incidents').replaceChildren();
  message.textContent = ''; byId('secret').value = ''; byId('secret').focus();
}
function render(data) {
  login.hidden = true; editor.hidden = false;
  hosted = !!data.hosted;
  const canEdit = data.permission !== 'reader';
  if (!canEdit) { cancelEdit(); maintenanceForm.hidden = true; }
  byId('new-monitor').hidden = !canEdit; pageForm.closest('aside').hidden = !canEdit; webhook.hidden = !canEdit;
  byId('pageName').value = data.pageName;
  byId('webhookUrl').value = data.webhookUrl || '';
  const rows = data.monitors.map(monitor => {
    const row = document.createElement('tr');
    for (const text of [monitor.name, (${JSON.stringify(stateLabel)})[monitor.state], monitor.published ? 'Published' : 'Private']) {
      const cell = document.createElement('td'); cell.textContent = text; row.append(cell);
    }
    const actions = document.createElement('td');
    const group = document.createElement('div'); group.className = 'actions';
    const path = '/api/operator/monitors/' + encodeURIComponent(monitor.id);
    for (const [label, action] of (canEdit ? [
      ['Edit', () => edit(monitor)],
      [monitor.maintenance ? 'Replace Maintenance' : 'Declare Maintenance', () => declareMaintenance(monitor)],
      ...(monitor.maintenance ? [['End Maintenance', () => run(path + '/maintenance', 'DELETE', undefined, () => { maintenanceForm.hidden = true; })]] : []),
      [monitor.published ? 'Unpublish' : 'Publish', () => run(path, 'PATCH', { published: !monitor.published })],
      ['Delete', () => { if (confirm('Delete ' + monitor.name + '?')) run(path, 'DELETE', undefined, () => { if (editingId === monitor.id) cancelEdit(); if (maintenanceForm.dataset.monitorId === monitor.id) maintenanceForm.hidden = true; }); }]
    ] : [])) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
      button.setAttribute('aria-label', label + ' ' + monitor.name);
      button.addEventListener('click', action); group.append(button);
    }
    actions.append(group); row.append(actions); return row;
  });
  if (!rows.length) {
    const row = document.createElement('tr'); const cell = document.createElement('td');
    cell.colSpan = 4; cell.textContent = 'No Monitors'; row.append(cell); rows.push(row);
  }
  byId('monitor-rows').replaceChildren(...rows);
  const incidents = data.incidents.map(incident => {
    const item = document.createElement('li'); item.className = 'incident';
    const monitor = data.monitors.find(monitor => monitor.id === incident.monitorId);
    item.textContent = (monitor?.name || incident.monitorName || incident.monitorId) + (monitor ? '' : ' (deleted)') + ' — Unavailable since ' + new Date(incident.openedAt).toISOString() + (incident.closedAt === null ? ' — Ongoing' : ' — Recovered ' + new Date(incident.closedAt).toISOString());
    return item;
  });
  if (!incidents.length) { const item = document.createElement('li'); item.textContent = 'No Incidents'; incidents.push(item); }
  byId('incidents').replaceChildren(...incidents);
}
async function run(path = '/api/operator', method = 'GET', body, after) {
  if (busy) return;
  busy = true; message.textContent = '';
  document.querySelectorAll('button, input, select').forEach(control => { control.disabled = true; });
  try {
    const response = await fetch(path, {
      method, headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const data = await response.json();
    if (!response.ok) { if (response.status === 401) signOut(); throw new Error(data.error || 'Request failed'); }
    if (data.secret) { byId('heartbeat-credential').textContent = 'Bearer ' + data.secret; }
    else render(data);
    if (after) after();
    if (method !== 'GET') message.textContent = method === 'DELETE' ? (path.endsWith('/maintenance') ? 'Maintenance ended' : 'Deleted') : 'Saved';
  } catch (error) { message.textContent = error.message; }
  finally {
    busy = false;
    document.querySelectorAll('button, input, select').forEach(control => { control.disabled = false; });
    updateKind();
  }
}
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
  event.preventDefault(); secret = byId('secret').value;
  await run(); byId('secret').value = '';
  if (!editor.hidden) byId(byId('new-monitor').hidden ? 'refresh' : 'new-monitor').focus();
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  const body = { name: byId('name').value, kind: byId('kind').value, published: byId('published').checked };
  if (body.kind === 'tcp') { body.hostname = byId('hostname').value; body.port = Number(byId('port').value); }
  else if (body.kind === 'http') body.url = byId('url').value;
  for (const field of Object.keys(timingDefaults)) { if (!byId(field).disabled) body[field] = Number(byId(field).value); }
  await run('/api/operator/monitors' + (editingId ? '/' + encodeURIComponent(editingId) : ''), editingId ? 'PATCH' : 'POST', body, cancelEdit);
});
maintenanceForm.addEventListener('submit', async event => {
  event.preventDefault();
  await run('/api/operator/monitors/' + encodeURIComponent(maintenanceForm.dataset.monitorId) + '/maintenance', 'PUT', { endsAt: new Date(byId('maintenance-end').value).getTime() }, () => { maintenanceForm.hidden = true; });
});
byId('cancel-maintenance').addEventListener('click', () => { maintenanceForm.hidden = true; });
webhook.addEventListener('submit', async event => { event.preventDefault(); await run('/api/operator/webhook', 'PUT', { url: byId('webhookUrl').value }); });
pageForm.addEventListener('submit', async event => { event.preventDefault(); await run('/api/operator', 'PUT', { pageName: byId('pageName').value }); });
byId('new-monitor').addEventListener('click', () => edit());
byId('rotate-heartbeat').addEventListener('click', () => { if (confirm('Replace this Monitor’s heartbeat secret?')) run('/api/operator/monitors/' + encodeURIComponent(editingId) + '/heartbeat-secret', 'POST'); });
byId('cancel-edit').addEventListener('click', cancelEdit);
byId('refresh').addEventListener('click', () => run());
byId('logout').addEventListener('click', signOut);
`;
