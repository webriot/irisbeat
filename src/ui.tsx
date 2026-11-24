// SPDX-License-Identifier: AGPL-3.0-only
/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import type { MonitoringContext, Status } from "./index";
import { createOperatorSession } from "./operator-session";
import { createMonitorEditor } from "./monitor-editor";
import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import { createStatusLedger, monitorActions } from "./status-ledger";
import { historyRetryAttempts, historyRetryInterval } from "./availability-history";

import { mergeScopes, type ViewAudience, type ViewScope } from "./view-changes";

const statusLedger = createStatusLedger();
export type StatusProjection = ReturnType<MonitoringContext["project"]>;
type ViewMonitor = StatusProjection["monitors"][number];

function PublicBanner({ data }: { data: Status }) {
  const label = statusLedger.banner(data);
  return <section class="banner" data-state={label === "All services operational" ? "up" : label === "Services unavailable" ? "down" : "unknown"} aria-label="Current status"><h2>{label}</h2></section>;
}

function PageHeading({ name }: { name: string }) {
  return <h1>{name}</h1>;
}

function PublicRows({ monitors }: { monitors: ViewMonitor[] }) {
  return <>{monitors.map(monitor => <PublicRow monitor={monitor} />)}</>;
}

function Paused({ paused }: { paused: boolean }) {
  return <h2 id="paused" hidden={!paused}>Monitoring paused</h2>;
}

function PublicIncidents({ data }: { data: Status }) {
  return <section id="public-incidents" hidden={!data.monitors.length} aria-labelledby="incident-heading"><h2 id="incident-heading">Incidents</h2>{raw(statusLedger.incidents(data))}</section>;
}

function scheduleDuration(seconds: number) {
  for (const [factor, unit] of [[86400, "d"], [3600, "h"], [60, "min"]] as const) {
    if (seconds % factor === 0) return `${seconds / factor} ${unit}`;
  }
  return `${seconds} s`;
}

function operatorSchedule(monitor: ViewMonitor, floor: number) {
  if (!("scheduleMode" in monitor)) return "";
  if (monitor.scheduleSuspensionFloorSeconds !== undefined) {
    const suspendedAt = monitor.scheduleSuspensionFloorSeconds;
    return `Suspended (${scheduleDuration(suspendedAt)} minimum${suspendedAt === floor ? "" : " at suspension"})`;
  }
  if (monitor.scheduleMode === "calendar") return "Calendar";
  if (monitor.kind === "heartbeat") return "Watchdog";
  const saved = monitor.intervalSeconds ?? floor;
  const effective = monitor.effectiveIntervalSeconds ?? saved;
  return `Every ${scheduleDuration(effective)}${saved === effective ? "" : ` (saved ${scheduleDuration(saved)})`}`;
}

function OperatorRows({ monitors, canEdit, floor }: { monitors: ViewMonitor[]; canEdit: boolean; floor: number }) {
  if (!monitors.length) return <tr><td colSpan={5}>No Monitors</td></tr>;
  return <>{monitors.map(monitor => <>
    <tr data-key={monitor.id}>
      <td>{monitor.name}</td><td class="status" data-state={monitor.state}>{statusLedger.stateLabel[monitor.state]}</td><td>{operatorSchedule(monitor, floor)}</td><td>{"published" in monitor && monitor.published ? "Published" : "Private"}</td>
      <td><div class="monitor-actions" id={`actions-${monitor.id}`} role="group" aria-label={`Actions ${monitor.name}`}>
        {canEdit && monitorActions({ published: "published" in monitor && monitor.published }).map(({ key, label, icon }) =>
          <button type="button" data-key={key} class={key === "delete" ? "monitor-action danger" : "monitor-action"} title={label} aria-label={`${label} ${monitor.name}`}>
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d={icon} /></svg><span class="action-label" aria-hidden="true">{label}</span>
          </button>)}
      </div></td>
    </tr>
    <tr data-key={`${monitor.id}:history`}><td colSpan={5} id={`history-${monitor.id}`} aria-label={`${monitor.name} availability`}>{raw(statusLedger.history(monitor.history, monitor.id, monitor.historyRetryToken))}</td></tr>
  </>)}</>;
}

function PublicRow({ monitor }: { monitor: ViewMonitor }) {
  const heading = `monitor-name-${monitor.id}`;
  return <article data-key={monitor.id} aria-labelledby={heading}>
    <div class="ledger-row" data-state={monitor.state}><h2 id={heading}>{monitor.name}</h2><span class="status">{statusLedger.stateLabel[monitor.state]}</span></div>
    {raw(statusLedger.history(monitor.history, monitor.id, monitor.historyRetryToken))}
  </article>;
}

function DestinationRows({ destinations, emailConfigured }: { destinations: NonNullable<Status["destinations"]>; emailConfigured: boolean }) {
  return <>{destinations.map(destination => {
    const email = destination.channel === "email";
    const value = email ? destination.address : destination.url;
    const submission = destination.latestSubmission;
    return <li data-key={destination.id}>
      <div class="destination-details">
        <div class="destination-address">{value}</div>
        {email && <div>{destination.confirmed ? "Confirmed" : "Pending confirmation"}</div>}
        {submission && <div class="destination-submission">
          <span>{statusLedger.submissionLabel(submission)}</span>{" · "}
          <time datetime={new Date(submission.at).toISOString()}>{new Date(submission.at).toISOString()}</time>
        </div>}
      </div>
      <div class="destination-actions">{statusLedger.destinationActions(destination, emailConfigured).map(label =>
        <button type="button" id={label === "Replace" ? `replace-${destination.id}` : undefined} data-action={label}
          class={label === "Remove" ? "danger" : undefined} aria-label={`${label} ${value}`}>{label}</button>)}</div>
    </li>;
  })}</>;
}

export function renderViewPartial(scope: ViewScope, data: StatusProjection, audience: ViewAudience, emailConfigured: boolean) {
  const operator = audience !== "public";
  switch (scope) {
    case "page": return { html: String(<PageHeading name={data.pageName} />), ...(operator ? { pageName: data.pageName } : {}) };
    case "banner": return { html: operator ? String(<Paused paused={data.paused} />) : String(<PublicBanner data={data} />) };
    case "incidents": return { html: operator ? statusLedger.incidents(data, true) : String(<PublicIncidents data={data} />) };
    case "destinations": return { html: String(<DestinationRows destinations={data.destinations ?? []} emailConfigured={emailConfigured} />), destinations: data.destinations ?? [], emailConfigured,
      selections: data.monitors.map(({ id, destinationIds }) => ({ id, destinationIds })) };
    default: {
      const all = scope === "monitors";
      const html = operator
        ? (data.monitors.length || all ? String(<OperatorRows monitors={data.monitors} canEdit={audience === "editor"} floor={data.minCheckIntervalSeconds ?? 60} />) : "")
        : String(<PublicRows monitors={data.monitors} />);
      return { html, ...(operator ? { monitors: data.monitors.map(({ history: _history, historyRetryToken: _token, ...monitor }) => monitor), minCheckIntervalSeconds: data.minCheckIntervalSeconds } : {}) };
    }
  }
}

