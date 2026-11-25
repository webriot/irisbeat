// SPDX-License-Identifier: AGPL-3.0-only
import { operatorPage, styleSheet, themeScript } from '../../src/ui';

// Throwaway #112 design. Compare inline, dialog and dedicated on /operator?variant=.
const markup = `
<section id="api-key-prototype" aria-label="API key settings">
  <div id="demo-entry" class="operator-heading" hidden>
    <h2>API keys</h2><button id="demo-manage" type="button">Manage API keys</button>
  </div>
  <div id="demo-view">
    <div class="operator-heading">
      <h2 id="demo-inventory-heading" tabindex="-1">API keys</h2>
      <div class="demo-actions">
        <button id="demo-back" type="button" hidden>Back to Settings</button>
        <button id="demo-new" type="button">New API key</button>
      </div>
    </div>
    <div id="demo-inline"></div>
    <ul id="demo-keys" aria-label="API keys"></ul>
    <p id="demo-empty" hidden>No API keys</p>
  </div>
  <div id="demo-dedicated" hidden></div>
  <dialog id="demo-issue-dialog" aria-labelledby="demo-issue-heading"></dialog>
  <div id="demo-issue" class="demo-panel" hidden>
    <h2 id="demo-issue-heading" tabindex="-1">New API key</h2>
    <form id="demo-form" aria-labelledby="demo-issue-heading">
      <label for="demo-name">Key name</label>
      <input id="demo-name" name="name" required maxlength="120">
      <div class="demo-fields">
        <div><label for="demo-role">Role</label>
        <select id="demo-role" name="role"><option value="read">Read</option><option value="write">Write</option></select></div>
        <div><label for="demo-expiry">Expires on (optional)</label>
        <input id="demo-expiry" name="expiry" type="date"></div>
      </div>
      <button type="submit">Issue API key</button><button id="demo-cancel" type="button">Cancel</button>
    </form>
    <div id="demo-receipt" hidden></div>
  </div>
  <dialog id="demo-revoke-dialog" aria-labelledby="demo-revoke-heading">
    <form class="demo-panel" method="dialog">
      <h2 id="demo-revoke-heading"></h2>
      <p>Integrations using this key will lose access.</p>
      <div class="demo-actions">
        <button value="cancel" type="submit" autofocus>Cancel</button>
        <button value="revoke" type="submit">Revoke key</button>
      </div>
    </form>
  </dialog>
  <nav id="demo-switcher" aria-label="Prototype variants">
    <button id="demo-previous" type="button" aria-label="Previous variant">←</button>
    <span id="demo-variant" aria-live="polite"></span>
    <button id="demo-next" type="button" aria-label="Next variant">→</button>
  </nav>
</section>
`;

export const prototypeStyles = `
#api-key-prototype { margin: 24px 0; }
#api-key-prototype:has(#demo-dedicated:not([hidden]), #demo-back:not([hidden])) { margin-top: 0; }
#demo-keys { padding: 0; margin: 12px 0 0; list-style: none; }
#demo-keys li { border-top: 1px solid var(--line); padding: 12px 0; }
#demo-keys li > div { min-width: 0; }
.demo-meta { display: flex; gap: 4px 12px; flex-wrap: wrap; color: var(--muted); font-size: 13px; margin-top: 3px; }
.demo-panel { border: 1px solid var(--line); border-radius: var(--radius); padding: clamp(12px, 4vw, 20px); background: var(--card); }
#demo-inline > .demo-panel { margin-top: 12px; }
.demo-fields { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: 12px; }
.demo-actions { display: flex; gap: 8px; flex-wrap: wrap; }
#demo-receipt input { font-family: ui-monospace, monospace; }
#demo-receipt .demo-actions { margin-top: 12px; }
#demo-copy-feedback { margin-bottom: 0; }
#demo-copy-feedback:empty { display: none; }
#api-key-prototype dialog { width: min(480px, calc(100% - 32px)); padding: 0; border: 1px solid var(--line); border-radius: var(--radius); background: var(--card); color: var(--foreground); }
#api-key-prototype dialog::backdrop { background: #0008; }
#api-key-prototype dialog .demo-panel { border: 0; }
#demo-revoke-dialog button { margin: 0; }
#demo-revoke-dialog button[value="revoke"] { background: var(--danger); border-color: var(--danger); color: light-dark(white, #261319); }
#demo-switcher { position: fixed; z-index: 10; bottom: 12px; left: 50%; transform: translateX(-50%); flex-wrap: nowrap; justify-content: space-between; width: min(260px, calc(100vw - 24px)); padding: 4px; border-radius: 999px; background: #19323b; color: #fff; box-shadow: 0 4px 18px #0005; }
#demo-switcher button { min-width: 40px; padding: 4px; border: 0; border-radius: 50%; background: #35515a; color: #fff; }
#demo-switcher button:hover { background: #4a6570; }
#demo-switcher button:focus-visible { outline-color: white; }
body:has(#settings:not([hidden]) #demo-switcher) { padding-bottom: 76px; }
@media (max-width: 400px) { .demo-fields { grid-template-columns: minmax(0, 1fr); gap: 0; } }
`;

