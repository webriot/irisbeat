// SPDX-License-Identifier: AGPL-3.0-only
/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */

export function ApiKeySettings() {
  return <section id="api-key-settings" aria-labelledby="api-keys-heading" hidden>
    <div class="operator-heading"><h2 id="api-keys-heading">API keys</h2><button id="new-api-key" type="button">New API key</button></div>
    <ul id="api-key-rows" aria-label="API keys"></ul>
    <p id="no-api-keys" hidden>No API keys</p>
    <p id="api-key-list-error" role="status" hidden></p><button id="retry-api-keys" type="button" hidden>Retry</button>

    <dialog id="api-key-issue" class="operator-dialog" aria-labelledby="api-key-issue-heading">
      <h2 id="api-key-issue-heading">New API key</h2>
      <form id="api-key-form" autocomplete="off">
        <label for="api-key-name">Key name</label><input id="api-key-name" required maxlength={120} />
        <div class="api-key-fields">
          <div><label for="api-key-role">Role</label><select id="api-key-role"><option value="read">Read</option><option value="write">Write</option></select></div>
          <div><label for="api-key-expiry">Expires on (UTC, optional)</label><input id="api-key-expiry" type="date" /></div>
        </div>
        <p id="api-key-issue-error" class="api-key-feedback" role="status"></p>
        <button id="issue-api-key" type="submit">Issue API key</button><button id="cancel-api-key" type="button">Cancel</button>
      </form>
      <div id="api-key-disclosure" hidden>
        <label for="api-key-secret">API key secret</label><input id="api-key-secret" readonly autocomplete="off" spellcheck={false} />
        <p>Shown only once. Copy the key before closing.</p>
        <div class="actions"><button id="copy-api-key" type="button">Copy key</button><button id="done-api-key" type="button">Done</button></div>
        <p id="api-key-copy-status" class="api-key-feedback" role="status"></p>
      </div>
    </dialog>

    <dialog id="api-key-revoke" class="operator-dialog" aria-labelledby="api-key-revoke-heading" aria-describedby="api-key-revoke-impact">
      <h2 id="api-key-revoke-heading"></h2>
      <p id="api-key-revoke-impact">Integrations using this key will lose access.</p>
      <form id="api-key-revoke-form">
        <p id="api-key-revoke-error" class="api-key-feedback" role="status"></p>
        <button id="cancel-api-key-revoke" type="button">Cancel</button><button id="revoke-api-key" class="danger" type="submit">Revoke key</button>
      </form>
    </dialog>
  </section>;
}

export const apiKeySettingsStyles = `
#api-key-settings { margin-top: 24px; }
#api-key-rows { list-style: none; padding: 0; margin: 12px 0 0; }
#api-key-rows li { border-top: 1px solid var(--line); padding: 12px 0; }
#api-key-rows li > div { min-width: 0; overflow-wrap: anywhere; }
.api-key-meta { display: flex; gap: 4px 12px; flex-wrap: wrap; color: var(--muted); font-size: 13px; margin-top: 4px; }
#api-key-settings .operator-dialog { padding: 20px; }
#api-key-settings .operator-dialog h2 { margin-top: 0; overflow-wrap: anywhere; }
.api-key-fields { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: 12px; }
#api-key-secret { font-family: ui-monospace, monospace; }
#revoke-api-key { background: var(--danger); border-color: var(--danger); color: light-dark(white, #261319); }
.api-key-feedback:empty { margin: 0; }
@media (max-width: 400px) { .api-key-fields { grid-template-columns: minmax(0, 1fr); gap: 0; } }
`;