function PublicContent({ data }: { data: StatusProjection }) {
  return <><PageHeading name={data.pageName} /><PublicBanner data={data} />
    <div class="ledger"><PublicRows monitors={data.monitors} /></div><PublicIncidents data={data} /></>;
}

export function statusJson(data: StatusProjection) {
  const monitors = data.monitors.map(({ historyRetryToken: _token, historyRevision: _revision, ...monitor }:
    ViewMonitor & { historyRevision?: number }) => monitor);
  return { ...data, monitors, monitor: monitors[0] ?? null };
}

export function renderViewSnapshot(data: StatusProjection, audience: ViewAudience, emailConfigured: boolean) {
  if (audience === "public") return { pageName: data.pageName, html: String(<PublicContent data={data} />) };
  const scopes: ViewScope[] = ["page", "banner", "monitors", "incidents", "destinations"];
  return { partials: scopes.map(scope => ({ scope, data: renderViewPartial(scope, data, audience, emailConfigured) })) };
}


function Document({ title, operator = false, children }: { title: string; operator?: boolean; children: Child }) {
  return <html lang="en"><head>
    <meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>{title}</title><script src="/theme.js?live=2"></script><link rel="stylesheet" href="/app.css" />
  </head><body>
    <header><a class="brand" href="/">irisbeat</a><nav aria-label="Application">
      <a href="/" aria-current={operator ? undefined : "page"}>Status page</a>
      <a href="/operator" aria-current={operator ? "page" : undefined}>Operator</a>
    </nav></header>
    <main><div class="page-clock"><time id="page-clock"></time></div><div id="stale" hidden><span>Updates unavailable</span><button id="retry" type="button">Retry</button></div>{children}<span id="sync-announcement" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></span>{!operator && <span id="updates-mode" role="status">Polling</span>}</main>
    <footer><a href="https://github.com/webriot/irisbeat/releases/download/v0.4.3/irisbeat-0.4.3-source.tar.gz">Source (AGPL-3.0-only)</a>
      <label class="theme-control">Theme <select id="theme"><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
    </footer>
  </body></html>;
}

export function statusPage(status: StatusProjection) {
  return "<!doctype html>" + <Document title={status.pageName}><div id="public-status"><PublicContent data={status} /></div></Document>;
}

export const recipientAction = {
  confirm: {
    path: "/notifications/confirm", title: "Confirm email notifications", button: "Confirm email",
    success: "Email confirmed", invalid: "Confirmation link is invalid or expired",
  },
  unsubscribe: {
    path: "/notifications/unsubscribe", title: "Unsubscribe from email notifications", button: "Unsubscribe",
    success: "Email unsubscribed", invalid: "Unsubscribe link is invalid",
  },
};

export function recipientPage(action: keyof typeof recipientAction, accepted?: boolean) {
  const page = recipientAction[action];
  const title = accepted === undefined ? page.title : accepted ? page.success : page.invalid;
  return "<!doctype html>" + <html lang="en"><head>
    <meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>{title}</title><link rel="stylesheet" href="/app.css" />
  </head><body><main>
    <h1>{title}</h1>
    {accepted === undefined && <>
      <form method="post" action={page.path} data-invalid={page.invalid}>
        <input type="hidden" name="token" /><button disabled>{page.button}</button>
      </form>
      <script src={page.path + ".js"} defer></script>
    </>}
  </main></body></html>;
}

export const recipientScript = `
const form = document.querySelector('form');
const token = location.hash.slice(1);
const button = form.querySelector('button');
if (/^[a-f0-9-]{36}$/.test(token)) {
  form.elements.token.value = token;
  button.disabled = false;
} else {
  document.querySelector('h1').textContent = form.dataset.invalid;
  form.hidden = true;
}
`;

function DurationControl({ field, label, min, max, value }: { field: string; label: string; min: number; max: number; value: number }) {
  return <fieldset class="duration"><label for={field}>{label}</label><div class="duration-value"><input id={field} name={field} type="number" min={min} max={max} step="any" value={value} data-duration="" required /><select id={field + "-unit"} aria-label={label + " unit"}><option value="seconds">Seconds</option><option value="minutes">Minutes</option><option value="hours">Hours</option><option value="days">Days</option></select></div></fieldset>;
}

