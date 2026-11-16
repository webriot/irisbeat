// SPDX-License-Identifier: AGPL-3.0-only
import type { AvailabilityHistory, Status } from "./index";
import { timeMarkup } from "./ui-presentation";
export { presentationScript } from "./ui-presentation";

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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><script src="/theme.js"></script><link rel="stylesheet" href="/app.css"><script src="/presentation.js" defer></script></head><body><header><a class="brand" href="/">irisbeat</a><nav aria-label="Application"><a href="/"${operator ? "" : ' aria-current="page"'}>Status page</a><a href="/operator"${operator ? ' aria-current="page"' : ""}>Operator</a></nav></header><main>${body}</main><footer><a href="https://github.com/webriot/irisbeat/releases/download/v0.1.0/irisbeat-0.1.0-source.tar.gz">Source (AGPL-3.0-only)</a><label class="theme-control">Theme <select id="theme"><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label></footer></body></html>`;
}

function historyMarkup(history: AvailabilityHistory | null | undefined, monitorId: string) {
  if (!history) return '<p class="history-unavailable">Bars unavailable</p>';
  const labels = { up: "Operational", down: "Failed checks", degraded: "Mixed results", maintenance: "Maintenance", empty: "No observations" };
  return `<div class="availability"><span>90 UTC days</span> <span class="percentage" aria-label="Availability">${history.percentage === null ? "No observations" : history.percentage.toFixed(2) + "%"}</span><ol class="history" data-history-id="${encodeURIComponent(monitorId)}" aria-label="90 UTC days of availability">${history.days.map((day, index) => {
    const summary = labels[day.state] + "; " + day.successes + " successes, " + day.failures + " failures, " + day.maintenance + " Maintenance";
    const label = day.date + " UTC: " + summary;
    return `<li data-key="${day.date}"><button type="button" class="history-day ${day.state}" data-date="${day.date}" data-summary="${summary}" tabindex="${index === history.days.length - 1 ? 0 : -1}" aria-label="${label}" aria-pressed="${index === history.days.length - 1}"></button></li>`;
  }).join("")}</ol><p class="history-detail" role="status" aria-live="polite"></p></div>`;
}

function statusMarkup(status: Status, time: typeof timeMarkup) {
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
    <section class="banner" data-state="${banner === "All services operational" ? "up" : banner === "Services unavailable" ? "down" : "unknown"}" aria-label="Current status"><h2>${escape(banner)}</h2></section>
    <div id="public-monitors" class="ledger">${status.monitors.map((monitor, index) => `<article data-key="${escape(monitor.id)}" aria-labelledby="monitor-name${index || ""}"><div class="ledger-row" data-state="${monitor.state}"><h2 id="monitor-name${index || ""}">${escape(monitor.name)}</h2><span class="status">${stateLabel[monitor.state]}</span></div>${historyMarkup(monitor.history, monitor.id)}</article>`).join("")}</div>
    ${status.monitors.length ? `<section aria-labelledby="incident-heading"><h2 id="incident-heading">Incidents</h2>${status.incidents.length ? `<ul class="incidents">${status.incidents.map((incident) => `<li data-key="${escape(incident.id)}"><article class="incident"><strong>${escape(status.monitors.find(monitor => monitor.id === incident.monitorId)?.name ?? incident.monitorId)} — ${incident.closedAt === null ? "Open" : "Recovered"}</strong><p>Unavailable since ${time(incident.openedAt)}${incident.closedAt === null ? " — Ongoing" : ` — Recovered ${time(incident.closedAt)}`}</p></article></li>`).join("")}</ul>` : "<p>No Incidents</p>"}</section>` : ""}`;
}

