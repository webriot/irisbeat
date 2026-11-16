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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><script src="/theme.js"></script><link rel="stylesheet" href="/app.css">${operator ? "" : '<meta http-equiv="refresh" content="60">'}</head><body><header><a class="brand" href="/">irisbeat</a><nav aria-label="Application"><a href="/"${operator ? "" : ' aria-current="page"'}>Status page</a><a href="/operator"${operator ? ' aria-current="page"' : ""}>Operator</a></nav></header><main>${body}</main><footer><a href="https://github.com/webriot/irisbeat/releases/download/v0.1.0/irisbeat-0.1.0-source.tar.gz">Source (AGPL-3.0-only)</a><label class="theme-control">Theme <select id="theme"><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label></footer></body></html>`;
}

function historyMarkup(history: AvailabilityHistory | null | undefined, id: string) {
  if (!history) return '<p class="history-unavailable">Bars unavailable</p>';
  return `<div class="availability"><div class="history-head"><span>90 UTC days</span><span class="percentage" aria-label="Availability">${history.percentage === null ? "No observations" : history.percentage.toFixed(2) + "%"}</span></div><ol class="history" data-monitor="${encodeURIComponent(id)}" aria-label="90 UTC days of availability">${history.days.map((day, index) => {
    const label = ({ empty: "No observations", up: "Successful checks", down: "Failed checks", degraded: "Mixed results", maintenance: "Maintenance" })[day.state] + "; " + day.successes + " successes, " + day.failures + " failures, " + day.maintenance + " Maintenance";
    return `<li class="history-day ${day.state}" data-date="${day.date}" data-detail="${label}" tabindex="${index === history.days.length - 1 ? 0 : -1}" aria-label="${day.date} UTC: ${label}"></li>`;
  }).join("")}</ol><p class="history-detail" role="status" aria-live="polite" aria-atomic="true"></p></div>`;
}

export function statusPage(status: Status) {
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
  return document(
    status.pageName,
    `<h1>${escape(status.pageName)}</h1>
    <section class="banner" data-state="${banner === "All services operational" ? "up" : banner === "Services unavailable" ? "down" : "unknown"}" aria-label="Current status"><h2>${escape(banner)}</h2></section>
    <div class="ledger">${status.monitors.map((monitor, index) => `<article aria-labelledby="monitor-name${index || ""}"><div class="ledger-row" data-state="${monitor.state}"><h2 id="monitor-name${index || ""}">${escape(monitor.name)}</h2><span class="status">${stateLabel[monitor.state]}</span></div>${historyMarkup(monitor.history, monitor.id)}</article>`).join("")}</div>
    ${status.monitors.length ? `<section aria-labelledby="incident-heading"><h2 id="incident-heading">Incidents</h2>${status.incidents.length ? `<ul class="incidents">${status.incidents.map((incident) => `<li><article class="incident"><strong>${escape(status.monitors.find(monitor => monitor.id === incident.monitorId)?.name ?? incident.monitorId)} — ${incident.closedAt === null ? "Open" : "Recovered"}</strong><p>Unavailable since ${time(incident.openedAt)}${incident.closedAt === null ? " — Ongoing" : ` — Recovered ${time(incident.closedAt)}`}</p></article></li>`).join("")}</ul>` : "<p>No Incidents</p>"}</section>` : ""}`,
  );
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

// Runs before the stylesheet to apply a saved preference before first paint.
export const themeScript = `
const selectedHistoryDays = new Map(Object.entries(history.state?.irisbeatDays || {}));
const instantFormat = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
const bucketFormat = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
function initializeDisplay() {
  document.querySelectorAll('time[datetime]').forEach(time => {
    time.textContent = instantFormat.format(new Date(time.dateTime));
  });
  document.querySelectorAll('.history').forEach(strip => {
    const days = [...strip.children];
    if (!days.length) return;
    const detail = strip.nextElementSibling;
    function select(day) {
      selectedHistoryDays.set(strip.dataset.monitor, day.dataset.date);
      if (!document.getElementById('login')) {
        try { history.replaceState({ ...history.state, irisbeatDays: Object.fromEntries(selectedHistoryDays) }, ''); } catch {}
      }
      days.forEach(item => {
        item.tabIndex = item === day ? 0 : -1;
        item.setAttribute('aria-current', String(item === day));
      });
      detail.textContent = day.getAttribute('aria-label');
    }
    days.forEach(day => {
      const start = new Date(day.dataset.date + 'T00:00:00Z');
      const end = new Date(start.getTime() + 86400000);
      const counts = day.dataset.detail;
      day.setAttribute('aria-label', bucketFormat.format(start) + ' UTC: ' + counts + ' · ' + instantFormat.format(start) + ' – ' + instantFormat.format(end) + ' (' + browserTimeZone + ')');
      day.onfocus = () => select(day);
      day.onclick = () => { select(day); day.focus(); };
      day.onkeydown = event => {
        const index = days.indexOf(day);
        const target = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: days.length - 1 }[event.key];
        if (target !== undefined) {
          event.preventDefault();
          days[Math.max(0, Math.min(days.length - 1, target))].focus();
        }
      };
    });
    const selected = selectedHistoryDays.get(strip.dataset.monitor);
    select(days.find(day => day.dataset.date === selected) || days.at(-1));
  });
}
let theme = 'system';
try {
  const saved = localStorage.getItem('irisbeat-theme');
  if (saved === 'light' || saved === 'dark') theme = saved;
} catch {}
document.documentElement.dataset.theme = theme;
document.addEventListener('DOMContentLoaded', () => {
  initializeDisplay();
  const control = document.getElementById('theme');
  control.value = theme;
  control.addEventListener('change', () => {
    theme = control.value;
    document.documentElement.dataset.theme = theme;
    try {
      if (theme === 'system') localStorage.removeItem('irisbeat-theme');
      else localStorage.setItem('irisbeat-theme', theme);
    } catch {}
  });
});
`;

export const styleSheet = `
:root {
  color-scheme: light; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif;
  --background: light-dark(#f5f7f8, #101417); --foreground: light-dark(#202b30, #e2eaed);
  --muted: light-dark(#596970, #99a9b1); --card: light-dark(#fff, #171e23);
  --secondary: light-dark(#edf1f3, #222c33); --line: light-dark(#d9e1e5, #35424a);
  --control-border: light-dark(#78868d, #788c98);
  --primary: light-dark(#245e66, #9bd4d6); --primary-foreground: light-dark(#fff, #142b30);
  --success: light-dark(#176744, #77d6ab); --success-surface: light-dark(#eaf6ef, #172e27);
  --danger: light-dark(#b42e3d, #ff96a0); --warning: light-dark(#825b0a, #eac16f);
  --info: light-dark(#6357a2, #b4a5ee); --radius: 12px;
  background: var(--background); color: var(--foreground);
}
@media (prefers-color-scheme: dark) { :root { color-scheme: dark; } }
:root[data-theme="light"] { color-scheme: light; }
:root[data-theme="dark"] { color-scheme: dark; }
* { box-sizing: border-box; }
body { max-width: 1088px; margin: auto; padding: 0 24px 32px; overflow-wrap: anywhere; }
header, nav, .ledger-row, .actions, footer { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
header, .ledger-row, footer { justify-content: space-between; }
header { padding: 20px 0; border-bottom: 1px solid var(--line); }
nav { gap: 6px; }
a { color: inherit; text-underline-offset: 4px; }
.brand { font-size: 20px; font-weight: 750; letter-spacing: -.6px; text-decoration: none; }
nav a { padding: 8px 10px; border-radius: 6px; color: var(--muted); text-decoration: none; }
nav a[aria-current="page"] { background: var(--secondary); color: var(--foreground); font-weight: 600; }
h1 { margin: 28px 0 24px; font-size: 28px; line-height: 1.2; letter-spacing: -.8px; font-weight: 650; }
h2 { margin: 0; font-size: 16px; font-weight: 650; }
.banner { padding: 18px 20px; margin-bottom: 24px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--card); color: var(--info); }
.banner[data-state="up"] { background: var(--success-surface); color: var(--success); border-color: color-mix(in srgb, var(--success) 24%, transparent); }
.banner[data-state="down"] { color: var(--danger); background: color-mix(in srgb, var(--danger) 8%, var(--card)); border-color: color-mix(in srgb, var(--danger) 30%, transparent); }
.ledger, table { border: 1px solid var(--line); border-radius: var(--radius); background: var(--card); margin-bottom: 28px; }
.ledger > article { padding: 18px 20px; }
.ledger > article + article { border-top: 1px solid var(--line); }
.ledger-row h2 { font-size: 15px; }
.status { font-size: 13px; color: var(--muted); }
.ledger-row[data-state="up"] .status, .status[data-state="up"] { color: var(--success); }
.ledger-row[data-state="down"] .status, .status[data-state="down"] { color: var(--danger); }
.ledger-row[data-state="maintenance"] .status, .status[data-state="maintenance"], .ledger-row[data-state="paused"] .status, .status[data-state="paused"] { color: var(--info); }
table { width: 100%; border-spacing: 0; margin-top: 20px; }
th, td { padding: 12px 16px; text-align: left; }
th { font-size: 12px; color: var(--muted); font-weight: 500; border-bottom: 1px solid var(--line); }
tbody tr:nth-child(even):not(:last-child) td { border-bottom: 1px solid var(--line); }
tbody tr:nth-child(odd) td { padding-bottom: 0; }
.availability { padding-top: 12px; min-width: 0; }
.percentage { font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
.history { position: relative; display: grid; grid-template-columns: repeat(90, minmax(0, 1fr)); gap: 3px; list-style: none; padding: 0; margin: 8px 0 0; }
.history-head { display: flex; justify-content: space-between; gap: 12px; font-size: 12px; }
.history-detail { color: var(--muted); font-size: 12px; line-height: 1.4; margin: 8px 0 0; min-height: 2.8em; }
.history-day[aria-current="true"] { outline: 2px solid var(--foreground); outline-offset: 2px; }
.history-day { cursor: pointer; height: 25px; border-radius: 2px; background: var(--secondary); }
.history-day.up { background: var(--success); }
.history-day.down { background: var(--danger); }
.history-day.degraded { background: var(--warning); }
.history-day.maintenance { background: var(--info); }
.history-day.empty { border: 1px dashed var(--line); }
.history-unavailable { color: var(--muted); font-size: 12px; }
.configuration-layout { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); gap: 20px; margin: 20px 0; align-items: start; }
form, aside { min-width: 0; }
#configuration, #maintenance, #webhook, aside, #login { border: 1px solid var(--line); border-radius: var(--radius); padding: 20px; background: var(--card); }
#configuration, #maintenance { background: var(--secondary); }
#maintenance { margin-bottom: 20px; }
fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
label { display: block; margin: 12px 0 6px; font-size: 13px; }
input, select, button { font: inherit; min-height: 40px; max-width: 100%; border: 1px solid var(--line); border-radius: 7px; background: var(--card); color: var(--foreground); }
input, select { width: 100%; padding: 8px 11px; border-color: var(--control-border); }
input:disabled, select:disabled { opacity: .65; }
.checkbox { display: flex; align-items: center; gap: 8px; }
input[type="checkbox"] { width: auto; accent-color: var(--primary); }
button { padding: 8px 13px; cursor: pointer; font-weight: 550; }
button:hover, summary:hover { background: var(--secondary); }
button:disabled { opacity: .5; cursor: wait; }
form button { margin-top: 16px; }
form button + button { margin-left: 8px; }
#webhook { margin-bottom: 28px; }
.ledger:empty { display: none; }
form button[type="submit"], form button:not([type]), #new-monitor { background: var(--primary); border-color: var(--primary); color: var(--primary-foreground); }
.text-button { border: 0; background: transparent; color: inherit; padding-left: 0; text-decoration: underline; text-underline-offset: 4px; }
:focus-visible { outline: 2px solid var(--primary); outline-offset: 3px; }
.incidents { list-style: none; padding: 0; margin: 12px 0 0; }
.incident { padding: 16px 0; border-top: 1px solid var(--line); }
.incident p { margin: 8px 0 0; color: var(--muted); font-size: 12px; }
.actions { justify-content: flex-start; margin-top: 20px; }
td .actions { margin: 0; gap: 6px; }
#login { max-width: 28rem; }
#paused { color: var(--info); }
#message:empty { display: none; }
footer { margin-top: 36px; padding-top: 18px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; }
.theme-control { display: flex; align-items: center; gap: 8px; margin: 0; }
.theme-control select { width: auto; }
/* Shared surfaces for operator action menus and inline panels. */
.menu { position: relative; }
summary { cursor: pointer; border-radius: 7px; padding: 8px 13px; }
.menu-items { position: absolute; right: 0; z-index: 5; width: 205px; padding: 5px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); box-shadow: 0 10px 30px #0002; }
.menu-items button { display: block; width: 100%; text-align: left; border: 0; }
button.danger { color: var(--danger); }
[hidden] { display: none !important; }
@media (max-width: 44rem) {
  body { padding: 0 16px 24px; }
  header { gap: 8px; }
  nav { gap: 0; }
  nav a { padding: 7px; }
  .brand { font-size: 18px; }
  h1 { margin: 24px 0 20px; font-size: 24px; }
  .banner { padding: 16px; }
  .ledger > article { padding: 16px 12px; }
  .history { gap: 2px; }
  .history-day { height: 23px; }
  table, thead, tbody, tr, td { display: block; }
  thead { position: absolute; clip-path: inset(100%); }
  th, td { padding: 8px 12px; }
  tbody tr:nth-child(odd) { padding-top: 8px; }
  tbody tr:nth-child(even) td { padding-bottom: 16px; }
  .configuration-layout { grid-template-columns: 1fr; gap: 16px; }
  footer { align-items: flex-start; }
}
`;

export const operatorScript = `
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
function localMinute(date) { return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
function declareMaintenance(monitor) {
  maintenanceForm.querySelector('label').textContent = 'End time (' + browserTimeZone + ')';
  maintenanceForm.dataset.monitorId = monitor.id;
  byId('maintenance-heading').textContent = monitor.name + ' — Maintenance';
  byId('save-maintenance').textContent = monitor.maintenance ? 'Replace Maintenance' : 'Declare Maintenance';
  const end = new Date(monitor.maintenance?.endsAt ?? Date.now() + 3600000);
  const input = byId('maintenance-end');
  input.value = localMinute(end);
  input.dataset.originalValue = input.value;
  input.dataset.originalInstant = String(end.getTime());
  input.setCustomValidity('');
  maintenanceForm.hidden = false; byId('maintenance-end').focus();
}
function signOut() {
  secret = ''; cancelEdit(); maintenanceForm.hidden = true; pageForm.reset(); webhook.reset(); editor.hidden = true; login.hidden = false;
  byId('monitor-rows').replaceChildren(); byId('incidents').replaceChildren();
  message.textContent = ''; byId('secret').value = ''; byId('secret').focus();
}
function render(data) {
  const focusedHistory = document.activeElement?.closest('.history')?.dataset.monitor;
  login.hidden = true; editor.hidden = false;
  hosted = !!data.hosted;
  byId('paused').hidden = !data.paused;
  const canEdit = data.permission !== 'reader';
  if (!canEdit) { cancelEdit(); maintenanceForm.hidden = true; }
  byId('new-monitor').hidden = !canEdit; pageForm.closest('aside').hidden = !canEdit; webhook.hidden = !canEdit;
  byId('pageName').value = data.pageName;
  byId('webhookUrl').value = data.webhookUrl || '';
  const rows = data.monitors.flatMap(monitor => {
    const row = document.createElement('tr');
    for (const text of [monitor.name, (${JSON.stringify(stateLabel)})[monitor.state], monitor.published ? 'Published' : 'Private']) {
      const cell = document.createElement('td'); cell.textContent = text;
      if (row.children.length === 1) { cell.className = 'status'; cell.dataset.state = monitor.state; }
      row.append(cell);
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
    actions.append(group); row.append(actions);
    const historyRow = document.createElement('tr');
    const availability = document.createElement('td'); availability.colSpan = 4;
    availability.setAttribute('aria-label', monitor.name + ' availability');
    availability.innerHTML = historyMarkup(monitor.history, monitor.id); historyRow.append(availability);
    return [row, historyRow];
  });
  if (!rows.length) {
    const row = document.createElement('tr'); const cell = document.createElement('td');
    cell.colSpan = 4; cell.textContent = 'No Monitors'; row.append(cell); rows.push(row);
  }
  byId('monitor-rows').replaceChildren(...rows);
  const incidents = data.incidents.map(incident => {
    const item = document.createElement('li'); item.className = 'incident';
    const monitor = data.monitors.find(monitor => monitor.id === incident.monitorId);
    item.append((monitor?.name || incident.monitorName || incident.monitorId) + (monitor ? '' : ' (deleted)') + ' — Unavailable since ');
    const appendTime = at => {
      const time = document.createElement('time'); time.dateTime = new Date(at).toISOString(); item.append(time);
    };
    appendTime(incident.openedAt);
    if (incident.closedAt === null) item.append(' — Ongoing');
    else { item.append(' — Recovered '); appendTime(incident.closedAt); }
    return item;
  });
  if (!incidents.length) { const item = document.createElement('li'); item.textContent = 'No Incidents'; incidents.push(item); }
  byId('incidents').replaceChildren(...incidents);
  initializeDisplay();
  if (focusedHistory) {
    const strip = [...document.querySelectorAll('.history')].find(strip => strip.dataset.monitor === focusedHistory);
    strip?.querySelector('[tabindex="0"]')?.focus();
  }
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
  const input = byId('maintenance-end');
  let endsAt = Number(input.dataset.originalInstant);
  if (input.value !== input.dataset.originalValue) {
    const end = new Date(input.value);
    // Offset changes around the entered day expose a second occurrence of the same local minute.
    const ambiguous = Number.isFinite(end.getTime()) && [-86400000, 86400000].some(delta => {
      const offsetChange = new Date(end.getTime() + delta).getTimezoneOffset() - end.getTimezoneOffset();
      return offsetChange !== 0 && localMinute(new Date(end.getTime() + offsetChange * 60000)) === input.value;
    });
    if (!Number.isFinite(end.getTime()) || localMinute(end) !== input.value || ambiguous) {
      input.setCustomValidity('Choose an unambiguous local time that exists in ' + browserTimeZone + '.');
      input.reportValidity();
      return;
    }
    endsAt = end.getTime();
  }
  await run('/api/operator/monitors/' + encodeURIComponent(maintenanceForm.dataset.monitorId) + '/maintenance', 'PUT', { endsAt }, () => { maintenanceForm.hidden = true; });
});
byId('maintenance-end').addEventListener('input', event => event.target.setCustomValidity(''));
byId('cancel-maintenance').addEventListener('click', () => { maintenanceForm.hidden = true; });
webhook.addEventListener('submit', async event => { event.preventDefault(); await run('/api/operator/webhook', 'PUT', { url: byId('webhookUrl').value }); });
pageForm.addEventListener('submit', async event => { event.preventDefault(); await run('/api/operator', 'PUT', { pageName: byId('pageName').value }); });
byId('new-monitor').addEventListener('click', () => edit());
byId('rotate-heartbeat').addEventListener('click', () => { if (confirm('Replace this Monitor’s heartbeat secret?')) run('/api/operator/monitors/' + encodeURIComponent(editingId) + '/heartbeat-secret', 'POST'); });
byId('cancel-edit').addEventListener('click', cancelEdit);
byId('refresh').addEventListener('click', () => run());
byId('logout').addEventListener('click', signOut);
`;
