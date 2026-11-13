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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>${operator ? "" : '<meta http-equiv="refresh" content="60">'}</head><body><main>${body}</main></body></html>`;
}

export function statusPage(status: Status) {
  const time = (at: number) =>
    `<time datetime="${new Date(at).toISOString()}">${new Date(at).toISOString()}</time>`;
  return document(
    status.pageName,
    `<h1>${escape(status.pageName)}</h1>${
      status.monitor
        ? `
    <h2>${escape(status.monitor.name)}</h2><p>${stateLabel[status.monitor.state]}</p>
    <h2>Incidents</h2>${status.incidents.length ? `<ul>${status.incidents.map((incident) => `<li>Unavailable since ${time(incident.openedAt)}${incident.closedAt === null ? " — Ongoing" : ` — Recovered ${time(incident.closedAt)}`}</li>`).join("")}</ul>` : "<p>No Incidents</p>"}`
        : "<p>No Monitor configured</p>"
    }
    <a href="/operator">Operator</a>`,
  );
}

export function operatorPage() {
  return document(
    "Irisbeat operator",
    `<h1>Irisbeat operator</h1>
    <form id="login"><label for="secret">Installation secret</label><input id="secret" type="password" required autocomplete="current-password"><button>Sign in</button></form>
    <section id="editor" hidden><form id="configuration">
      <p><label for="pageName">Page name</label><input id="pageName" name="pageName" required maxlength="120"></p>
      <p><label for="name">Monitor name</label><input id="name" name="name" required maxlength="120"></p>
      <p><label for="url">HTTP(S) target</label><input id="url" name="url" type="url" required maxlength="2048"></p>
      <button>Save</button></form><button id="refresh" type="button">Refresh</button><button id="logout" type="button">Sign out</button>
      <h2>Monitor</h2><p id="state"></p><h2>Incidents</h2><ul id="incidents"></ul></section>
    <p id="message" role="status" aria-live="polite"></p><a href="/">Status page</a>
    <script src="/operator.js" defer></script>`,
    true,
  );
}

export const operatorScript = `
const login = document.getElementById('login');
const editor = document.getElementById('editor');
const form = document.getElementById('configuration');
const message = document.getElementById('message');
let secret = '';
async function load(method = 'GET') {
  message.textContent = '';
  try {
    const response = await fetch('/api/operator', {
      method, headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
      ...(method === 'PUT' ? { body: JSON.stringify(Object.fromEntries(new FormData(form))) } : {})
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Request failed');
    login.hidden = true;
    editor.hidden = false;
    document.getElementById('pageName').value = data.pageName;
    document.getElementById('name').value = data.monitor?.name || '';
    document.getElementById('url').value = data.monitor?.url || '';
    document.getElementById('state').textContent = data.monitor ? ({ unknown: 'Awaiting check', up: 'Operational', down: 'Unavailable' })[data.monitor.state] : 'No Monitor configured';
    document.getElementById('incidents').replaceChildren(...data.incidents.map(incident => {
      const item = document.createElement('li');
      item.textContent = 'Unavailable since ' + new Date(incident.openedAt).toISOString() + (incident.closedAt === null ? ' — Ongoing' : ' — Recovered ' + new Date(incident.closedAt).toISOString());
      return item;
    }));
    if (method === 'PUT') message.textContent = 'Saved';
  } catch (error) { message.textContent = error.message; }
}
login.addEventListener('submit', async event => {
  event.preventDefault(); secret = document.getElementById('secret').value;
  await load(); document.getElementById('secret').value = '';
  if (!editor.hidden) document.getElementById('pageName').focus();
});
form.addEventListener('submit', async event => { event.preventDefault(); await load('PUT'); });
document.getElementById('refresh').addEventListener('click', () => load());
document.getElementById('logout').addEventListener('click', () => {
  secret = ''; form.reset(); editor.hidden = true; login.hidden = false;
  document.getElementById('state').textContent = '';
  document.getElementById('incidents').replaceChildren(); message.textContent = '';
  document.getElementById('secret').focus();
});
`;