export const prototypeScript = String.raw`
(() => {
  const byId = id => document.getElementById(id);
  const settings = byId('settings');
  const editor = byId('editor');
  const title = byId('operator-title');
  const prototype = byId('api-key-prototype');
  const siblings = [...settings.children].filter(section => section !== prototype);
  const names = { inline: 'Inline', dialog: 'Dialog', dedicated: 'Dedicated view' };
  const variants = Object.keys(names);
  let variant = new URLSearchParams(location.search).get('variant');
  if (!variants.includes(variant)) variant = 'inline';
  const initialKeys = [
    { name: 'Status dashboard', role: 'read', expiry: '' },
    { name: 'Terraform CI', role: 'write', expiry: '2099-01-31' },
  ];
  let keys = [...initialKeys];
  let manage = false;
  let pendingRevoke;
  const inventory = byId('demo-keys');
  const issue = byId('demo-issue');
  const issueHeading = byId('demo-issue-heading');
  const issueDialog = byId('demo-issue-dialog');
  const revokeDialog = byId('demo-revoke-dialog');
  const form = byId('demo-form');
  const receipt = byId('demo-receipt');
  const nameInput = byId('demo-name');
  const newButton = byId('demo-new');
  const manageButton = byId('demo-manage');
  const dateFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' });

  function showInventory() {
    inventory.replaceChildren();
    for (const key of keys) {
      const row = document.createElement('li');
      row.className = 'ledger-row';
      const details = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = key.name;
      const metadata = document.createElement('div');
      metadata.className = 'demo-meta';
      const role = document.createElement('span');
      role.textContent = key.role === 'write' ? 'Write' : 'Read';
      const expiry = document.createElement('span');
      expiry.textContent = key.expiry ? 'Expires ' + dateFormat.format(new Date(key.expiry)) : 'No expiry';
      metadata.append(role, expiry);
      details.append(name, metadata);
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'danger';
      revoke.textContent = 'Revoke';
      revoke.setAttribute('aria-label', 'Revoke ' + key.name);
      revoke.onclick = () => {
        pendingRevoke = key;
        byId('demo-revoke-heading').textContent = 'Revoke ' + key.name + '?';
        revokeDialog.returnValue = '';
        revokeDialog.showModal();
      };
      row.append(details, revoke);
      inventory.append(row);
    }
    byId('demo-empty').hidden = keys.length > 0;
  }

  function showLayout() {
    const dedicated = variant === 'dedicated' && manage;
    const fullForm = dedicated && !issue.hidden;
    siblings.forEach(section => { section.hidden = dedicated; });
    if (!settings.hidden) title.textContent = dedicated ? 'API keys' : 'Settings';
    byId('demo-entry').hidden = variant !== 'dedicated' || dedicated;
    byId('demo-view').hidden = (variant === 'dedicated' && !dedicated) || fullForm;
    byId('demo-inventory-heading').classList.toggle('sr-only', dedicated);
    byId('demo-back').hidden = !dedicated;
    newButton.disabled = !issue.hidden;
    byId('demo-dedicated').hidden = !fullForm;
    byId('demo-variant').textContent = 'Prototype · ' + names[variant];
  }

  function closeIssue(restoreFocus = true) {
    if (issueDialog.open) issueDialog.close();
    issue.hidden = true;
    receipt.replaceChildren();
    receipt.hidden = true;
    form.hidden = false;
    form.reset();
    nameInput.setCustomValidity('');
    showLayout();
    if (restoreFocus) newButton.focus();
  }

  function openIssue() {
    const target = { inline: byId('demo-inline'), dialog: issueDialog, dedicated: byId('demo-dedicated') };
    target[variant].append(issue);
    issueHeading.textContent = 'New API key';
    issue.hidden = false;
    showLayout();
    if (variant === 'dialog') issueDialog.showModal();
    nameInput.focus();
  }

  form.onsubmit = event => {
    event.preventDefault();
    const name = nameInput.value.trim();
    nameInput.setCustomValidity(name ? '' : 'Enter a key name.');
    if (!form.reportValidity()) return;
    keys.unshift({ name, role: byId('demo-role').value, expiry: byId('demo-expiry').value });
    showInventory();
    form.hidden = true;
    issueHeading.textContent = 'Copy your API key';
    receipt.innerHTML = '<label for="demo-secret">API key secret</label><input id="demo-secret" readonly>' +
      '<p>Copy this key before closing. It’s shown only once.</p>' +
      '<div class="demo-actions"><button id="demo-copy" type="button">Copy key</button>' +
      '<button id="demo-done" type="button">Done</button></div><p id="demo-copy-feedback" role="status"></p>';
    const secret = byId('demo-secret');
    const copy = byId('demo-copy');
    const bytes = crypto.getRandomValues(new Uint8Array(18));
    secret.value = 'demo_' + Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
    receipt.hidden = false;
    copy.onclick = async () => {
      const feedback = byId('demo-copy-feedback');
      let copied = false;
      try {
        await navigator.clipboard.writeText(secret.value);
        copied = true;
      } catch {
        if (!secret.isConnected) return;
        secret.focus();
        secret.select();
        try { copied = document.execCommand('copy'); } catch {}
      }
      if (!secret.isConnected) return;
      copy.textContent = copied ? 'Copied' : 'Copy key';
      feedback.textContent = copied ? '' : 'Use your device’s copy command.';
      if (copied) copy.focus();
    };
    byId('demo-done').onclick = () => closeIssue();
    copy.focus();
  };
  nameInput.oninput = () => nameInput.setCustomValidity('');
  byId('demo-cancel').onclick = () => closeIssue();
  issueDialog.oncancel = event => {
    event.preventDefault();
    closeIssue();
  };
  revokeDialog.onclose = () => {
    if (revokeDialog.returnValue === 'revoke' && pendingRevoke) {
      keys = keys.filter(key => key !== pendingRevoke);
      showInventory();
      newButton.focus();
    }
    pendingRevoke = undefined;
  };

  newButton.onclick = openIssue;
  manageButton.onclick = () => {
    manage = true;
    showLayout();
    title.focus();
  };
  byId('demo-back').onclick = () => {
    manage = false;
    showLayout();
    manageButton.focus();
  };

  function switchVariant(step) {
    manage = false;
    variant = variants[(variants.indexOf(variant) + step + variants.length) % variants.length];
    closeIssue(false);
    const url = new URL(location.href);
    url.searchParams.set('variant', variant);
    try { history.replaceState(history.state, '', url); } catch {}
  }
  byId('demo-previous').onclick = () => switchVariant(-1);
  byId('demo-next').onclick = () => switchVariant(1);
  document.addEventListener('keydown', event => {
    if (settings.hidden || issueDialog.open || revokeDialog.open || event.defaultPrevented ||
        event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
        event.target.closest('input, textarea, select, [contenteditable]')) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    switchVariant(event.key === 'ArrowLeft' ? -1 : 1);
  });
  new MutationObserver(() => {
    if (!settings.hidden) return;
    manage = false;
    if (editor.hidden) {
      keys = [...initialKeys];
      showInventory();
    }
    closeIssue(false);
  }).observe(settings, { attributes: true, attributeFilter: ['hidden'] });
  showInventory();
  showLayout();
})();
`;