function Operator({ hosted }: { hosted: boolean }) {
  return <>
    <div class="operator-heading"><h1 id="operator-title" tabindex={-1}>Monitors</h1><div id="operator-navigation" hidden><button id="new-monitor" type="button">New Monitor</button><button id="settings-button" type="button">Settings</button><button id="back-monitors" type="button" hidden>Monitors</button></div></div>
    <form id="login"><label for="secret">{hosted ? "Access token" : "Installation secret"}</label><input id="secret" type="password" required autocomplete="current-password" /><button>Sign in</button></form>
    <section id="editor" hidden>
      <Paused paused={false} />
      <div id="workspace">
        <div id="new-monitor-panel"></div>
      <table aria-label="Monitors"><colgroup><col class="monitor-column" /><col class="state-column" /><col class="schedule-column" /><col class="publication-column" /><col class="actions-column" /></colgroup><thead><tr><th scope="col">Monitor</th><th scope="col">State</th><th scope="col">Schedule</th><th scope="col">Publication</th><th scope="col">Actions</th></tr></thead><tbody id="monitor-rows"></tbody></table>
      <dialog id="maintenance-dialog" aria-labelledby="maintenance-heading"><form id="maintenance" hidden aria-labelledby="maintenance-heading">
        <h2 id="maintenance-heading">Maintenance</h2>
        <label for="maintenance-end">End time</label><input id="maintenance-end" type="datetime-local" required />
        <p id="maintenance-deleted" role="status" hidden>This Monitor was deleted. Copy your draft or cancel.</p><p id="maintenance-error" role="status"></p><button id="save-maintenance">Start Maintenance</button><button id="end-maintenance" type="button" class="danger" hidden>End Maintenance</button><button id="cancel-maintenance" type="button">Cancel</button>
      </form></dialog>

        <form id="configuration" hidden aria-labelledby="monitor-settings">
          <h2 id="monitor-settings">New Monitor</h2>
          <label for="name">Monitor name</label><input id="name" name="name" required maxlength={120} />
          <label for="kind">Check type</label><select id="kind" name="kind"><option value="http">HTTP(S)</option><option value="tcp">TCP</option><option value="heartbeat">Heartbeat</option></select>
          <output id="heartbeat-path"></output>
          <button id="rotate-heartbeat" type="button" hidden>Rotate heartbeat secret</button>
          <output id="heartbeat-credential"></output>
          <fieldset id="http-target"><label for="url">HTTP(S) target</label><input id="url" name="url" type="url" required maxlength={2048} /></fieldset>
          <fieldset id="tcp-target" hidden disabled><label for="hostname">Hostname</label><input id="hostname" name="hostname" required maxlength={253} autocapitalize="none" spellcheck={false} />
          <label for="port">Port</label><input id="port" name="port" type="number" min="1" max="65535" step="1" required /></fieldset>
          <fieldset id="schedule-mode"><label for="scheduleMode">Schedule</label><select id="scheduleMode" name="scheduleMode"><option value="interval">Interval</option><option value="calendar">Calendar</option></select></fieldset>
          <fieldset id="calendar-schedule" hidden disabled>
            <label for="cron">Cron</label><input id="cron" name="cron" value="0 9 * * *" maxlength={256} required autocapitalize="none" spellcheck={false} />
            <label for="timezone">Timezone</label><input id="timezone" name="timezone" value="UTC" maxlength={100} required autocapitalize="none" spellcheck={false} />
            <output id="schedule-explanation" aria-live="polite"></output>
            <ol id="schedule-occurrences" aria-label="Next three occurrences"></ol>
          </fieldset>
          <DurationControl field="intervalSeconds" label="Interval" min={60} max={86400} value={60} />
          <DurationControl field="timeoutSeconds" label="Timeout" min={1} max={60} value={10} />
          <label for="failureThreshold">Consecutive failures</label><input id="failureThreshold" name="failureThreshold" type="number" min="1" max="100" step="1" value="2" required />
          <label for="recoveryThreshold">Consecutive successes</label><input id="recoveryThreshold" name="recoveryThreshold" type="number" min="1" max="100" step="1" value="2" required />
          <DurationControl field="graceSeconds" label="Grace" min={1} max={86400} value={30} />
          <DurationControl field="silenceSeconds" label="Silence" min={60} max={86400} value={180} />
          <DurationControl field="recoverySpacingSeconds" label="Recovery spacing" min={60} max={86400} value={60} />
          <label class="checkbox" for="published"><input id="published" name="published" type="checkbox" checked />Published</label>
          <fieldset id="destination-selection" hidden><legend tabindex={-1}>Notification destinations</legend>
            <div id="destination-choices"></div><p id="no-destination-choices">No destinations</p>
          </fieldset>
          <p id="monitor-deleted" role="status" hidden>This Monitor was deleted. Copy your draft or cancel.</p><button id="save-monitor">Save Monitor</button><button id="resume-schedule" hidden>Save and Resume</button><button id="cancel-edit" type="button">Cancel</button>
        </form>
      <section aria-labelledby="incident-heading"><h2 id="incident-heading">Incidents</h2><div id="incidents"></div></section>
      </div>
      <section id="settings" hidden>
        <section aria-labelledby="page-settings"><h2 id="page-settings">Status page</h2>
          <form id="page-configuration"><label for="pageName">Page name</label><input id="pageName" name="pageName" required maxlength={120} /><button>Save page</button></form>
        </section>
        <section aria-labelledby="destinations-heading">
          <div class="operator-heading"><h2 id="destinations-heading">Notification destinations</h2><div class="destination-actions"><button id="add-email" type="button" hidden>Add email</button><button id="add-webhook" type="button">Add webhook</button></div></div>
          <form id="webhook" hidden aria-label="Add webhook">
            <label for="destination-address" id="destination-address-label">HTTPS webhook URL</label><input id="destination-address" name="address" type="url" required maxlength={2048} autocomplete="off" />
            <p id="webhook-impact" hidden></p>
            <p id="destination-missing" role="status" hidden>This destination was removed or replaced. Copy your draft or cancel.</p>
            <button id="save-webhook">Save webhook</button><button id="cancel-webhook" type="button">Cancel</button>
          </form>
          <p id="no-destinations">No destinations</p>
          <ul id="destination-rows" aria-label="Notification destinations"></ul>
        </section>
      </section>
      <div class="actions"><span id="updates-mode" role="status">Polling</span><button id="logout" type="button">Sign out</button></div>
    </section>
    <p id="message" role="status" aria-live="polite"></p>
    <script src="/operator.js?live=2" defer></script>
  </>;
}

export function operatorPage(hosted = false) {
  return "<!doctype html>" + <Document title="Irisbeat operator" operator><Operator hosted={hosted} /></Document>;
}