export function statusPage(status: Status) {
  return document(status.pageName, `<div id="public-status">${statusMarkup(status, timeMarkup)}</div><button id="refresh" type="button">Refresh</button><span id="stale" role="status" hidden>Updates unavailable</span><script src="/status.js" defer></script>`);
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

// Runs before the stylesheet to apply a saved preference before first paint.
export const themeScript = `
let theme = 'system';
try {
  const saved = localStorage.getItem('irisbeat-theme');
  if (saved === 'light' || saved === 'dark') theme = saved;
} catch {}
document.documentElement.dataset.theme = theme;
document.addEventListener('DOMContentLoaded', () => {
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
.history-detail { min-height: 4.2em; margin: 8px 0; color: var(--muted); font-size: 12px; line-height: 1.4; }
.history-day { display: block; width: 100%; min-height: 25px; height: 25px; padding: 0; border: 0; border-radius: 2px; background: var(--secondary); }
.history-day[aria-pressed="true"] { outline: 2px solid currentColor; outline-offset: 2px; }
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
        const interactive = name => name === 'open' || (node.closest('.history') && ['tabindex', 'aria-current', 'aria-selected', 'aria-pressed', 'aria-label'].includes(name));
        for (const attribute of [...node.attributes]) if (!interactive(attribute.name) && !fresh.hasAttribute(attribute.name)) node.removeAttribute(attribute.name);
        for (const attribute of [...fresh.attributes]) if (!interactive(attribute.name) && node.getAttribute(attribute.name) !== attribute.value) node.setAttribute(attribute.name, attribute.value);
        if (fresh.onclick) node.onclick = fresh.onclick;
        // Presentation refreshes localized text after patching its source attributes.
        if (!node.matches('time[datetime], .history-detail')) reconcile(node, fresh);
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
const timeMarkup = ${timeMarkup.toString()};
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
    const desired = document.createElement('div'); desired.innerHTML = statusMarkup(data, timeMarkup);
    reconcile(document.getElementById('public-status'), desired);
    window.IrisbeatPresentation.initialize(document.getElementById('public-status'));
    document.title = data.pageName;
    document.getElementById('stale').hidden = true;
  } catch { if (id === requestId) document.getElementById('stale').hidden = false; }
}
document.getElementById('refresh').addEventListener('click', refresh);
pollVisible(refresh);
`;

export const operatorScript = `
${refreshScript}
const timeMarkup = ${timeMarkup.toString()};
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
  document.querySelector('label[for="maintenance-end"]').textContent = 'End time (' + Intl.DateTimeFormat().resolvedOptions().timeZone + ')';
  byId('maintenance-end').value = new Date(end.getTime() - end.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  updateMissing();
  maintenanceForm.hidden = false; byId('maintenance-end').focus();
}
function signOut() {
  session++; requestId++; busy = false; hydrated = false; monitors = []; canEdit = false; hosted = false; byId('stale').hidden = true;
  secret = ''; window.IrisbeatPresentation.clear(); cancelEdit(); maintenanceForm.reset(); delete maintenanceForm.dataset.monitorId; byId('maintenance-heading').textContent = 'Maintenance'; byId('paused').hidden = true; maintenanceForm.hidden = true; pageForm.reset(); webhook.reset(); editor.hidden = true; login.hidden = false;
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
    availability.innerHTML = historyMarkup(monitor.history, monitor.id); historyRow.append(availability);
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
    item.append((monitor?.name || incident.monitorName || incident.monitorId) + (monitor ? '' : ' (deleted)') + ' — Unavailable since ');
    const timestamps = document.createElement('span');
    timestamps.innerHTML = timeMarkup(incident.openedAt) + (incident.closedAt === null ? ' — Ongoing' : ' — Recovered ' + timeMarkup(incident.closedAt));
    item.append(timestamps);
    return item;
  });
  if (!incidents.length) { const item = document.createElement('li'); item.textContent = 'No Incidents'; incidents.push(item); }
  const desiredIncidents = document.createElement('ul'); desiredIncidents.append(...incidents);
  reconcile(byId('incidents'), desiredIncidents);
  window.IrisbeatPresentation.initialize(editor);
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
