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
};
function document(title: string, body: string, operator = false) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><link rel="stylesheet" href="/app.css">${operator ? "" : '<meta http-equiv="refresh" content="60">'}</head><body><header><a class="brand" href="/">irisbeat</a><nav aria-label="Application"><a href="/"${operator ? "" : ' aria-current="page"'}>Status page</a><a href="/operator"${operator ? ' aria-current="page"' : ""}>Operator</a></nav></header><main>${body}</main></body></html>`;
}

export function statusPage(status: Status) {
  const time = (at: number) =>
    `<time datetime="${new Date(at).toISOString()}">${new Date(at).toISOString()}</time>`;
  const banner = !status.monitor
    ? "No Monitor configured"
    : status.monitor.state === "down"
      ? `${status.monitor.name} is unavailable`
      : status.monitor.state === "up"
        ? "All services operational"
        : "Awaiting check";
  return document(
    status.pageName,
    `<h1>${escape(status.pageName)}</h1>
    <section class="banner" aria-label="Current status"><h2>${escape(banner)}</h2></section>
    ${
      status.monitor
        ? `<article aria-labelledby="monitor-name"><div class="ledger-row"><h2 id="monitor-name">${escape(status.monitor.name)}</h2><span class="status">${stateLabel[status.monitor.state]}</span></div></article>
    <section aria-labelledby="incident-heading"><h2 id="incident-heading">Incidents</h2>${status.incidents.length ? `<ul class="incidents">${status.incidents.map((incident) => `<li><article class="incident"><strong>${incident.closedAt === null ? "Open" : "Recovered"}</strong><p>Unavailable since ${time(incident.openedAt)}${incident.closedAt === null ? " — Ongoing" : ` — Recovered ${time(incident.closedAt)}`}</p></article></li>`).join("")}</ul>` : "<p>No Incidents</p>"}</section>`
        : ""
    }`,
  );
}

export function operatorPage() {
  return document(
    "Irisbeat operator",
    `<h1>Monitors</h1>
    <form id="login"><label for="secret">Installation secret</label><input id="secret" type="password" required autocomplete="current-password"><button>Sign in</button></form>
    <section id="editor" hidden>
      <table aria-label="Monitors"><thead><tr><th scope="col">Monitor</th><th scope="col">State</th></tr></thead><tbody><tr><td><button id="monitor-link" class="text-button" type="button">Configure Monitor</button></td><td id="state"></td></tr></tbody></table>
      <form id="configuration" class="configuration-layout">
        <section aria-labelledby="monitor-settings"><h2 id="monitor-settings">Monitor configuration</h2>
          <label for="name">Monitor name</label><input id="name" name="name" required maxlength="120">
          <label for="kind">Check type</label><select id="kind" name="kind"><option value="http">HTTP(S)</option><option value="tcp">TCP</option></select>
          <fieldset id="http-target"><label for="url">HTTP(S) target</label><input id="url" name="url" type="url" required maxlength="2048"></fieldset>
          <fieldset id="tcp-target" hidden disabled><label for="hostname">Hostname</label><input id="hostname" name="hostname" required maxlength="253" autocapitalize="none" spellcheck="false">
          <label for="port">Port</label><input id="port" name="port" type="number" min="1" max="65535" step="1" required></fieldset>
          <label for="intervalSeconds">Interval (seconds)</label><input id="intervalSeconds" name="intervalSeconds" type="number" min="60" max="86400" step="1" value="60" required>
          <label for="timeoutSeconds">Timeout (seconds)</label><input id="timeoutSeconds" name="timeoutSeconds" type="number" min="1" max="60" step="1" value="10" required>
          <label for="failureThreshold">Consecutive failures</label><input id="failureThreshold" name="failureThreshold" type="number" min="1" max="100" step="1" value="2" required>
          <label for="recoveryThreshold">Consecutive successes</label><input id="recoveryThreshold" name="recoveryThreshold" type="number" min="1" max="100" step="1" value="2" required>
        </section>
        <aside aria-labelledby="page-settings"><h2 id="page-settings">Status page</h2>
          <label for="pageName">Page name</label><input id="pageName" name="pageName" required maxlength="120">
        </aside>
        <div><button>Save configuration</button></div>
      </form>
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
const login = document.getElementById('login');
const editor = document.getElementById('editor');
const form = document.getElementById('configuration');
const message = document.getElementById('message');
const webhook = document.getElementById('webhook');
let secret = '';
function showTarget() {
  const tcp = document.getElementById('kind').value === 'tcp';
  for (const [id, active] of [['http-target', !tcp], ['tcp-target', tcp]]) {
    const fields = document.getElementById(id);
    fields.hidden = !active; fields.disabled = !active;
  }
}
document.getElementById('kind').addEventListener('change', showTarget);
const timingDefaults = { intervalSeconds: 60, timeoutSeconds: 10, failureThreshold: 2, recoveryThreshold: 2 };
async function load(method = 'GET') {
  message.textContent = '';
  try {
    const configuration = Object.fromEntries(new FormData(form));
    if (configuration.kind === 'tcp') configuration.port = Number(configuration.port);
    for (const field of Object.keys(timingDefaults)) configuration[field] = Number(configuration[field]);
    const response = await fetch('/api/operator', {
      method, headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
      ...(method === 'PUT' ? { body: JSON.stringify(configuration) } : {})
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Request failed');
    login.hidden = true;
    editor.hidden = false;
    document.getElementById('webhookUrl').value = data.webhookUrl || '';
    document.getElementById('pageName').value = data.pageName;
    document.getElementById('name').value = data.monitor?.name || '';
    document.getElementById('kind').value = data.monitor?.kind || 'http';
    document.getElementById('url').value = data.monitor?.url || '';
    document.getElementById('hostname').value = data.monitor?.hostname || '';
    document.getElementById('port').value = data.monitor?.port || '';
    showTarget();
    for (const [field, value] of Object.entries(timingDefaults)) {
      document.getElementById(field).value = data.monitor?.[field] ?? value;
    }
    document.getElementById('monitor-link').textContent = data.monitor?.name || 'Configure Monitor';
    document.getElementById('state').textContent = data.monitor ? (${JSON.stringify(stateLabel)})[data.monitor.state] : 'No Monitor configured';
    const incidents = data.incidents.map(incident => {
      const item = document.createElement('li');
      item.className = 'incident';
      item.textContent = 'Unavailable since ' + new Date(incident.openedAt).toISOString() + (incident.closedAt === null ? ' — Ongoing' : ' — Recovered ' + new Date(incident.closedAt).toISOString());
      return item;
    });
    if (!incidents.length) { const item = document.createElement('li'); item.textContent = 'No Incidents'; incidents.push(item); }
    document.getElementById('incidents').replaceChildren(...incidents);
    if (method === 'PUT') message.textContent = 'Saved';
  } catch (error) { message.textContent = error.message; }
}
login.addEventListener('submit', async event => {
  event.preventDefault(); secret = document.getElementById('secret').value;
  await load(); document.getElementById('secret').value = '';
  if (!editor.hidden) document.getElementById('name').focus();
});
webhook.addEventListener('submit', async event => {
  event.preventDefault(); message.textContent = '';
  try {
    const response = await fetch('/api/operator/webhook', {
      method: 'PUT', headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(new FormData(webhook)))
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Request failed');
    document.getElementById('webhookUrl').value = data.webhookUrl || '';
    message.textContent = data.webhookUrl ? 'Webhook saved' : 'Webhook removed';
  } catch (error) { message.textContent = error.message; }
});
form.addEventListener('submit', async event => { event.preventDefault(); await load('PUT'); });
document.getElementById('monitor-link').addEventListener('click', () => document.getElementById('name').focus());
document.getElementById('refresh').addEventListener('click', () => load());
document.getElementById('logout').addEventListener('click', () => {
  secret = ''; form.reset(); showTarget(); webhook.reset(); editor.hidden = true; login.hidden = false;
  document.getElementById('monitor-link').textContent = 'Configure Monitor';
  document.getElementById('state').textContent = '';
  document.getElementById('incidents').replaceChildren(); message.textContent = '';
  document.getElementById('secret').focus();
});
`;