// Runs before the stylesheet to apply a saved preference before first paint.
export const themeScript = `
const viewMediaType = "application/vnd.irisbeat.view+json";
const mergeScopes = (${mergeScopes.toString()});
function reconcile(parent, next, only) {
  const key = node => node.nodeType === 1 ? node.getAttribute('data-key') || node.getAttribute('data-date') : null;
  // Inline forms own their drafts and stay attached while snapshot siblings change.
  const old = [...parent.childNodes].filter(node => node.nodeName !== 'FORM' && (!only || only.includes(key(node))));
  const identities = new Set([...next.childNodes].map(key).filter(Boolean));
  old.forEach(node => { if (key(node) && !identities.has(key(node))) node.remove(); });
  const used = new Set();
  [...next.childNodes].forEach((fresh, index) => {
    const identity = key(fresh);
    const current = identity ? old.find(node => key(node) === identity) : old[index];
    let node = fresh;
    if (current && !used.has(current) && current.nodeType === fresh.nodeType && current.nodeName === fresh.nodeName && key(current) === identity) {
      node = current; used.add(node);
      if (node.nodeType === 3) { if (node.textContent !== fresh.textContent) node.textContent = fresh.textContent; }
      else {
        const preserve = name => name === 'open' || (node.classList.contains('history-day') && ['tabindex', 'aria-current', 'aria-label'].includes(name));
        for (const attr of [...node.attributes]) if (!preserve(attr.name) && !fresh.hasAttribute(attr.name)) node.removeAttribute(attr.name);
        for (const attr of fresh.attributes) if (!preserve(attr.name) && node.getAttribute(attr.name) !== attr.value) node.setAttribute(attr.name, attr.value);
        node.onclick = fresh.onclick;
        if (!node.classList.contains('history-detail') && node.tagName !== 'TIME') reconcile(node, fresh);
      }
    }
    if (only) {
      if (node !== current) parent.insertBefore(node, current || null);
    } else if (parent.childNodes[index] !== node) parent.insertBefore(node, parent.childNodes[index] || null);
  });
  old.forEach(node => { if (!used.has(node)) node.remove(); });
}
function reconcileNodes(parent, nodes) {
  const next = document.createElement('div'); next.append(...nodes); reconcile(parent, next);
}
let retryHadFocus = false;
function snapshotPending(pending) {
  const retry = document.getElementById('retry');
  if (pending && !retry.disabled) retryHadFocus = retry === document.activeElement;
  if (pending && !document.getElementById('stale').hidden) document.getElementById('sync-announcement').textContent = 'Retrying updates';
  retry.disabled = pending;
  if (!pending) {
    if (!document.getElementById('stale').hidden) {
      document.getElementById('sync-announcement').textContent = 'Updates unavailable';
      if (retryHadFocus && document.activeElement === document.body) retry.focus();
    }
    retryHadFocus = false;
  }
  retry.textContent = pending ? 'Retrying…' : 'Retry';
}
function snapshotFailure(failed) {
  const stale = document.getElementById('stale');
  const announcement = document.getElementById('sync-announcement');
  const recovered = !failed && !stale.hidden;
  if (recovered && (stale.contains(document.activeElement) || (retryHadFocus && document.activeElement === document.body))) {
    const heading = document.querySelector('h1');
    heading.tabIndex = -1; heading.focus();
  }
  stale.hidden = !failed;
  announcement.textContent = failed ? 'Updates unavailable' : recovered ? 'Updates restored' : announcement.textContent;
}
function partialURL(base, scope, revision) {
  return base + '/partials/' + scope + '?revision=' + revision;
}
function fragment(html) {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content;
}
function liveSnapshots(path, read, authorize, viewPermission) {
  let running, queued, ackSocket, publicRead;
  let socket, retry, handshake, renewal, polling, historyTimer, stopped = false, ready = false, delay = 1000;
  let minimumRevision = 0;
  const historyAttempts = new Map();
  const historyAttemptCount = id => historyAttempts.get(id)?.count ?? 0;
  function historyRows() {
    const rows = new Map([...document.querySelectorAll('[data-history-retry]')]
      .map(node => [node.dataset.historyRetry, node.dataset.historyToken]));
    for (const [id, attempt] of historyAttempts)
      if (!rows.has(id) || rows.get(id) !== attempt.token) historyAttempts.delete(id);
    return [...rows].filter(([id]) => historyAttemptCount(id) < ${historyRetryAttempts})
      .sort(([a], [b]) => historyAttemptCount(a) - historyAttemptCount(b)).slice(0, 32);
  }
  function scheduleHistory() {
    if (!ready || stopped || document.hidden) {
      clearTimeout(historyTimer); historyTimer = undefined;
    } else if (!historyTimer && historyRows().length) {
      historyTimer = setTimeout(() => {
        historyTimer = undefined;
        if (!ready || stopped || document.hidden) return;
        if (!running) {
          const rows = historyRows();
          for (const [id, token] of rows) historyAttempts.set(id, { token, count: historyAttemptCount(id) + 1 });
          if (rows.length) enqueue({ revision: minimumRevision, scopes: rows.map(([id]) => 'monitor/' + id), history: true });
        }
        scheduleHistory();
      }, ${historyRetryInterval});
    }
  }
  function pollingMode() {
    const mode = document.getElementById('updates-mode');
    if (mode) mode.hidden = ready;
    if (ready || document.hidden || stopped) { clearInterval(polling); polling = undefined; }
    else if (!polling) polling = setInterval(sync, 60000);
    scheduleHistory();
  }
  function sync(hint) { enqueue(hint || { full: true }); }
  async function enqueue(request) {
    if (stopped) return;
    if (running) {
      const previous = queued || running;
      queued = previous.history ? request : request.full || previous.full ? { full: true } : {
        revision: Math.max(previous.revision, request.revision),
        scopes: mergeScopes(previous.scopes, request.scopes),
      };
      return;
    }
    running = request;
    const source = socket;
    const controller = publicRead = authorize ? undefined : new AbortController();
    if (!authorize && !request.history) snapshotPending(true);
    try {
      const success = await read(() => !stopped && (!controller || publicRead === controller) && !queued &&
        (request.full || source === socket), request.full ? undefined : request, controller);
      if (success === false && source === socket) socket?.close();
      else if (ready) delay = 1000;
    } finally {
      running = undefined; publicRead = undefined;
      if (!authorize && !request.history) snapshotPending(false);
      scheduleHistory();
      if (queued && !stopped) {
        const next = queued;
        queued = undefined;
        enqueue(next);
      } else if (ackSocket) {
        if (ackSocket === socket && socket.readyState === WebSocket.OPEN) socket.send('ack');
        ackSocket = undefined;
      }
    }
  }
  async function authenticate(current, type, permission) {
    try {
      const ticket = await authorize();
      if (stopped || current !== socket || current.readyState !== WebSocket.OPEN) return;
      current.send(JSON.stringify({ type, ticket, permission }));
    } catch { if (current === socket) current.close(); }
  }
  function connect(refreshIfUnavailable = false) {
    if (stopped) return;
    clearTimeout(retry);
    try {
      const url = new URL(path, location.href);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const current = socket = new WebSocket(url);
      let renewingPermission;
      handshake = setTimeout(() => current.close(), 10000);
      function connected(continuous) {
        clearTimeout(handshake); renewingPermission = undefined;
        if (!continuous) {
          minimumRevision = 0; ready = true; pollingMode(); sync();
        }
        if (authorize) {
          clearTimeout(renewal);
          renewal = setTimeout(() => {
            if (stopped || current !== socket) return;
            handshake = setTimeout(() => current.close(), 10000);
            renewingPermission = viewPermission();
            authenticate(current, 'renew', renewingPermission);
          }, 240000);
        }
      }
      current.onopen = () => {
        if (current !== socket) return;
        if (authorize) authenticate(current, 'auth'); else connected();
      };
      current.onmessage = event => {
        if (current !== socket) return;
        if (authorize && event.data === 'authorized') { connected(); return; }
        if (renewingPermission && event.data === 'renewed') {
          connected(renewingPermission === viewPermission()); return;
        }
        if (!ready) return;
        let hint;
        try { hint = JSON.parse(event.data); } catch { current.close(); return; }
        if (hint?.type !== 'changed' || !Number.isSafeInteger(hint.revision) || hint.revision < 1 ||
            !Array.isArray(hint.scopes) || !hint.scopes.length || hint.scopes.length > 37 ||
            !hint.scopes.every(scope => typeof scope === 'string' && /^(page|banner|monitors|incidents|destinations|monitor\\/[A-Za-z0-9_-]{1,80})$/.test(scope))) {
          current.close(); return;
        }
        minimumRevision = Math.max(minimumRevision, hint.revision);
        ackSocket = current; enqueue(hint);
      };
      current.onerror = () => current.close();
      current.onclose = () => {
        if (current !== socket) return;
        const refresh = refreshIfUnavailable && !ready;
        clearTimeout(handshake); clearTimeout(renewal); socket = undefined; ackSocket = undefined; ready = false;
        pollingMode(); reconnect();
        if (refresh) sync();
      };
    } catch { pollingMode(); reconnect(); if (refreshIfUnavailable) sync(); }
  }
  function reconnect() {
    if (stopped) return;
    retry = setTimeout(connect, delay + Math.random() * delay * 0.2);
    delay = Math.min(delay * 2, 25000);
  }
  function visible() {
    if (!authorize && document.hidden) { suspend(); return; }
    if (!authorize && stopped) { resume(); return; }
    pollingMode(); if (!document.hidden) sync();
  }
  function suspend() {
    stopped = true; ready = false; queued = undefined; clearTimeout(retry); clearTimeout(handshake); clearTimeout(renewal); clearInterval(polling); polling = undefined;
    clearTimeout(historyTimer); historyTimer = undefined;
    publicRead?.abort(); publicRead = undefined;
    const previous = socket; socket = undefined; ackSocket = undefined; previous?.close();
  }
  function resume() {
    if (!stopped || (!authorize && document.hidden)) return;
    stopped = false; pollingMode(); connect(!authorize);
  }
  document.addEventListener('visibilitychange', visible);
  window.addEventListener('pagehide', suspend);
  window.addEventListener('pageshow', resume);
  if (!authorize && document.hidden) suspend();
  else { pollingMode(); connect(); }
  return { sync, stop() {
    suspend(); document.removeEventListener('visibilitychange', visible);
    window.removeEventListener('pagehide', suspend); window.removeEventListener('pageshow', resume);
  } };
}
const selectedHistoryDays = new Map(Object.entries(history.state?.irisbeatDays || {}));
const instantFormat = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
const localDateFormat = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'numeric', day: 'numeric' });
const bucketFormat = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
function updateTimeDisplays() {
  const now = new Date();
  const clock = document.getElementById('page-clock');
  clock.dateTime = now.toISOString();
  clock.textContent = instantFormat.format(now) + ' (' + browserTimeZone + ')';
  document.querySelectorAll('time[datetime]:not([data-schedule-preview]):not(#page-clock)').forEach(time => {
    const at = new Date(time.dateTime);
    const incident = time.closest('.incident');
    const duration = incident?.querySelector('.incident-duration');
    const crossDay = duration && localDateFormat.format(new Date(Number(duration.dataset.start))) !== localDateFormat.format(new Date(Number(duration.dataset.end ?? now.getTime())));
    const format = !crossDay && time.dataset.incidentTime === 'compact' && localDateFormat.format(at) === localDateFormat.format(now) ? timeFormat : instantFormat;
    const label = format.format(at);
    if (time.textContent !== label) time.textContent = label;
  });
  document.querySelectorAll('.incident-duration').forEach(duration => {
    const seconds = Math.max(0, Math.floor((Number(duration.dataset.end ?? now.getTime()) - Number(duration.dataset.start)) / 1000));
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const label = days ? days + ' d ' + hours % 24 + ' h ' + minutes % 60 + ' min' : hours ? hours + ' h ' + minutes % 60 + ' min' : minutes ? minutes + ' min' : seconds + ' s';
    if (duration.textContent !== label) duration.textContent = label;
  });
}
function initializeDisplay(scopes) {
  updateTimeDisplays();
  document.querySelectorAll('.history').forEach(strip => {
    if (scopes && !scopes.includes('monitors') && !scopes.includes('monitor/' + strip.dataset.monitor)) return;
    const days = [...strip.children];
    if (!days.length) return;
    const detail = strip.nextElementSibling;
    function select(day) {
      selectedHistoryDays.set(strip.dataset.monitor, day.dataset.date);
      if (!document.getElementById('login')) {
        try { history.replaceState({ ...history.state, irisbeatDays: Object.fromEntries(selectedHistoryDays) }, ''); } catch {}
      }
      days.forEach(item => {
        const tabIndex = item === day ? 0 : -1;
        if (item.tabIndex !== tabIndex) item.tabIndex = tabIndex;
        const current = String(item === day);
        if (item.getAttribute('aria-current') !== current) item.setAttribute('aria-current', current);
      });
      const start = new Date(day.dataset.date + 'T00:00:00Z');
      const end = new Date(start.getTime() + 86400000);
      const today = new Date().toISOString().slice(0, 10);
      const counts = Number(day.dataset.successes) + Number(day.dataset.failures) + Number(day.dataset.maintenance)
        ? day.dataset.successes + ' successful · ' + day.dataset.failures + ' failed' + (Number(day.dataset.maintenance) ? ' · ' + day.dataset.maintenance + ' Maintenance' : '')
        : 'No observations';
      const label = (day.dataset.date === today ? '' : bucketFormat.format(start) + ' UTC · ') + counts;
      const text = detail.querySelector('.history-counts');
      if (text.textContent !== label) text.textContent = label;
      detail.querySelector('.utc-range').textContent = day.dataset.date + ' 00:00 UTC → ' + end.toISOString().slice(0, 10) + ' 00:00 UTC';
      detail.querySelector('.local-range').textContent = instantFormat.format(start) + ' → ' + instantFormat.format(end) + ' (' + browserTimeZone + ')';
    }
    days.forEach(day => {
      const start = new Date(day.dataset.date + 'T00:00:00Z');
      const end = new Date(start.getTime() + 86400000);
      const counts = day.dataset.detail;
      const label = bucketFormat.format(start) + ' UTC: ' + counts + ' · ' + instantFormat.format(start) + ' – ' + instantFormat.format(end) + ' (' + browserTimeZone + ')';
      if (day.getAttribute('aria-label') !== label) day.setAttribute('aria-label', label);
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
  setInterval(() => {
    const previous = document.getElementById('page-clock').dateTime.slice(0, 10);
    if (previous !== new Date().toISOString().slice(0, 10)) initializeDisplay();
    else updateTimeDisplays();
  }, 1000);
  if (document.getElementById('public-status')) {
    const updates = liveSnapshots('/api/status/events/v2', async (current, hint, controller) => {
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        if (hint) {
          const scopes = mergeScopes([], hint.scopes).sort();
          const batch = scopes.length > 1;
          const url = batch
            ? '/api/status/partials?' + new URLSearchParams([['revision', hint.revision], ...scopes.map(scope => ['scope', scope])])
            : partialURL('/api/status', scopes[0], hint.revision);
          const response = await fetch(url, { signal: controller.signal });
          if (!response.ok) throw new Error('Request failed');
          const data = await response.json();
          if (data.revision < hint.revision || !Number.isSafeInteger(data.revision)) throw new Error('Revision unavailable');
          const partials = batch ? data.partials : [{ scope: scopes[0], html: data.html }];
          if (!Array.isArray(partials) || partials.length !== scopes.length ||
              partials.some((part, index) => part?.scope !== scopes[index] || typeof part.html !== 'string'))
            throw new Error('Sections unavailable');
          if (!current()) return;
          const ledger = document.querySelector('#public-status .ledger');
          for (const { scope, html } of partials) {
            const next = fragment(html);
            if (scope === 'monitors') reconcile(ledger, next);
            else if (scope.startsWith('monitor/')) reconcile(ledger, next, [scope.slice(8)]);
            else {
              const target = document.querySelector({ page: '#public-status h1', banner: '#public-status .banner', incidents: '#public-incidents' }[scope]);
              const fresh = next.firstElementChild;
              target.hidden = fresh.hidden;
              if (scope === 'banner') target.dataset.state = fresh.dataset.state;
              reconcile(target, fresh);
              if (scope === 'page') document.title = target.textContent;
            }
          }
        } else {
          const response = await fetch('/api/status', { headers: { Accept: viewMediaType }, signal: controller.signal });
          if (!response.ok) throw new Error('Request failed');
          const data = await response.json();
          if (!current()) return;
          if (typeof data.html !== 'string') throw new Error('Snapshot unavailable');
          reconcile(document.getElementById('public-status'), fragment(data.html));
          document.title = data.pageName;
        }
        initializeDisplay(hint?.scopes);
        if (!hint?.history) snapshotFailure(false);
      } catch {
        if (!hint?.history && current()) { snapshotFailure(true); return false; }
      } finally { clearTimeout(timeout); if (hint) controller.abort(); }
    });
    document.getElementById('retry').addEventListener('click', () => updates.sync());
  }
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
#stale { color: var(--warning); margin: 16px 0; }
#stale button { margin-left: 12px; }
#updates-mode { color: var(--muted); margin-right: 12px; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
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
table { width: 100%; table-layout: fixed; border-spacing: 0; margin-top: 20px; }
.monitor-column { width: auto; }
.state-column, .schedule-column { width: 17%; }
.publication-column { width: 15%; }
.actions-column { width: 226px; }
th, td { padding: 12px 16px; text-align: left; }
th { font-size: 12px; color: var(--muted); font-weight: 500; border-bottom: 1px solid var(--line); }
tbody tr:nth-child(even):not(:last-child) td { border-bottom: 1px solid var(--line); }
tbody tr:nth-child(odd) td { padding-bottom: 0; }
.availability { padding-top: 12px; min-width: 0; }
.percentage { font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
.history { position: relative; display: grid; grid-template-columns: repeat(90, minmax(0, 1fr)); gap: 3px; list-style: none; padding: 0; margin: 8px 0 0; }
.history-head { display: flex; justify-content: space-between; gap: 12px; font-size: 12px; }
.page-clock { color: var(--muted); font-size: 12px; margin-bottom: 12px; }
.history-detail summary { cursor: pointer; width: fit-content; margin-top: 4px; }
.history-detail p { margin: 4px 0; }
.history-detail { color: var(--muted); font-size: 12px; line-height: 1.4; margin: 8px 0 0; min-height: 2.8em; }
.history-day[aria-current="true"] { outline: 2px solid var(--foreground); outline-offset: 2px; }
.history-day { cursor: pointer; height: 25px; border-radius: 2px; background: var(--secondary); }
.history-day.up { background: var(--success); }
.history-day.down { background: var(--danger); }
.history-day.degraded { background: var(--warning); }
.history-day.maintenance { background: var(--info); }
.history-day.empty { border: 1px dashed var(--line); }
.history-unavailable { color: var(--muted); font-size: 12px; }
.operator-heading h1 { margin-right: auto; }
#operator-navigation { margin-left: auto; }
.operator-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
#operator-navigation { display: flex; gap: 8px; }
#settings { max-width: 620px; }
#page-configuration { margin-bottom: 24px; }
#configuration { margin: 16px 0; }
form, aside { min-width: 0; }
#configuration, #maintenance, #webhook, #page-configuration, #login { border: 1px solid var(--line); border-radius: var(--radius); padding: 20px; background: var(--card); }
#configuration, #maintenance { background: var(--secondary); }
#maintenance-dialog { width: min(480px, calc(100% - 32px)); padding: 0; border: 1px solid var(--line); border-radius: var(--radius); background: var(--card); color: var(--foreground); }
#maintenance-dialog::backdrop { background: #0006; }
#maintenance { border: 0; }
#maintenance-error:empty { display: none; }
fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
label { display: block; margin: 12px 0 6px; font-size: 13px; }
input, select, button { font: inherit; min-height: 40px; max-width: 100%; border: 1px solid var(--line); border-radius: 7px; background: var(--card); color: var(--foreground); }
input, select { width: 100%; padding: 8px 11px; border-color: var(--control-border); }
.duration-value { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; }
input:disabled, select:disabled { opacity: .65; }
.checkbox { display: flex; align-items: center; gap: 8px; }
input[type="checkbox"] { width: auto; accent-color: var(--primary); }
button { padding: 8px 13px; cursor: pointer; font-weight: 550; }
button:hover, summary:hover { background: var(--secondary); }
button:disabled { opacity: .5; cursor: wait; }
form button { margin-top: 16px; }
form button + button { margin-left: 8px; }
#webhook { margin: 12px 0; }
#destination-rows { list-style: none; padding: 0; margin: 12px 0 28px; }
#destination-rows li { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 16px; border-top: 1px solid var(--line); padding: 12px 0; }
.destination-address, #destination-choices label { overflow-wrap: anywhere; }
.destination-details { min-width: 0; display: grid; gap: 4px; }
.destination-submission { font-size: .875rem; }
.destination-actions { display: flex; flex-wrap: wrap; gap: 8px; }
#destination-selection { margin-top: 12px; }
#destination-selection legend { font-weight: 550; }
#destination-choices label { margin: 4px 0; }
#destination-choices input { flex: none; }
.ledger:empty { display: none; }
form button[type="submit"], form button:not([type]), #new-monitor { background: var(--primary); border-color: var(--primary); color: var(--primary-foreground); }
.text-button { border: 0; background: transparent; color: inherit; padding-left: 0; text-decoration: underline; text-underline-offset: 4px; }
:focus-visible { outline: 2px solid var(--primary); outline-offset: 3px; }
.incidents { list-style: none; padding: 0; margin: 12px 0 0; }
.incident { padding: 16px 0; border-top: 1px solid var(--line); }
.incident-top, .incident-facts { display: flex; align-items: baseline; gap: 8px 16px; flex-wrap: wrap; }
.incident-top h4 { margin: 0; font-size: 14px; overflow-wrap: anywhere; }
.incident-state { margin-left: auto; }
.incident-state[data-state="down"] { color: var(--danger); }
.incident-state[data-state="up"] { color: var(--success); }
.deleted, .incident-facts { color: var(--muted); font-size: 12px; }
.incident-facts { margin-top: 8px; }
.incident p { margin: 8px 0 0; color: var(--muted); font-size: 12px; }
.actions { justify-content: flex-start; margin-top: 20px; }
td .actions { margin: 0; gap: 6px; }
#login { max-width: 28rem; }
#paused { color: var(--info); }
#message:empty { display: none; }
footer { margin-top: 36px; padding-top: 18px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; }
.theme-control { display: flex; align-items: center; gap: 8px; margin: 0; }
.theme-control select { width: auto; }
.monitor-actions { display: grid; grid-template-columns: repeat(4, 44px); gap: 6px; }
.monitor-action { position: relative; display: grid; place-items: center; width: 44px; min-height: 44px; padding: 10px; border: 0; background: transparent; }
.monitor-action svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.action-label { display: none; position: absolute; z-index: 6; top: 100%; right: 0; width: max-content; padding: 5px 8px; border: 1px solid var(--line); border-radius: 7px; background: var(--card); color: var(--foreground); font-size: 12px; }
.monitor-action:hover .action-label, .monitor-action:focus .action-label { display: block; }
@media (hover: none) { .actions-column { width: 290px; } .monitor-actions { grid-template-columns: 44px 64px 88px 44px; } .monitor-action { width: 100%; padding: 6px 0; } .action-label { display: block; position: static; width: auto; padding: 0; border: 0; font-size: 10px; } }
button.danger { color: var(--danger); }
[hidden] { display: none !important; }
@media (max-width: 44rem) {
  body { padding: 0 16px 24px; }
  header { gap: 8px; }
  nav { gap: 0; }
  nav a { padding: 7px; }
  .brand { font-size: 18px; }
  #stale { color: var(--warning); margin-right: 12px; }
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
  footer { align-items: flex-start; }
}
`;