export function prototypePage(offline = false) {
  const shell = operatorPage();
  const operatorScript = '<script src="/operator.js?live=2" defer=""></script>';
  if (!shell.includes(operatorScript)) throw new Error('Operator script tag changed');
  const content = shell.replace(
    '</ul></section></section><div class="actions">',
    '</ul></section>' + markup + '</section><div class="actions">',
  );
  if (content === shell) throw new Error('Operator Settings shell changed');
  if (!offline) {
    return content
      .replace('</head>', '<link rel="stylesheet" href="/__ui/api-key-prototype.css"></head>')
      .replace(operatorScript, operatorScript + '<script src="/__ui/api-key-prototype.js" defer></script>');
  }
  return content
    .replace('<script src="/theme.js?live=2"></script>', '<script>' + themeScript + '</script>')
    .replace('<link rel="stylesheet" href="/app.css"/>',
      () => '<style>' + styleSheet + prototypeStyles + ':root { background: transparent; } body { padding-inline: 0; }</style>')
    .replace(operatorScript, () => '<script>' + captureScript + prototypeScript + '</script>');
}

const captureScript = `
document.querySelector('header').inert = true;
document.getElementById('login').hidden = true;
document.getElementById('workspace').hidden = true;
document.getElementById('editor').hidden = false;
document.getElementById('editor').querySelector(':scope > .actions').hidden = true;
const captureSettings = document.getElementById('settings');
captureSettings.hidden = false;
document.getElementById('pageName').value = 'Irisbeat status';
captureSettings.querySelectorAll(':scope > section:not(#api-key-prototype)').forEach(section => {
  section.inert = true;
});
`;