export const apiKeySettingsScript = `
function createApiKeySettings(session) {
  const settings = byId('api-key-settings');
  if (!settings) return;
  const rows = byId('api-key-rows');
  const newKey = byId('new-api-key');
  const issue = byId('api-key-issue');
  const revoke = byId('api-key-revoke');
  const form = byId('api-key-form');
  const name = byId('api-key-name');
  const expiry = byId('api-key-expiry');
  const disclosure = byId('api-key-disclosure');
  const secret = byId('api-key-secret');
  const copy = byId('copy-api-key');
  const copyStatus = byId('api-key-copy-status');
  const cancelRevoke = byId('cancel-api-key-revoke');
  const listError = byId('api-key-list-error');
  const retry = byId('retry-api-keys');
  const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'UTC' });
  let scope;
  let keys = [];
  let selected;
  let busy = false;
  let disclosureVersion = 0;

  function timestamp(label, value) {
    const text = document.createElement('span');
    const time = document.createElement('time');
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) {
      time.dateTime = date.toISOString();
      time.textContent = dateFormat.format(date) + ' UTC';
      text.append(label + ' ', time);
    } else {
      text.textContent = label + ' ' + value + ' ms since epoch';
    }
    return text;
  }

  function renderKeys() {
    rows.replaceChildren(...keys.map(key => {
      const row = document.createElement('li');
      row.className = 'ledger-row';
      const details = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = key.name;
      const meta = document.createElement('div');
      meta.className = 'api-key-meta';
      const role = document.createElement('span');
      role.textContent = key.role === 'write' ? 'Write' : 'Read';
      const expiration = key.expiresAt === null ? document.createElement('span') :
        timestamp(key.expiresAt <= Date.now() ? 'Expired' : 'Expires', key.expiresAt);
      if (key.expiresAt === null) expiration.textContent = 'No expiry';
      meta.append(role, expiration, timestamp('Issued', key.createdAt));
      details.append(title, meta);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'danger';
      button.textContent = 'Revoke';
      button.setAttribute('aria-label', 'Revoke ' + key.name);
      button.onclick = () => {
        selected = key;
        byId('api-key-revoke-heading').textContent = 'Revoke ' + key.name + '?';
        button.focus();
        revoke.showModal();
        cancelRevoke.focus();
      };
      row.append(details, button);
      return row;
    }));
    byId('no-api-keys').hidden = keys.length !== 0;
  }

  async function load() {
    const signal = scope.signal;
    newKey.disabled = true;
    listError.hidden = retry.hidden = true;
    try {
      const result = await session.requestApiKeys('GET', signal);
      if (!result || signal.aborted) return;
      keys = result.keys;
      renderKeys();
      newKey.disabled = false;
      if (document.activeElement === document.body) newKey.focus();
    } catch {
      if (signal.aborted) return;
      listError.textContent = 'API keys unavailable';
      listError.hidden = retry.hidden = false;
      if (document.activeElement === document.body) retry.focus();
    }
  }

  function closeIssue() {
    disclosureVersion++;
    secret.value = '';
    copyStatus.textContent = '';
    issue.close();
    disclosure.hidden = true;
    form.hidden = false;
    form.reset();
    name.setCustomValidity('');
    expiry.setCustomValidity('');
    byId('api-key-issue-error').textContent = '';
    byId('api-key-issue-heading').textContent = 'New API key';
    if (!settings.hidden) newKey.focus();
  }

  function closeRevoke() {
    selected = undefined;
    revoke.close();
    byId('api-key-revoke-heading').textContent = '';
    byId('api-key-revoke-error').textContent = '';
  }

  function setActive(active) {
    settings.hidden = !active;
    if (active && !scope) {
      scope = new AbortController();
      load();
    } else if (!active && scope) {
      scope.abort();
      scope = undefined;
      busy = false;
      issue.removeAttribute('aria-busy');
      revoke.removeAttribute('aria-busy');
      closeIssue();
      closeRevoke();
      keys = [];
      rows.replaceChildren();
      byId('no-api-keys').hidden = listError.hidden = retry.hidden = true;
    }
  }

  async function mutate(dialog, error, method, body, id) {
    const signal = scope.signal;
    busy = true;
    dialog.setAttribute('aria-busy', 'true');
    error.textContent = '';
    try {
      return await session.requestApiKeys(method, signal, body, id);
    } catch (failure) {
      if (!signal.aborted) error.textContent = failure.message;
    } finally {
      if (!signal.aborted) {
        busy = false;
        dialog.removeAttribute('aria-busy');
      }
    }
  }

  newKey.onclick = () => {
    expiry.min = new Date().toISOString().slice(0, 10);
    issue.showModal();
    name.focus();
  };
  retry.onclick = load;
  name.oninput = () => name.setCustomValidity('');
  expiry.oninput = () => expiry.setCustomValidity('');
  form.onsubmit = async event => {
    event.preventDefault();
    if (busy) return;
    const keyName = name.value.trim();
    const expiresAt = expiry.value ? expiry.valueAsNumber + 86399999 : undefined;
    name.setCustomValidity(keyName ? '' : 'Enter a key name.');
    expiry.setCustomValidity(expiresAt === undefined || expiresAt > Date.now() ? '' : 'Choose a future expiry.');
    if (!form.reportValidity()) return;
    const signal = scope.signal;
    const issued = await mutate(issue, byId('api-key-issue-error'), 'POST', { name: keyName, role: byId('api-key-role').value, expiresAt });
    if (!issued || signal.aborted || !issue.open) return;
    keys.unshift(issued.key);
    renderKeys();
    form.hidden = true;
    byId('api-key-issue-heading').textContent = 'Copy your API key';
    secret.value = issued.secret;
    disclosure.hidden = false;
    copy.focus();
  };

  copy.onclick = async () => {
    const version = disclosureVersion;
    let copied = false;
    try {
      await navigator.clipboard.writeText(secret.value);
      copied = true;
    } catch {
      if (version !== disclosureVersion) return;
      secret.focus();
      secret.select();
      try { copied = document.execCommand('copy'); } catch {}
    }
    if (version !== disclosureVersion) return;
    copyStatus.textContent = copied ? 'Copied' : 'Use your device’s copy command.';
    if (copied && document.activeElement === secret) copy.focus();
  };
  byId('cancel-api-key').onclick = () => { if (!busy) closeIssue(); };
  byId('done-api-key').onclick = closeIssue;
  issue.oncancel = event => { event.preventDefault(); if (!busy) closeIssue(); };
  cancelRevoke.onclick = () => { if (!busy) closeRevoke(); };
  revoke.oncancel = event => { event.preventDefault(); if (!busy) closeRevoke(); };
  byId('api-key-revoke-form').onsubmit = async event => {
    event.preventDefault();
    if (busy || !selected) return;
    const { id } = selected;
    const signal = scope.signal;
    const result = await mutate(revoke, byId('api-key-revoke-error'), 'DELETE', undefined, id);
    if (result !== null || signal.aborted) return;
    keys = keys.filter(key => key.id !== id);
    closeRevoke();
    renderKeys();
    newKey.focus();
  };
  return { setActive };
}
`;