export const operatorScript = `
const createOperatorSession = ${createOperatorSession.toString()};
const createMonitorEditor = ${createMonitorEditor.toString()};
const byId = id => document.getElementById(id);
const login = byId('login');
const editor = byId('editor');
const form = byId('configuration');
const pageForm = byId('page-configuration');
const webhook = byId('webhook');
const maintenanceForm = byId('maintenance');
const message = byId('message');
let savedPageName = '';
let destinations = [];
let destinationUses = new Map();
let replacingDestination = null;
let destinationChannel = 'webhook';
let emailConfigured = false;
const destinationsPath = '/api/operator/destinations';
const destinationRows = byId('destination-rows');
const addWebhook = byId('add-webhook');
const addEmail = byId('add-email');
const destinationAddress = byId('destination-address');
function updateWebhook() {
  const missing = replacingDestination !== null && !destinations.some(destination => destination.id === replacingDestination);
  byId('destination-missing').hidden = !missing;
  byId('save-webhook').disabled = missing || (destinationChannel === 'email' && !emailConfigured);
  const count = destinationUses.get(replacingDestination) || 0;
  const impact = byId('webhook-impact');
  impact.hidden = !count || webhook.hidden;
  impact.textContent = count && !webhook.hidden ? count + (count === 1 ? ' Monitor will' : ' Monitors will') + ' lose this selection if the address changes.' : '';
}
function closeWebhook(focus = false) {
  const id = replacingDestination;
  const add = destinationChannel === 'email' && emailConfigured ? addEmail : addWebhook;
  replacingDestination = null;
  webhook.reset(); webhook.hidden = true; updateWebhook();
  if (focus) (document.getElementById('replace-' + id) || add).focus();
}
function openDestination(channel, destination) {
  const id = destination?.id ?? null;
  if (!webhook.hidden && replacingDestination === id && destinationChannel === channel) { destinationAddress.focus(); return; }
  replacingDestination = id;
  destinationChannel = channel;
  const email = channel === 'email';
  destinationAddress.type = email ? 'email' : 'url';
  destinationAddress.maxLength = email ? 254 : 2048;
  destinationAddress.value = (email ? destination?.address : destination?.url) ?? '';
  byId('destination-address-label').textContent = email ? 'Email address' : 'HTTPS webhook URL';
  webhook.setAttribute('aria-label', (destination ? 'Replace ' : 'Add ') + channel);
  byId('save-webhook').textContent = destination ? 'Replace ' + channel : email ? 'Save email' : 'Save webhook';
  webhook.hidden = false; updateWebhook(); destinationAddress.focus();
}
function bindDestinationActions(row, destination) {
  const path = destinationsPath + '/' + encodeURIComponent(destination.id);
  const value = destination.channel === 'email' ? destination.address : destination.url;
  const actions = {
    Replace: () => openDestination(destination.channel, destination),
    'Resend confirmation': () => run(path + '/confirmation', 'POST'),
    Remove: () => {
      if (confirm('Remove ' + value + '? Monitors will lose this selection.')) {
        run(path, 'DELETE', undefined, () => queueMicrotask(() => addWebhook.focus()));
      }
    },
  };
  row.querySelectorAll('button').forEach(button => { button.onclick = actions[button.dataset.action]; });
}
function renderDestinations(next, monitors, markup) {
  destinations = next;
  destinationUses = new Map();
  for (const monitor of monitors) for (const id of monitor.destinationIds ?? []) {
    destinationUses.set(id, (destinationUses.get(id) || 0) + 1);
  }
  const focused = document.activeElement;
  const focusedRow = destinationRows.contains(focused);
  const rows = markup ? [...markup.children] : [];
  rows.forEach((row, index) => bindDestinationActions(row, destinations[index]));
  reconcileNodes(destinationRows, rows);
  byId('no-destinations').hidden = destinations.length !== 0;
  updateWebhook();
  if (focusedRow && destinationRows.contains(focused) && document.activeElement !== focused) focused.focus();
  else if (focusedRow && !focused.isConnected) addWebhook.focus();
}

let hosted = false;
let monitorIds = new Set();
function updateDeleted() {
  monitorEditor.update(monitorIds);
  const maintenanceMissing = !maintenanceForm.hidden && !monitorIds.has(maintenanceForm.dataset.monitorId);
  byId('maintenance-deleted').hidden = !maintenanceMissing;
  byId('save-maintenance').disabled = maintenanceMissing;
  byId('end-maintenance').disabled = maintenanceMissing;
}

function focusActions(id) { (document.getElementById('actions-' + id)?.querySelector('button') || byId('new-monitor')).focus(); }
function localMinute(date) { return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
function declareMaintenance(monitor) {
  maintenanceForm.querySelector('label').textContent = 'End time (' + browserTimeZone + ')';
  maintenanceForm.dataset.monitorId = monitor.id;
  byId('maintenance-error').textContent = '';
  byId('end-maintenance').hidden = !monitor.maintenance;
  byId('save-maintenance').textContent = monitor.maintenance ? 'Update end date' : 'Start Maintenance';
  const end = new Date(monitor.maintenance?.endsAt ?? Date.now() + 3600000);
  const input = byId('maintenance-end');
  input.value = localMinute(end);
  input.dataset.originalValue = input.value;
  input.dataset.originalInstant = String(end.getTime());
  input.setCustomValidity('');
  maintenanceForm.hidden = false; updateDeleted(); byId('maintenance-dialog').showModal(); byId('maintenance-end').focus();
}
function closeMaintenance() { byId('maintenance-dialog').close(); maintenanceForm.hidden = true; queueMicrotask(() => (document.getElementById('actions-' + maintenanceForm.dataset.monitorId)?.querySelector('[data-key=maintenance]') || byId('new-monitor')).focus()); }
function clearSession() {
  byId('maintenance-dialog').close();
  document.querySelectorAll('button, input, select').forEach(control => { control.disabled = false; });
  monitorIds.clear(); selectedHistoryDays.clear(); byId('stale').hidden = true; byId('sync-announcement').textContent = ''; snapshotPending(false);
  emailConfigured = false; addEmail.hidden = true;
  savedPageName = ''; monitorEditor.close(); monitorEditor.refreshDestinations([]); renderDestinations([], []); byId('heartbeat-path').textContent = ''; maintenanceForm.reset(); maintenanceForm.removeAttribute('data-monitor-id'); byId('maintenance-heading').textContent = 'Maintenance'; maintenanceForm.hidden = true; pageForm.reset(); closeWebhook(); editor.hidden = true; login.hidden = false;
  showSettings(false); byId('operator-navigation').hidden = true;

  byId('monitor-rows').replaceChildren(); byId('incidents').replaceChildren();
  updateDeleted();
  message.textContent = ''; byId('secret').value = ''; byId('secret').focus();
}
let monitorFloor = 60;
function bindMonitorActions(group, monitor) {
  const path = '/api/operator/monitors/' + encodeURIComponent(monitor.id);
  const actions = {
    edit: () => {
      monitorEditor.setSchedulePolicy(monitorFloor, monitor.scheduleSuspended === true);
      monitorEditor.open(monitor, hosted);
    },
    publication: () => run(path, 'PATCH', { published: !monitor.published }),
    maintenance: () => declareMaintenance(monitor),
    delete: () => { if (confirm('Delete ' + monitor.name + '? Checks and publication stop. Incident history is retained.')) run(path, 'DELETE'); },
  };
  group.querySelectorAll('button').forEach(button => { button.onclick = actions[button.dataset.key]; });
}
function updatePageName(value, saved) {
  const input = byId('pageName');
  if (saved || input.value === savedPageName) {
    if (input.value !== value) input.value = value;
    savedPageName = value;
  }
}
function restoreOperatorFocus(focused) {
  if (focused !== document.body && (document.activeElement === document.body ||
      (focused === document.activeElement && focused.closest('[hidden]')))) {
    byId(byId('new-monitor').hidden ? 'operator-title' : 'new-monitor').focus();
  }
}
function renderOperatorPartials(partials, savedField) {
  const focused = document.activeElement;
  for (const { scope, data } of partials) {
    const next = fragment(data.html);
    if (scope === 'page') updatePageName(data.pageName, savedField === 'pageName');
    else if (scope === 'banner') byId('paused').hidden = next.firstElementChild.hidden;
    else if (scope === 'incidents') reconcile(byId('incidents'), next);
    else if (scope === 'destinations') {
      emailConfigured = data.emailConfigured; addEmail.hidden = !emailConfigured;
      renderDestinations(data.destinations, data.selections, next);
      monitorEditor.refreshDestinations(destinations, data.selections.find(monitor => monitor.id === monitorEditor.id)?.destinationIds);
    } else {
      monitorFloor = data.minCheckIntervalSeconds ?? 60;
      const edited = data.monitors.find(monitor => monitor.id === monitorEditor.id);
      if (edited || !monitorEditor.id) monitorEditor.setSchedulePolicy(monitorFloor, edited?.scheduleSuspended === true);
      const id = scope.startsWith('monitor/') ? scope.slice(8) : null;
      if (id) {
        if (data.monitors.length) monitorIds.add(id);
        else monitorIds.delete(id);
      } else monitorIds = new Set(data.monitors.map(monitor => monitor.id));
      for (const monitor of data.monitors) {
        const group = next.getElementById('actions-' + monitor.id);
        if (group) bindMonitorActions(group, monitor);
      }
      if (monitorEditor.id && !monitorIds.has(monitorEditor.id) && form.parentElement !== byId('new-monitor-panel')) {
        byId('new-monitor-panel').append(form);
        if (form.contains(focused)) focused.focus();
      }
      reconcile(byId('monitor-rows'), next, id ? [id, id + ':history'] : undefined);
      updateDeleted();
    }
  }
  initializeDisplay(partials.map(partial => partial.scope));
  restoreOperatorFocus(focused);
}
function renderOperatorSnapshot(data, savedField) {
  const initial = editor.hidden;
  const focused = document.activeElement;
  login.hidden = true; editor.hidden = false; byId('operator-navigation').hidden = false;
  hosted = data.hosted;
  const canEdit = data.permission === 'editor';
  if (!canEdit) {
    monitorEditor.close(); closeMaintenance(); closeWebhook(); showSettings(false);
  }
  byId('new-monitor').hidden = !canEdit || !byId('settings').hidden; byId('settings-button').hidden = !canEdit || !byId('settings').hidden;
  renderOperatorPartials(data.partials, initial ? 'pageName' : savedField);
  restoreOperatorFocus(focused);
}

const session = createOperatorSession(liveSnapshots, mergeScopes, {
  partials: renderOperatorPartials,
  snapshot: renderOperatorSnapshot,
  pageNameSaved() { savedPageName = byId('pageName').value; },
  credential(secret) { byId('heartbeat-credential').textContent = 'Bearer ' + secret; },
  reading(state) {
    if (state === 'success') snapshotFailure(false);
    else snapshotPending(state === 'pending');
  },
  signedOut: clearSession,
  failed(error, reading) {
    if (reading) snapshotFailure(true);
    else { message.textContent = error; if (byId('maintenance-dialog').open) byId('maintenance-error').textContent = error; }
  },
  writing() {
    const focused = document.activeElement;
    const disabled = [...document.querySelectorAll('button, input, select')].filter(control => !control.disabled && control.id !== 'logout');
    disabled.forEach(control => { control.disabled = true; });
    message.textContent = ''; byId('maintenance-error').textContent = '';
    return () => {
      disabled.forEach(control => { control.disabled = false; });
      updateDeleted(); updateWebhook();
      if (!editor.hidden && document.activeElement === document.body) {
        if (focused?.matches('button, input, select') && !focused.disabled && !focused.closest('[hidden]')) focused.focus();
        if (document.activeElement === document.body) byId(byId('new-monitor').hidden ? 'operator-title' : 'new-monitor').focus();
      }
    };
  },
  saved(path, method) {
    message.textContent = method === 'DELETE' ? (path.endsWith('/maintenance') ? 'Maintenance ended' : 'Deleted')
      : path.endsWith('/confirmation') ? 'Confirmation requested' : 'Saved';
  },
  previewed: data => monitorEditor.previewed(data),
  previewFailed: error => monitorEditor.previewFailed(error),
});
const run = session.run;
const monitorEditor = createMonitorEditor(form, session, focusActions, reconcileNodes);
login.addEventListener('submit', async event => {
  event.preventDefault();
  await session.signIn(byId('secret').value); byId('secret').value = '';
  if (!editor.hidden) byId(byId('new-monitor').hidden ? 'operator-title' : 'new-monitor').focus();
});
maintenanceForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!monitorIds.has(maintenanceForm.dataset.monitorId)) return;
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
  await run('/api/operator/monitors/' + encodeURIComponent(maintenanceForm.dataset.monitorId) + '/maintenance', 'PUT', { endsAt }, closeMaintenance);
});
byId('maintenance-end').addEventListener('input', event => event.target.setCustomValidity(''));
byId('cancel-maintenance').addEventListener('click', closeMaintenance);
byId('maintenance-dialog').addEventListener('cancel', event => { event.preventDefault(); closeMaintenance(); });
byId('end-maintenance').addEventListener('click', () => { if (monitorIds.has(maintenanceForm.dataset.monitorId)) run('/api/operator/monitors/' + encodeURIComponent(maintenanceForm.dataset.monitorId) + '/maintenance', 'DELETE', undefined, closeMaintenance); });
addWebhook.addEventListener('click', () => openDestination('webhook'));
addEmail.addEventListener('click', () => openDestination('email'));
byId('cancel-webhook').addEventListener('click', () => closeWebhook(true));
webhook.addEventListener('submit', async event => {
  event.preventDefault();
  if (byId('save-webhook').disabled) return;
  const id = replacingDestination;
  const value = destinationChannel === 'email' ? { channel: 'email', address: destinationAddress.value } : { url: destinationAddress.value };
  await run(id ? destinationsPath + '/' + encodeURIComponent(id) : destinationsPath, id ? 'PUT' : 'POST', value, () => {
    const add = destinationChannel === 'email' ? addEmail : addWebhook;
    closeWebhook(); queueMicrotask(() => add.focus());
  });
});
pageForm.addEventListener('submit', async event => { event.preventDefault(); await run('/api/operator', 'PUT', { pageName: byId('pageName').value }); });
function showSettings(settings) {
  byId('settings').hidden = !settings; byId('workspace').hidden = settings;
  byId('operator-title').textContent = settings ? 'Settings' : 'Monitors';
  byId('new-monitor').hidden = settings; byId('settings-button').hidden = settings; byId('back-monitors').hidden = !settings;
  message.textContent = '';
}
byId('settings-button').addEventListener('click', () => { showSettings(true); byId('pageName').focus(); });
byId('back-monitors').addEventListener('click', () => { showSettings(false); byId('settings-button').focus(); });
byId('new-monitor').addEventListener('click', () => { monitorEditor.setSchedulePolicy(monitorFloor, false); monitorEditor.open(null, hosted); });
byId('retry').addEventListener('click', () => run());
byId('logout').addEventListener('click', session.signOut);
`;
