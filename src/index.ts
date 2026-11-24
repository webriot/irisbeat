// SPDX-License-Identifier: AGPL-3.0-only
import { operatorPage, operatorScript, recipientAction, recipientPage, recipientScript, renderViewPartial, renderViewSnapshot, statusJson, styleSheet, themeScript, type StatusProjection } from "./ui";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { calendar } from "./calendar";
import { minimumCheckIntervalSeconds, MonitorConfigurations, timingDefaults, type Monitor, type MaintenanceWindow } from "./monitor-configuration";
import { connect } from "cloudflare:sockets";
import { parseEmailAddress, parseWebhook, type AlertDestination, type ConfirmationIdentity, type ConfirmationJob, type NewNotificationDestination, type NotificationDestination, type NotificationEligibility, type NotificationJob, type NotificationQueueJob } from "./notification-jobs";
import type { NotificationDeliveryIdentity, SubmissionReport } from "./notification-outcomes";
import { configurationScopes, mergeScopes, monitorScopes, sharedScopes, type ViewAudience, type ViewChanges, type ViewHint, type ViewScope } from "./view-changes";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { cachedRenderResponse, HTML, readEdge, renderResponse, renderStatus, statusRenderInterval, statusWindowEnd, writeEdge, type StatusRender, type StatusRequest, type StatusResource } from "./status-publication";
import { Availability, availabilityRetryAfter, availabilityWriteLimit, DAY, historyStart, type AvailabilityEnv, type AvailabilityHistory, type HistoryFence } from "./availability-history";
export type { AvailabilityHistory, AvailabilityQuery, AvailabilityQueryService, AvailabilityRow, HistoryDay } from "./availability-history";

export const CONTRACT_VERSION = "1" as const;
export interface EngineEnv extends AvailabilityEnv {
  MONITORING: DurableObjectNamespace<MonitoringContext>;
  INSTALLATION_SECRET?: string;
  STATUS_RENDER_INTERVAL_SECONDS?: string;
  IRISBEAT_VERSION?: { id: string };
  MIN_CHECK_INTERVAL_SECONDS?: string | number;
  NOTIFICATION_PUBLIC_ORIGIN?: string;
  NOTIFICATION_EMAIL?: { isConfigured(): Promise<boolean> };
  NOTIFICATION_QUEUE?: Pick<Queue<NotificationQueueJob>, "sendBatch">;
}
type PausePolicy = { paused: boolean; policyRevision: number } | { paused?: undefined; policyRevision?: undefined };
export type ScheduledContext = { id: string; notificationOrigin?: string } & PausePolicy;
function validPolicy(value: { paused?: unknown; policyRevision?: unknown }) {
  return value.paused === undefined ? value.policyRevision === undefined
    : typeof value.paused === "boolean" && typeof value.policyRevision === "number" &&
      Number.isSafeInteger(value.policyRevision) && value.policyRevision >= 0;
}
export type ResolvedContext = ScheduledContext & {
  permission: "editor" | "reader" | null;
  monitorLimit: number;
};
export interface HostedAdapter<E extends EngineEnv = EngineEnv> {
  contractVersion: string;
  resolve(request: Request, env: E): ResolvedContext | null | Promise<ResolvedContext | null>;
  contexts(env: E): (string | ScheduledContext)[] | Promise<(string | ScheduledContext)[]>;
}

export type Incident = {
  id: string;
  monitorId: string;
  monitorName: string | null;
  openedAt: number;
  closedAt: number | null;
};
/** @deprecated Retained for source compatibility with legacy hosted overrides. */
export type IncidentTransition = {
  contextId: string;
  incident: Incident;
  transition: "opened" | "recovered";
  at: number;
};
export type {
  ConfirmationJob,
  MaintenanceNotificationEvent,
  NotificationDestination,
  NotificationEvent,
  NotificationJob,
  NotificationQueueJob,
} from "./notification-jobs";
export type { MaintenanceWindow } from "./monitor-configuration";
export type { ViewAudience, ViewHint, ViewScope } from "./view-changes";
export type Status = ReturnType<typeof statusJson>;
const CONFIRMATION_COOLDOWN = 5 * 60_000;
type ConfirmationInvitation = { id: string; token: string; origin: string; expiresAt: number; submitted?: boolean };
type StoredContext = {
  pageName: string;
  monitors: Monitor[];
  webhookUrl?: string | null;
  legacyDestinationId?: string;
  destinations?: (NotificationDestination & { submission?: SubmissionReport & { deliveryId: string } })[];
  emailConfirmations?: Record<string, ConfirmationInvitation>;
  emailWithdrawals?: Record<string, { token: string; origin: string }>;
  confirmationCooldowns?: Record<string, number>;
  paused?: boolean;
  policyRevision?: number;
  pauseGeneration?: number;
  notificationOrder?: number;
};
type LegacyContext = { webhookUrl?: string | null; monitor: (Monitor & { pageName: string }) | null };
type DestinationUpdate = (NewNotificationDestination & { name?: string }) | { name: string };

function nextDestinationName(channel: NewNotificationDestination["channel"], used: Set<string>) {
  const prefix = channel === "email" ? "Email" : "Webhook";
  let number = 1;
  while (used.has(`${prefix.toLowerCase()} ${number}`)) number++;
  return `${prefix} ${number}`;
}

type OperatorSubscription = { audience: "operator"; origin: string; expiresAt: number } & (
  | { authenticated: false; contextId?: never; permission?: never }
  | { authenticated: true; contextId: string; permission: "reader" | "editor" }
);
type Subscription = { protocol: 2; pending: boolean; queued?: ViewHint } & (
  | { audience?: undefined; authenticated?: never; permission?: never }
  | OperatorSubscription
);
type PendingStatus = { since: number; scopes: ViewScope[] };
type PublishedStatusMeta = Pick<StatusProjection, "paused" | "pageName"> & { revision: number; loggedBefore?: number };
type PublishedHistory = HistoryFence & { retryAt?: number };
type PublicationInput = { revision: number; at: number; loggedBefore?: number; data: StatusProjection; history: Map<string, PublishedHistory> };
type PublishedStatus = PublicationInput & { generation: number; renders: Map<StatusResource, StatusRender> };
type StatusBaseline = PublishedStatusMeta & {
  monitors: (ReturnType<typeof publicMonitor> & { historyFence?: HistoryFence })[];
  at: number;
  publication?: { dueAt: number; scopes: ViewScope[] };
};
type MutationAck = Pick<ViewHint, "revision" | "scopes">;
type ViewClock = Record<ViewAudience, number> & { day?: number };
type Ticket = { origin: string; contextId: string; permission: "reader" | "editor"; expiresAt: number; leaseEndsAt: number };

function publicMonitor(monitor: Monitor, paused: boolean) {
  const kind = monitor.kind ?? "http";
  return {
    id: monitor.id, name: monitor.name, kind,
    ...(kind === "heartbeat" ? { lastSeen: monitor.lastSeen ?? null } : {}),
    state: paused ? "paused" as const : monitor.maintenance ? "maintenance" as const : monitor.state,
    maintenance: monitor.maintenance ?? null, lastResult: monitor.lastResult,
    ...(monitor.historyRetryToken ? { historyRetryToken: monitor.historyRetryToken } : {}),
  };
}

function allowedSubscriptionOrigin(request: Request, requireOrigin: boolean) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  return (origin === url.origin || (!requireOrigin && !origin)) &&
    (url.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
}

export class MonitoringContext<E extends EngineEnv = EngineEnv> extends DurableObject<E> {
  private readonly renderInterval = statusRenderInterval(this.env.STATUS_RENDER_INTERVAL_SECONDS);
  private publishedStatus?: PublishedStatus;
  private publicationRetryAt = 0;
  private subscriptionAlarmCheck?: Promise<void>;

  constructor(ctx: DurableObjectState, env: E) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS notification_completions (
      deliveryId TEXT PRIMARY KEY, expiresAt INTEGER NOT NULL
    )`);
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS notification_completions_expiry ON notification_completions (expiresAt)");
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS notification_retries (
      deliveryId TEXT PRIMARY KEY, attempt INTEGER NOT NULL, at INTEGER NOT NULL, expiresAt INTEGER NOT NULL
    )`);
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS notification_retries_expiry ON notification_retries (expiresAt)");
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS incidents (
      id TEXT PRIMARY KEY, monitorId TEXT NOT NULL, openedAt INTEGER NOT NULL, closedAt INTEGER
    )`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS subscription_tickets (
      token TEXT PRIMARY KEY, scope TEXT NOT NULL, expiresAt INTEGER NOT NULL
    )`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS calendar_receipts (
      monitorId TEXT NOT NULL, occurrence INTEGER NOT NULL, PRIMARY KEY (monitorId, occurrence)
    )`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS calendar_maintenance (
      id INTEGER PRIMARY KEY, monitorId TEXT NOT NULL, startedAt INTEGER NOT NULL, endsAt INTEGER NOT NULL
    )`);
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS calendar_maintenance_monitor ON calendar_maintenance (monitorId, endsAt)");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS incidents_opened ON incidents (openedAt DESC, id)");
    if (this.renderInterval) {
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS status_publication (
        kind TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (kind, position)
      )`);
    } else if (ctx.storage.kv.get("status-published") || ctx.storage.kv.get("status-pending") || this.statusBaseline()) {
      ctx.storage.transactionSync(() => {
        ctx.storage.kv.delete("status-published");
        ctx.storage.kv.delete("status-pending");
        ctx.storage.kv.delete("status-baseline");
        ctx.storage.sql.exec("DROP TABLE IF EXISTS status_publication");
      });
    }
    if (!ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(incidents)").toArray().some(column => column.name === "monitorName")) {
      ctx.storage.sql.exec("ALTER TABLE incidents ADD COLUMN monitorName TEXT");
    }
  }
  issueSubscriptionTicket(contextId: string, origin: string, permission: "reader" | "editor") {
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM subscription_tickets WHERE expiresAt <= ?", now);
    if (this.ctx.storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM subscription_tickets").one().count >= 128) return null;
    const ticket = crypto.randomUUID();
    const scope: Ticket = { contextId, origin, permission, expiresAt: now + 30_000, leaseEndsAt: now + 300_000 };
    this.ctx.storage.sql.exec("INSERT INTO subscription_tickets VALUES (?, ?, ?)", ticket, JSON.stringify(scope), scope.expiresAt);
    return { ticket, expiresAt: scope.expiresAt };
  }

  fetch(request: Request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response(null, { status: 426 });
    const path = new URL(request.url).pathname;
    if (path !== "/api/status/events/v2" && path !== "/api/operator/events/v2") return new Response(null, { status: 404 });
    const operator = path === "/api/operator/events/v2";
    const audience = operator ? "operator" : "public";
    const active = this.liveSockets(audience);
    if (active.length >= 128 || (operator && active.filter(socket => !socket.deserializeAttachment()?.authenticated).length >= 16))
      return new Response(null, { status: 503 });
    const { 0: client, 1: server } = new WebSocketPair();
    const attachment: Subscription = operator
      ? { protocol: 2, pending: false, audience: "operator", origin: new URL(request.url).origin, authenticated: false, expiresAt: Date.now() + 10_000 }
      : { protocol: 2, pending: false };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server, [audience]);
    this.scheduleSubscriptionAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    const state = socket.deserializeAttachment() as Subscription;
    if (state?.protocol !== 2) { socket.close(1012, "Update protocol changed"); return; }
    if (state.audience === "operator") {
      if (!this.subscriptionValid(socket, state)) return;
      if (!state.authenticated || message !== "ack") {
        let input;
        try { input = typeof message === "string" && message.length <= 256 ? JSON.parse(message) : null; } catch { input = null; }
        if (input?.type !== (state.authenticated ? "renew" : "auth") || typeof input.ticket !== "string") {
          socket.close(1008, "Invalid authorization"); return;
        }
        // One synchronous DELETE both consumes and returns the grant, including across hibernation.
        const row = this.ctx.storage.sql.exec<{ scope: string }>("DELETE FROM subscription_tickets WHERE token = ? RETURNING scope", input.ticket).toArray()[0];
        const scope = row ? JSON.parse(row.scope) as Ticket : null;
        if (!scope || scope.expiresAt <= Date.now() || scope.origin !== state.origin ||
            (state.contextId !== undefined && scope.contextId !== state.contextId)) {
          socket.close(1008, "Invalid authorization"); return;
        }
        const samePermission = state.permission === scope.permission;
        socket.serializeAttachment({ ...state, ...scope, queued: samePermission ? state.queued : undefined,
          audience: "operator", authenticated: true, expiresAt: scope.leaseEndsAt } satisfies Subscription);
        // Only renewals that name the browser's current permission opt into the continuity acknowledgement.
        socket.send(samePermission && input.type === "renew" && input.permission === scope.permission ? "renewed" : "authorized");
        this.scheduleSubscriptionAlarm();
        return;
      }
    }
    if (message !== "ack" || !state?.pending) {
      socket.close(1008, "Read-only subscription");
      return;
    }
    if (state.queued) socket.send(JSON.stringify(state.queued));
    socket.serializeAttachment({ ...state, pending: !!state.queued, queued: undefined });
  }

  webSocketClose(socket: WebSocket) { socket.close(1000, ""); this.scheduleSubscriptionAlarm(); }
  webSocketError(socket: WebSocket) { socket.close(1011, "Subscription closed"); this.scheduleSubscriptionAlarm(); }

  private subscriptionValid(socket: WebSocket, state: Subscription) {
    if (state.audience !== "operator" || !state.expiresAt || state.expiresAt <= Date.now()) { socket.close(1008, "Authorization expired"); return false; }
    return true;
  }

  private liveSockets(audience: "public" | "operator") {
    return this.ctx.getWebSockets(audience).filter(socket => {
      if (socket.readyState !== WebSocket.OPEN) return false;
      const state = socket.deserializeAttachment() as Subscription;
      if (state?.protocol !== 2) { socket.close(1012, "Update protocol changed"); return false; }
      return audience === "public" || this.subscriptionValid(socket, state);
    });
  }

  private scheduleSubscriptionAlarm() {
    if (!this.subscriptionAlarmCheck) {
      this.subscriptionAlarmCheck = this.reconcileSubscriptionAlarm(this.ctx.storage.getAlarm());
      this.ctx.waitUntil(this.subscriptionAlarmCheck);
    }
    return this.subscriptionAlarmCheck;
  }

  private async reconcileSubscriptionAlarm(currentAlarm: Promise<number | null>) {
    const { storage } = this.ctx;
    let scheduledAt: number | null;
    try {
      scheduledAt = await currentAlarm;
    } finally {
      this.subscriptionAlarmCheck = undefined;
    }
    // Calls sharing the read use the latest state. Compare and issue the write in the same turn.
    const now = Date.now();
    const stored = this.ctx.storage.kv.get<StoredContext | LegacyContext>("context");
    const monitors = stored && "monitors" in stored ? stored.monitors : stored?.monitor ? [stored.monitor] : [];
    const operators = this.liveSockets("operator").map(socket => socket.deserializeAttachment() as OperatorSubscription);
    const hasPublicSubscribers = this.liveSockets("public").length > 0;
    const observed = operators.some(state => state.authenticated) ? monitors
      : hasPublicSubscribers ? monitors.filter(monitor => monitor.published) : [];
    const publication = hasPublicSubscribers ? Math.max(this.eligiblePublicationAt(), this.publicationRetryAt) : Infinity;
    const day = this.viewClock().day ?? Math.floor(now / DAY);
    const boundary = observed.length ? Math.min((day + 1) * DAY,
      ...observed.flatMap(monitor => monitor.maintenance ? [monitor.maintenance.endsAt] : [])) : Infinity;
    const at = Math.min(boundary, publication, this.availability.flushAt ?? Infinity, ...operators.map(state => state.expiresAt));
    const next = Number.isFinite(at) ? at : null;
    if (next === scheduledAt) return;
    return next === null ? storage.deleteAlarm() : storage.setAlarm(next);
  }

  async alarm() {
    const now = Date.now();
    this.read(now);
    if ((this.availability.flushAt ?? Infinity) <= now) {
      // Persist the next wakeup before handing off any points from this alarm.
      this.availability.delayFlush(now);
      await this.scheduleSubscriptionAlarm();
      await this.drainAvailability(availabilityWriteLimit);
    }
    if (this.liveSockets("public").length && this.eligiblePublicationAt() <= now)
      await this.advanceStatusPublication(this.read(now), now);
    await this.scheduleSubscriptionAlarm();
  }

  private async drainAvailability(limit: number) {
    if (limit <= 0 || this.availability.flushAt === undefined) return;
    // Keep new observations and other drains out until the selected work is durable.
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.sync();
      const now = Date.now();
      const state = this.ctx.storage.kv.get<StoredContext>("context");
      this.commitViewChanges(() => {
        const changed = this.availability.flush(now, limit);
        const operator: ViewScope[] = [];
        const publicScopes: ViewScope[] = [];
        for (const monitor of state?.monitors ?? []) {
          if (!changed.has(monitor.id)) continue;
          const changedAt = monitor.historyChangedAt ?? -Infinity;
          const crossedWindow = this.renderInterval > 0 && (!Number.isFinite(changedAt) ||
            now >= statusWindowEnd(changedAt, this.renderInterval));
          monitor.historyRevision = (monitor.historyRevision ?? 0) + 1;
          monitor.historyChangedAt = now;
          // A handoff in the observation's window already has a pending public scope.
          if (!crossedWindow && now < changedAt + availabilityRetryAfter) continue;
          const scope = `monitor/${monitor.id}` as const;
          monitor.historyRetryToken = crypto.randomUUID();
          operator.push(scope);
          if (monitor.published && (crossedWindow || !this.renderInterval)) publicScopes.push(scope);
        }
        if (state && changed.size) this.ctx.storage.kv.put("context", state);
        return { public: publicScopes, reader: operator, editor: operator };
      }, undefined, now);
      this.scheduleSubscriptionAlarm();
    });
  }

  private pendingStatus() {
    return this.renderInterval ? this.ctx.storage.kv.get<PendingStatus>("status-pending") : undefined;
  }

  private statusPublicationAt(pending = this.pendingStatus()) {
    return pending ? statusWindowEnd(pending.since, this.renderInterval) : Infinity;
  }

  private eligiblePublicationAt() {
    return this.statusBaseline()?.publication?.dueAt ?? this.statusPublicationAt();
  }

  private captureStatusBaseline(revision: number, at: number, loggedBefore: number, publication?: StatusBaseline["publication"]) {
    const stored = this.ctx.storage.kv.get<StoredContext>("context");
    const paused = !!stored?.paused;
    const monitors = stored?.monitors?.filter(monitor => monitor.published)
      .map(monitor => ({ ...publicMonitor(monitor, paused), historyFence: this.historyFence(monitor) })) ?? [];
    this.ctx.storage.sql.exec("DELETE FROM status_publication WHERE kind = 'baseline-incident'");
    if (monitors.length) this.ctx.storage.sql.exec(
      `INSERT INTO status_publication (kind, position, data)
       SELECT 'baseline-incident', ROW_NUMBER() OVER (ORDER BY openedAt DESC, id), json_object('id', id, 'monitorId', monitorId,
         'monitorName', monitorName, 'openedAt', openedAt, 'closedAt', closedAt)
       FROM incidents WHERE openedAt < ? AND (closedAt IS NULL OR closedAt > ?)
       AND monitorId IN (SELECT value FROM json_each(?))`,
      historyStart(at) + 90 * DAY, historyStart(at), JSON.stringify(monitors.map(monitor => monitor.id)),
    );
    const baseline: StatusBaseline = { revision, at, loggedBefore, monitors, pageName: stored?.pageName ?? "Irisbeat", paused, publication };
    this.ctx.storage.kv.put("status-baseline", baseline);
  }

  // Fence the elapsed window before any later transaction can change its public inputs.
  private sealStatusWindow(clock: ViewClock, at: number) {
    const pending = this.pendingStatus();
    if (!pending) return;
    const end = this.statusPublicationAt(pending);
    if (end > at) return;
    const prior = this.statusBaseline()?.publication;
    this.captureStatusBaseline(clock.public, (clock.day ?? Math.floor(pending.since / DAY)) * DAY, end / 1000, {
      dueAt: prior?.dueAt ?? end,
      scopes: mergeScopes(prior?.scopes ?? [], pending.scopes),
    });
    this.ctx.storage.kv.delete("status-pending");
  }

  private statusBaseline() {
    return this.ctx.storage.kv.get<StatusBaseline>("status-baseline");
  }

  private publicationRows<T>(kind: string) {
    return [...this.ctx.storage.sql.exec<{ data: string }>(
      "SELECT data FROM status_publication WHERE kind = ? ORDER BY position", kind,
    )].map(row => JSON.parse(row.data) as T);
  }

  private historyFence(monitor: Monitor): HistoryFence {
    return { id: monitor.id, revision: monitor.historyRevision ?? 0, changedAt: monitor.historyChangedAt };
  }

  private loadPublishedStatus(): PublishedStatus | undefined {
    if (this.publishedStatus) return this.publishedStatus;
    const meta = this.ctx.storage.kv.get<PublishedStatusMeta & { generation?: number; at?: number }>("status-published");
    if (!meta) return;
    const { revision, generation, at, loggedBefore, ...fields } = meta;
    const history = new Map<string, PublishedHistory>();
    const monitors = this.publicationRows<StatusProjection["monitors"][number] & { historyFence?: PublishedHistory }>("monitor")
      .map(({ historyFence, ...monitor }) => {
        history.set(monitor.id, historyFence ?? { id: monitor.id, revision: 0, retryAt: 0 });
        // Publications from the SQLite build may contain aggregates from the retired table.
        return { ...monitor, history: generation === undefined ? null : monitor.history };
      });
    return this.publishedStatus = {
      revision, generation: generation ?? 0, at: at ?? Date.now(), loggedBefore, history,
      data: { ...fields, monitors, monitor: monitors[0] ?? null, incidents: this.publicationRows<Incident>("incident") },
      renders: new Map(),
    };
  }

  private storePublicRow(monitor: StatusProjection["monitors"][number], position: number, historyFence: PublishedHistory) {
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO status_publication VALUES ('monitor', ?, ?)", position,
      JSON.stringify({ ...monitor, historyFence }));
  }

  private savePublication(input: PublicationInput, previous: PublishedStatus | undefined, scopes: ViewScope[] = []) {
    const { revision, at, loggedBefore, data, history } = input;
    const generation = (previous?.generation ?? 0) + 1;
    const renders = new Map<StatusResource, StatusRender>();
    for (const scope of scopes) renders.set(scope, renderStatus(scope, data, revision));
    this.ctx.storage.transactionSync(() => {
      const { pageName, paused, monitors, incidents } = data;
      this.ctx.storage.sql.exec("DELETE FROM status_publication");
      monitors.forEach((monitor, position) => this.storePublicRow(monitor, position, history.get(monitor.id)!));
      incidents.forEach((incident, position) => this.ctx.storage.sql.exec(
        "INSERT INTO status_publication VALUES ('incident', ?, ?)", position, JSON.stringify(incident),
      ));
      this.ctx.storage.kv.put("status-published", { revision, generation, at, loggedBefore, pageName, paused });
      this.ctx.storage.kv.delete("status-baseline");
    });
    const published = this.publishedStatus = { ...input, generation, renders };
    if (scopes.length) {
      try {
        this.onStatusPublished({ type: "changed", scopes, revision });
      } catch {
        console.error(JSON.stringify({ event: "status_publication_hook_failed", revision }));
      }
    }
    return published;
  }

  protected onStatusPublished(hint: ViewHint) {
    this.broadcast("public", { public: hint });
  }

  private capturePublicationInput(state: StoredContext, revision: number, at: number): PublicationInput {
    const data = this.project(state, false, false, at);
    const history = new Map(state.monitors.filter(monitor => monitor.published).map(monitor => [monitor.id, this.historyFence(monitor)]));
    return { revision, at, loggedBefore: Math.floor(at / 1000), data, history };
  }

  private baselinePublicationInput(baseline: StatusBaseline): PublicationInput {
    const { revision, at, pageName, paused, publication } = baseline;
    const loggedBefore = baseline.loggedBefore ?? (publication && publication.dueAt / 1000);
    const history = new Map<string, PublishedHistory>();
    const monitors = baseline.monitors.map(({ historyFence, ...monitor }) => {
      history.set(monitor.id, historyFence ?? { id: monitor.id, revision: 0 });
      return { ...monitor, history: null };
    });
    return { revision, at, loggedBefore, history, data: {
      pageName, paused, monitors, monitor: monitors[0] ?? null, incidents: this.publicationRows<Incident>("baseline-incident"),
    } };
  }

  private async advanceStatusPublication(state: StoredContext, now: number) {
    const revision = this.viewClock().public;
    if (this.statusPublicationAt() <= now) {
      this.ctx.storage.transactionSync(() => this.sealStatusWindow(this.viewClock(), now));
    }
    const previous = this.loadPublishedStatus();
    const baseline = this.statusBaseline();
    if (previous && !baseline?.publication) return previous;
    const input = baseline ? this.baselinePublicationInput(baseline) : this.capturePublicationInput(state, revision, now);
    const enriched = await this.attachPublicationHistory(input, previous, now);

    const current = this.loadPublishedStatus();
    const retained = this.statusBaseline();
    // A later sealed window can supersede this one. An open window cannot change its inputs.
    if ((current && current.revision >= input.revision) ||
        retained?.revision !== baseline?.revision || retained?.publication?.dueAt !== baseline?.publication?.dueAt ||
        (!baseline && this.viewClock().public !== revision)) {
      if (this.eligiblePublicationAt() <= now) this.publicationRetryAt = Date.now() + 1_000;
      return current;
    }
    this.publicationRetryAt = 0;
    return this.savePublication(enriched, current, baseline?.publication?.scopes);
  }

  private async attachPublicationHistory(input: PublicationInput, previous: PublishedStatus | undefined, now: number): Promise<PublicationInput> {
    const fallback = new Map<string, AvailabilityHistory | null>();
    const resolved = new Map<string, AvailabilityHistory | null>();
    if (previous && historyStart(previous.at) === historyStart(input.at)) {
      for (const { id, history } of previous.data.monitors) {
        if (history && (previous.history.get(id)?.revision ?? Infinity) <= (input.history.get(id)?.revision ?? -Infinity)) {
          if (!history.stale && !history.pending && previous.history.get(id)?.revision === input.history.get(id)?.revision)
            resolved.set(id, history);
          else fallback.set(id, history);
        }
      }
    }
    const fences = [...input.history.values()].filter(fence => !resolved.has(fence.id));
    for (const [id, history] of await this.availability.readPublished(fences, input.at, input.loggedBefore, now, fallback)) {
      resolved.set(id, history);
      input.history.get(id)!.retryAt = now + availabilityRetryAfter;
    }
    return { ...input, data: attachAvailability(input.data, resolved) };
  }

  private async retryPublishedHistory(published: PublishedStatus, resource: StatusRequest, now: number) {
    const resources = Array.isArray(resource) ? resource : [resource];
    const all = resources.some(scope => scope === "/" || scope === "snapshot" || scope === "/api/status" || scope === "monitors");
    const rows = resources.filter(scope => scope.startsWith("monitor/"));
    if (!all && !rows.length) return;
    const retry = published.data.monitors.flatMap((monitor, position) => {
      const fence = published.history.get(monitor.id)!;
      return (all || rows.includes(`monitor/${monitor.id}`)) && (!monitor.history || monitor.history.stale || monitor.history.pending) &&
        now >= (fence.retryAt ?? 0) ? [{ monitor, position, fence }] : [];
    });
    if (!retry.length) return;
    this.ctx.storage.transactionSync(() => {
      for (const { monitor, position, fence } of retry) {
        fence.retryAt = now + availabilityRetryAfter;
        this.storePublicRow(monitor, position, fence);
      }
    });
    const result = await this.availability.readPublished(retry.map(({ fence }) => fence), published.at, published.loggedBefore, now,
      new Map(retry.map(({ monitor }) => [monitor.id, monitor.history])));
    const current = this.loadPublishedStatus();
    if (!current || current.revision !== published.revision || current.at !== published.at) return;
    const monitors = [...current.data.monitors];
    const changes = retry.filter(({ monitor, position, fence }) => current.data.monitors[position] === monitor &&
      current.history.get(monitor.id) === fence && fence.retryAt === now + availabilityRetryAfter &&
      JSON.stringify(result.get(monitor.id)) !== JSON.stringify(monitor.history));
    if (!changes.length) return;
    const generation = current.generation + 1;
    const { revision, at, loggedBefore, data } = current;
    this.ctx.storage.transactionSync(() => {
      for (const { monitor, position, fence } of changes) {
        monitors[position] = { ...monitor, history: result.get(monitor.id) ?? null };
        this.storePublicRow(monitors[position], position, fence);
      }
      this.ctx.storage.kv.put("status-published", { revision, generation, at, loggedBefore, pageName: data.pageName, paused: data.paused });
    });
    this.publishedStatus = { ...current, generation, data: { ...data, monitors, monitor: monitors[0] ?? null }, renders: new Map() };
  }

  // Resolve the durable render version before the HTTP Worker looks in its regional cache.
  async statusPublicationRevision(resource: StatusRequest = "/api/status", minimum = 0) {
    if (!this.renderInterval) return { revision: this.viewClock().public, generation: 0, cacheSeconds: 0 };
    const now = Date.now();
    const state = this.read(now);
    const due = this.eligiblePublicationAt() <= now;
    let published = await this.advanceStatusPublication(state, now);
    if (due) this.scheduleSubscriptionAlarm();
    if (!published) published = await this.advanceStatusPublication(this.read(now), now);
    if (published && published.revision >= minimum) await this.retryPublishedHistory(published, resource, now);
    const eligible = this.loadPublishedStatus();
    return { revision: eligible?.revision ?? -1, generation: eligible?.generation ?? 0, cacheSeconds: this.renderInterval / 1000 };
  }

  // The synchronous publication hook can read the committed partials directly.
  readPublishedStatus(resource: StatusRequest, minimum: number) {
    const published = this.loadPublishedStatus();
    if (!published || published.revision < minimum) return null;
    const { data, renders, revision, generation } = published;
    const resources = Array.isArray(resource) ? resource : [resource];
    const cacheable = resources.every(scope => !scope.startsWith("monitor/") ||
      data.monitors.some(monitor => monitor.id === scope.slice("monitor/".length)));
    const existing = typeof resource === "string" ? renders.get(resource) : undefined;
    const render = existing ?? renderStatus(resource, data, revision);
    // Keep the in-memory render cache bounded by individual sections.
    if (!existing && cacheable && typeof resource === "string") renders.set(resource, render);
    return { revision, generation, ...render, cacheable };
  }

  async readLiveStatusRender(resource: StatusRequest, minimum: number) {
    if (resource === "/" || resource === "/api/status" || resource === "snapshot") {
      return renderStatus(resource, await this.status(), 0);
    }
    const { revision, data } = Array.isArray(resource) ? await this.readViews(resource, "public", minimum)
      : await this.readView(resource, "public", minimum);
    return revision < minimum ? null : renderStatus(resource, data, revision);
  }

  private viewClock(): ViewClock {
    return this.ctx.storage.kv.get<ViewClock>("view-clock") ?? { public: 0, reader: 0, editor: 0 };
  }

  // The write and revisions share one transaction. Only committed hints leave the DO.
  private commitViewChanges(write: () => ViewChanges, day?: number, at = Date.now()) {
    const { hints, revision } = this.ctx.storage.transactionSync(() => {
      const clock = this.viewClock();
      this.sealStatusWindow(clock, at);
      if (this.renderInterval && !this.ctx.storage.kv.get("status-published") && !this.statusBaseline())
        this.captureStatusBaseline(clock.public, (clock.day ?? Math.floor(at / DAY)) * DAY, Math.floor(at / 1000));
      const changes = write();
      const hints: Partial<Record<ViewAudience, ViewHint>> = {};
      for (const audience of ["public", "reader", "editor"] as const) {
        const scopes = mergeScopes([], changes[audience] ?? []);
        if (scopes.length) hints[audience] = { type: "changed", revision: ++clock[audience], scopes };
      }
      if (hints.public && this.renderInterval) {
        const pending = this.pendingStatus();
        const scopes = mergeScopes(pending?.scopes ?? [], hints.public.scopes);
        // Any pending record left after sealing retains its original deadline.
        if (!pending || scopes.length !== pending.scopes.length || scopes.some((scope, i) => scope !== pending.scopes[i]))
          this.ctx.storage.kv.put("status-pending", { since: pending?.since ?? at, scopes } satisfies PendingStatus);
      }
      if (day !== undefined) clock.day = day;
      else clock.day ??= Math.floor(at / DAY);
      if (day !== undefined || Object.keys(hints).length) this.ctx.storage.kv.put("view-clock", clock);
      if (Object.keys(hints).length) this.scheduleSubscriptionAlarm();
      return { hints, revision: clock.editor };
    });
    if (Object.keys(hints).length) {
      this.publishViewChanges(hints);
    }
    return { revision, scopes: hints.editor?.scopes ?? [] };
  }

  private unchangedView(scope: ViewScope): MutationAck {
    return { revision: this.viewClock().editor, scopes: [scope] };
  }

  protected publishViewChanges(hints: Partial<Record<ViewAudience, ViewHint>>) {
    if (hints.public && !this.renderInterval) this.broadcast("public", hints);
    if (hints.reader || hints.editor) this.broadcast("operator", hints);
  }

  private broadcast(audience: "public" | "operator", hints: Partial<Record<ViewAudience, ViewHint>>) {
    for (const socket of this.liveSockets(audience)) {
      try {
        const state = socket.deserializeAttachment() as Subscription;
        const hint = hints[audience === "public" ? "public" : state.permission ?? "reader"];
        if (!hint || (audience === "operator" && !state.authenticated)) continue;
        if (!state.pending) socket.send(JSON.stringify(hint));
        const queued = state.pending ? { ...hint, scopes: mergeScopes(state.queued?.scopes ?? [], hint.scopes) } : undefined;
        socket.serializeAttachment({ ...state, pending: true, queued });
      } catch { socket.close(1011, "Subscription closed"); }
    }
  }

  private read(at = Date.now(), expiry: { pending?: Promise<void>[]; suppress?: boolean } = {}): StoredContext {
    const stored = this.ctx.storage.kv.get<StoredContext | LegacyContext>("context");
    if (!stored) return { pageName: "Irisbeat", monitors: [] };
    if ("monitors" in stored) {
      const now = Date.now();
      const expireThrough = Math.max(at, now);
      stored.monitors = stored.monitors.map(monitor => { monitor.kind ??= "http"; return { ...timingDefaults, scheduleMode: "interval", ...monitor, createdAt: monitor.createdAt ?? 0, lastSeen: monitor.lastSeen ?? null, recoveryReceiptAt: monitor.recoveryReceiptAt ?? null }; });
      const migrated = this.migrateDestinations(stored);
      const expired = stored.monitors.flatMap(monitor => {
        const window = monitor.maintenance;
        return window && expireThrough >= window.endsAt ? [{ monitor, window, order: 0 }] : [];
      });
      const day = Math.floor(now / DAY);
      const savedDay = this.viewClock().day;
      if (!migrated && !expired.length && savedDay !== undefined && savedDay >= day) return stored;
      const previousDay = savedDay ?? Math.min(day, ...expired.map(({ window }) => Math.floor(window.endsAt / DAY)));
      const windows = new Map<number, { at: number; day?: number; expired: typeof expired }>();
      const groupAt = (effectiveAt: number) => {
        const end = this.renderInterval ? statusWindowEnd(effectiveAt, this.renderInterval) : 0;
        let group = windows.get(end);
        if (!group) windows.set(end, group = { at: effectiveAt, expired: [] });
        group.at = Math.min(group.at, effectiveAt);
        return group;
      };
      for (const event of expired) groupAt(Math.min(event.window.endsAt, now)).expired.push(event);
      if (previousDay < day) {
        // Skipped days coalesce, but today's open window must preserve yesterday's eligible history.
        if (this.renderInterval && previousDay < day - 1 && now < statusWindowEnd(day * DAY, this.renderInterval)
          && stored.monitors.some(monitor => monitor.published))
          groupAt((day - 1) * DAY).day = day - 1;
        groupAt(day * DAY).day = day;
      } else if (savedDay === undefined) {
        groupAt(now).day = day;
      }
      if (migrated && !windows.size) groupAt(now);
      for (const [, group] of [...windows].sort(([a], [b]) => a - b)) this.commitViewChanges(() => {
        // Persist each window before its successor can seal those inputs.
        for (const event of group.expired) {
          const { monitor, window } = event;
          this.endMaintenance(monitor);
          event.order = this.nextNotificationOrder(stored);
          if (monitor.kind !== "heartbeat" || monitor.scheduleMode === "calendar") continue;
          // Watchdog silence uses scheduled time, even when a wall-clock read expires the window first.
          this.ctx.storage.sql.exec("DELETE FROM calendar_maintenance WHERE monitorId = ? AND endsAt <= ?", monitor.id, historyStart(at));
          this.ctx.storage.sql.exec("INSERT INTO calendar_maintenance (monitorId, startedAt, endsAt) VALUES (?, ?, ?)", monitor.id, window.startedAt, window.endsAt);
        }
        if (migrated || group.expired.length) this.ctx.storage.kv.put("context", stored);
        const scopes = (monitors: Monitor[], expiredMonitors: Monitor[]): ViewScope[] => {
          if (group.day !== undefined && group.day > previousDay && monitors.length) return ["monitors", "incidents", "banner"];
          return expiredMonitors.length ? ["banner", ...expiredMonitors.map(monitor => `monitor/${monitor.id}` as const)] : [];
        };
        const expiredMonitors = group.expired.map(({ monitor }) => monitor);
        const operator = scopes(stored.monitors, expiredMonitors).filter(scope => scope !== "banner");
        return { public: scopes(stored.monitors.filter(monitor => monitor.published), expiredMonitors.filter(monitor => monitor.published)),
          reader: operator, editor: operator };
      }, group.day, group.at);
      for (const { monitor, window, order } of expired) {
        if (stored.paused || expiry.suppress || !monitor.notificationSelections?.length) continue;
        const send = this.enqueueNotifications(monitor, stored.pauseGeneration ?? 0, {
          id: crypto.randomUUID(),
          kind: "maintenance.ended",
          reason: "expired",
          at: window.endsAt,
          order,
          monitorName: monitor.name,
          ...window,
        });
        // Synchronous readers still tie the post-commit handoff to their runtime lifetime.
        if (expiry.pending) expiry.pending.push(send);
        else this.ctx.waitUntil(send);
      }
      return stored;
    }
    const { monitor: legacyMonitor, ...context } = stored;
    const pageName = legacyMonitor?.pageName ?? "Irisbeat";
    const state: StoredContext = {
      ...context,
      pageName,
      monitors: [],
    };
    // Preserve the legacy ID, detector progress and Incident identity on upgrade.
    if (stored.monitor) {
      stored.monitor.kind ??= "http";
      const { pageName: _pageName, ...monitor } = stored.monitor;
      state.monitors.push({ ...timingDefaults, scheduleMode: "interval", ...monitor, createdAt: monitor.createdAt ?? 0, lastSeen: monitor.lastSeen ?? null, recoveryReceiptAt: monitor.recoveryReceiptAt ?? null, published: true });
    }
    this.migrateDestinations(state);
    this.ctx.storage.transactionSync(() => {
      if (stored.monitor) this.ctx.storage.sql.exec(
        "UPDATE incidents SET monitorName = ? WHERE monitorId = ? AND monitorName IS NULL",
        stored.monitor.name, stored.monitor.id,
      );
      this.ctx.storage.kv.put("context", state);
    });
    return this.read(at, expiry);
  }

  setPaused(paused: boolean, policyRevision: number) {
    if (!validPolicy({ paused, policyRevision }) || typeof paused !== "boolean") throw new Error("Invalid pause policy");
    const prior = this.ctx.storage.kv.get<StoredContext>("context");
    if (prior?.policyRevision !== undefined) {
      if (policyRevision < prior.policyRevision) return;
      if (policyRevision === prior.policyRevision) {
        if (!!prior.paused !== paused) throw new Error("Conflicting pause policy");
        return;
      }
    }
    // Compare and persist policy together, without awaiting external I/O or another RPC.
    const state = this.read(Date.now(), { suppress: paused });
    state.policyRevision = policyRevision;
    if (!!state.paused === paused) {
      this.ctx.storage.kv.put("context", state);
      return;
    }
    this.commitViewChanges(() => {
      state.paused = paused;
      state.pauseGeneration = (state.pauseGeneration ?? 0) + 1;
      if (!paused) {
        for (const monitor of state.monitors) {
          monitor.failures = 0;
          monitor.successes = 0;
          monitor.recoveryReceiptAt = null;
          if (monitor.scheduleMode === "calendar") {
            monitor.nextDue = calendar(monitor.cron, monitor.timezone).next(Date.now())[0];
            this.resetCalendarEvidence(monitor);
          }
        }
      }
      this.ctx.storage.kv.put("context", state);
      return sharedScopes("monitors", "banner");
    });
    if (paused) for (const attempt of this.checking.values()) attempt.paused = true;
  }

  async previewSchedule(input: unknown) {
    try {
      const value = input as Record<string, unknown>;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Enter a valid Calendar Schedule");
      const after = value.after === undefined ? Date.now() : value.after;
      if (typeof after !== "number" || !Number.isSafeInteger(after) || after < 0 || after > Date.UTC(9990, 0, 1)) throw new Error("Enter a valid preview timestamp");
      const parsed = calendar(value.cron, value.timezone === undefined ? "UTC" : value.timezone);
      if ("graceSeconds" in value && (typeof value.graceSeconds !== "number" || !Number.isInteger(value.graceSeconds) || value.graceSeconds < 1 || value.graceSeconds > 86400 || !await parsed.acceptsGraceAsync(value.graceSeconds, after)))
        throw new Error("Grace must be 1–86400 whole seconds and shorter than every occurrence gap");
      const floor = minimumCheckIntervalSeconds(this.env.MIN_CHECK_INTERVAL_SECONDS);
      if (value.outbound === true && !await parsed.acceptsMinimumGap(floor, after))
        throw new Error(`Calendar occurrences must be at least ${floor} seconds apart`);
      return { cron: parsed.cron, timezone: parsed.timezone, explanation: parsed.explanation, occurrences: parsed.next(after, 3) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Enter a valid Calendar Schedule" };
    }
  }

  private monitorConfigurations = new MonitorConfigurations({
    minimumCheckIntervalSeconds: () => minimumCheckIntervalSeconds(this.env.MIN_CHECK_INTERVAL_SECONDS),
    read: () => this.read(),
    commit: (state: StoredContext, previousName: string, previous?: Monitor, current?: Monitor) => {
      return this.commitViewChanges(() => {
        if (current && previous && current.scheduleRevision !== previous.scheduleRevision) this.resetCalendarEvidence(current);
        this.ctx.storage.kv.put("context", state);
        return configurationScopes(previous, current, state.pageName !== previousName);
      });
    },
  });

  async configure(value: unknown, expectedMonitorId: string | null = null) {
    return this.monitorConfigurations.configure(value, expectedMonitorId);
  }

  async create(value: unknown, limit?: number) {
    return this.monitorConfigurations.create(value, limit);
  }

  private migrateDestinations(state: StoredContext) {
    let changed = state.webhookUrl !== undefined;
    if (state.webhookUrl) {
      const id = crypto.randomUUID();
      state.legacyDestinationId = id;
      state.destinations = [{ id, name: "Webhook 1", channel: "webhook", url: state.webhookUrl }];
    }
    delete state.webhookUrl;
    const destinations = state.destinations ?? [];
    if (destinations.some(destination => !destination.name)) {
      const used = new Set(destinations.flatMap(destination => destination.name ? [destination.name.toLowerCase()] : []));
      for (const destination of destinations) {
        if (destination.name) continue;
        destination.name = nextDestinationName(destination.channel, used);
        used.add(destination.name.toLowerCase());
      }
      changed = true;
    }
    return changed;
  }

  async configureDestination(id: string | null, update: DestinationUpdate | null, legacy = false, origin?: string) {
    const state = this.read();
    const destinationId = legacy ? state.legacyDestinationId : id;
    const destinations = state.destinations ?? [];
    const existing = destinations.find(destination => destination.id === destinationId);
    if (destinationId && !existing) return null;
    const name = update?.name;
    const address = update && "channel" in update ? update : null;
    const matchingName = name && new RegExp("^" + name.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&") + "$", "iu");
    if (matchingName && destinations.some(destination => destination !== existing && matchingName.test(destination.name)))
      return "duplicate-name" as const;
    const sameAddress = address?.channel === "webhook" && existing?.channel === "webhook" && existing.url === address.url ||
      address?.channel === "email" && existing?.channel === "email" && existing.address === address.address;
    if (existing && (sameAddress || (update && !address))) {
      if (!name || name === existing.name) return this.unchangedView("destinations");
      return this.commitViewChanges(() => {
        existing.name = name;
        this.ctx.storage.kv.put("context", state);
        return { editor: ["destinations"] };
      });
    }
    const replacement = address && {
      id: crypto.randomUUID(), ...(address.channel === "email" ? { ...address, confirmed: false } : address),
      name: name ?? existing?.name ?? nextDestinationName(address.channel, new Set(destinations.map(destination => destination.name.toLowerCase()))),
    };
    let job: ConfirmationJob | undefined;
    if (replacement?.channel === "email") {
      if (destinations.some(destination => destination !== existing && destination.channel === "email" &&
          destination.address.toLowerCase() === replacement.address.toLowerCase())) return "duplicate" as const;
      if (!origin) return "unconfigured" as const;
      if (!state.paused) {
        job = this.prepareConfirmation(state, replacement, origin);
        if (!job) return "cooldown" as const;
      }
    }
    state.destinations = existing
      ? destinations.flatMap(destination => destination !== existing ? [destination] : replacement ? [replacement] : [])
      : replacement ? [...destinations, replacement] : destinations;
    if (legacy || (existing && existing.id === state.legacyDestinationId)) {
      state.legacyDestinationId = replacement?.channel === "webhook" ? replacement.id : undefined;
    }
    const editorScopes: ViewScope[] = ["destinations"];
    if (existing) {
      if (state.emailConfirmations) delete state.emailConfirmations[existing.id];
      if (state.emailWithdrawals) delete state.emailWithdrawals[existing.id];
      for (const monitor of state.monitors) {
        if (monitor.notificationSelections?.some(selection => selection.destinationId === existing.id)) {
          monitor.notificationSelections = monitor.notificationSelections.filter(selection => selection.destinationId !== existing.id);
          editorScopes.push(`monitor/${monitor.id}`);
        }
      }
    }
    const ack = this.commitViewChanges(() => {
      this.ctx.storage.kv.put("context", state);
      return replacement || existing ? { editor: editorScopes } : {};
    });
    if (job) await this.enqueueConfirmation(job);
    return ack;
  }

  async resendConfirmation(id: string, origin: string) {
    const state = this.read();
    const destination = state.destinations?.find(candidate => candidate.id === id);
    if (destination?.channel !== "email" || destination.confirmed) return null;
    if (state.paused) return "paused" as const;
    const job = this.prepareConfirmation(state, destination, origin);
    if (!job) return "cooldown" as const;
    this.ctx.storage.kv.put("context", state);
    await this.enqueueConfirmation(job);
    return this.unchangedView("destinations");
  }

  private prepareConfirmation(state: StoredContext, destination: Extract<NotificationDestination, { channel: "email" }>, origin: string) {
    const at = Date.now();
    const inbox = destination.address.toLowerCase();
    if ((state.confirmationCooldowns?.[inbox] ?? 0) > at) return;
    state.confirmationCooldowns = Object.fromEntries(Object.entries(state.confirmationCooldowns ?? {})
      .filter(([, until]) => until > at));
    state.confirmationCooldowns[inbox] = at + CONFIRMATION_COOLDOWN;
    const id = crypto.randomUUID();
    (state.emailConfirmations ??= {})[destination.id] = { id, origin, token: crypto.randomUUID(), expiresAt: at + DAY };
    return {
      kind: "email.confirmation", destinationId: destination.id, deliveryId: id, at,
      order: this.nextNotificationOrder(state),
      contextId: this.ctx.id.toString(), pauseGeneration: state.pauseGeneration ?? 0,
    } satisfies ConfirmationJob;
  }

  private async enqueueConfirmation(job: ConfirmationJob) {
    try {
      if (!this.env.NOTIFICATION_QUEUE) throw new Error("Queue binding unavailable");
      await this.env.NOTIFICATION_QUEUE.sendBatch([{ body: job }]);
    } catch {
      console.error(JSON.stringify({ event: "notification_enqueue_failed", kind: job.kind }));
    }
  }

  private currentConfirmation(state: StoredContext, job: ConfirmationIdentity) {
    if (job.contextId !== this.ctx.id.toString() || state.paused ||
        (state.pauseGeneration ?? 0) !== job.pauseGeneration) return null;
    const invitation = state.emailConfirmations?.[job.destinationId];
    if (invitation?.id !== job.deliveryId || invitation.expiresAt <= Date.now() || invitation.submitted) return null;
    const destination = state.destinations?.find(candidate => candidate.id === job.destinationId);
    return destination?.channel === "email" && !destination.confirmed ? { invitation, address: destination.address } : null;
  }

  resolveConfirmation(job: ConfirmationJob) {
    const current = this.currentConfirmation(this.read(), job);
    if (!current) return null;
    return {
      address: current.address,
      url: new URL(recipientAction.confirm.path + "#" + current.invitation.token, current.invitation.origin).href,
    };
  }

  markConfirmationSubmitted(job: ConfirmationIdentity) {
    const state = this.read();
    const current = this.currentConfirmation(state, job);
    if (!current) return;
    current.invitation.submitted = true;
    this.ctx.storage.kv.put("context", state);
  }

  confirmEmail(token: string, origin: string) {
    const state = this.read();
    const now = Date.now();
    const destination = state.destinations?.find(candidate => {
      const invitation = state.emailConfirmations?.[candidate.id];
      return candidate.channel === "email" && !candidate.confirmed &&
        invitation?.token === token && invitation.origin === origin && invitation.expiresAt > now;
    });
    if (destination?.channel !== "email") return false;
    destination.confirmed = true;
    (state.emailWithdrawals ??= {})[destination.id] = { token: crypto.randomUUID(), origin };
    delete state.emailConfirmations?.[destination.id];
    this.commitViewChanges(() => {
      this.ctx.storage.kv.put("context", state);
      return { editor: ["destinations"] };
    });
    return true;
  }

  async unsubscribeEmail(token: string, origin: string) {
    const state = this.read();
    const destination = state.destinations?.find(candidate => {
      const withdrawal = state.emailWithdrawals?.[candidate.id];
      return candidate.channel === "email" && candidate.confirmed &&
        withdrawal?.token === token && withdrawal.origin === origin;
    });
    if (!destination) return false;
    await this.configureDestination(destination.id, null);
    return true;
  }

  async edit(id: string, value: unknown) {
    return this.monitorConfigurations.edit(id, value);
  }

  private endMaintenance(monitor: Monitor) {
    monitor.maintenance = null;
    // Calendar catch-up applies the reset at the retained window's chronological boundary.
    if (monitor.kind === "heartbeat" && monitor.scheduleMode === "calendar") return;
    monitor.failures = 0;
    monitor.successes = 0;
    monitor.recoveryReceiptAt = null;
  }

  async maintenance(id: string, value: unknown, end = false) {
    const at = Date.now();
    const state = this.read(at);
    const monitor = state.monitors.find(monitor => monitor.id === id);
    if (!monitor) return null;
    if (!end && (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).length !== 1 || !("endsAt" in value) ||
        typeof value.endsAt !== "number" || !Number.isSafeInteger(value.endsAt) ||
        value.endsAt <= at || value.endsAt > 8_640_000_000_000_000)) return undefined;
    const previous = monitor.maintenance;
    const next = end ? null : { startedAt: at, endsAt: (value as { endsAt: number }).endsAt };
    if (previous?.endsAt === next?.endsAt) return this.unchangedView(`monitor/${id}`);
    const order = this.nextNotificationOrder(state);
    const ack = this.commitViewChanges(() => {
      if (monitor.kind === "heartbeat" && monitor.scheduleMode === "calendar") {
        // Retain elapsed overlap when an operator cuts a window short or replaces it.
        this.ctx.storage.sql.exec("UPDATE calendar_maintenance SET endsAt = MIN(endsAt, ?) WHERE monitorId = ? AND endsAt > ?", at, id, at);
        if (next) this.ctx.storage.sql.exec("INSERT INTO calendar_maintenance (monitorId, startedAt, endsAt) VALUES (?, ?, ?)", id, next.startedAt, next.endsAt);
      }
      if (next) monitor.maintenance = next;
      else this.endMaintenance(monitor);
      this.ctx.storage.kv.put("context", state);
      return monitorScopes(monitor, `monitor/${id}`, "banner");
    });
    if (next) {
      const attempt = this.checking.get(id);
      if (attempt) attempt.maintenance = true;
    }
    if (!state.paused && monitor.notificationSelections?.length) {
      const event = { id: crypto.randomUUID(), at, order, monitorName: monitor.name };
      if (next) {
        await this.enqueueNotifications(monitor, state.pauseGeneration ?? 0, {
          ...event, ...next, ...(previous
            ? { kind: "maintenance.updated", previousEndsAt: previous.endsAt }
            : { kind: "maintenance.started" }),
        });
      } else if (previous) {
        await this.enqueueNotifications(monitor, state.pauseGeneration ?? 0, {
          ...event, ...previous, kind: "maintenance.ended", reason: "early",
        });
      }
    }
    return ack;
  }

  private clearCalendarEvidence(id: string) {
    this.ctx.storage.sql.exec("DELETE FROM calendar_receipts WHERE monitorId = ?", id);
    this.ctx.storage.sql.exec("DELETE FROM calendar_maintenance WHERE monitorId = ?", id);
  }

  private resetCalendarEvidence(monitor: Monitor) {
    this.clearCalendarEvidence(monitor.id);
    if (monitor.kind === "heartbeat" && monitor.scheduleMode === "calendar" && monitor.maintenance) {
      this.ctx.storage.sql.exec("INSERT INTO calendar_maintenance (monitorId, startedAt, endsAt) VALUES (?, ?, ?)", monitor.id, monitor.maintenance.startedAt, monitor.maintenance.endsAt);
    }
  }

  remove(id: string) {
    const state = this.read();
    const monitor = state.monitors.find(monitor => monitor.id === id);
    if (!monitor) return null;
    return this.commitViewChanges(() => {
      this.clearCalendarEvidence(id);
      this.availability.remove(id);
      state.monitors = state.monitors.filter(monitor => monitor.id !== id);
      this.ctx.storage.kv.put("context", state);
      return configurationScopes(monitor, undefined, false);
    });
  }

  // Keep overlap evidence with the running attempt even after a window is replaced or ends.
  private checking = new Map<string, { maintenance: boolean; paused: boolean }>();

  async prepareOutboundCalendars() {
    const floor = minimumCheckIntervalSeconds(this.env.MIN_CHECK_INTERVAL_SECONDS);
    if (floor === timingDefaults.intervalSeconds) return;
    const needsProof = (monitor: Monitor) => monitor.kind !== "heartbeat" && monitor.scheduleMode === "calendar" &&
      monitor.outboundCalendarFloor?.compatible !== false && monitor.outboundCalendarFloor?.seconds !== floor;
    for (;;) {
      const candidate = this.ctx.storage.kv.get<StoredContext>("context")?.monitors?.find(needsProof);
      if (!candidate) return;
      const compatible = await calendar(candidate.cron, candidate.timezone).acceptsMinimumGap(floor, Date.now());
      const state = this.read();
      // Another request may have changed the schedule while the proof was running.
      const matches = state.monitors.filter(monitor => needsProof(monitor) &&
        monitor.cron === candidate.cron && monitor.timezone === candidate.timezone);
      if (!matches.length) continue;
      this.commitViewChanges(() => {
        for (const monitor of matches) monitor.outboundCalendarFloor = { seconds: floor, compatible };
        this.ctx.storage.kv.put("context", state);
        const scopes = compatible ? [] : matches.map(({ id }) => `monitor/${id}` as const);
        return { reader: scopes, editor: scopes };
      });
    }
  }

  async check(at: number, writeLimit = availabilityWriteLimit) {
    const pending: Promise<void>[] = [];
    const { monitors } = this.read(Math.max(at, Date.now()), { pending });
    const calendarPolicy = this.prepareOutboundCalendars();
    await Promise.all([calendarPolicy, ...pending, ...monitors.map(async monitor => {
      if (monitor.kind !== "heartbeat" && monitor.scheduleMode === "calendar") await calendarPolicy;
      await this.checkMonitor(monitor.id, at);
    })]);
    if (this.availability.flushAt !== undefined) await this.scheduleSubscriptionAlarm();
    await this.drainAvailability(Math.min(writeLimit, availabilityWriteLimit));
  }

  protected outboundStartTime(_scheduledAt: number) {
    return Date.now();
  }

  private async checkMonitor(id: string, at: number) {
    const state = this.read(at);
    const attempt = state.monitors.find(monitor => monitor.id === id);
    if (!attempt || state.paused) return;
    if (attempt.kind === "heartbeat") {
      if (attempt.scheduleMode === "calendar") {
        await this.checkCalendarHeartbeat(id, at);
        return;
      }
      if (at >= (attempt.lastSeen ?? attempt.createdAt) + attempt.silenceSeconds * 1000) {
        attempt.recoveryReceiptAt = null;
        // Active Maintenance suppresses dispatch. Expired windows use the observation time.
        const maintenance = !!attempt.maintenance ||
          this.ctx.storage.sql.exec("SELECT 1 FROM calendar_maintenance WHERE monitorId = ? AND startedAt <= ? AND endsAt > ? LIMIT 1", id, at, at).toArray().length > 0;
        await this.record(state, attempt, at, false, 1, attempt.recoveryThreshold, maintenance);
      }
      return;
    }
    if (this.checking.has(id) || at < attempt.nextDue || attempt.outboundCalendarFloor?.compatible === false) return;
    const floor = minimumCheckIntervalSeconds(this.env.MIN_CHECK_INTERVAL_SECONDS) * 1000;
    const calendarMode = attempt.scheduleMode === "calendar";
    const earliest = calendarMode
      ? (attempt.lastOutboundCheckAt ?? attempt.lastResult?.at ?? -Infinity) + floor
      : Math.max(attempt.nextDue ? attempt.nextDue - attempt.intervalSeconds * 1000 : -Infinity,
        attempt.lastOutboundCheckAt ?? -Infinity) + floor;
    if (at < earliest) {
      if (calendarMode) {
        attempt.nextDue = calendar(attempt.cron, attempt.timezone).next(earliest - 1)[0];
        this.ctx.storage.kv.put("context", state);
      }
      return;
    }
    const nextDue = calendarMode ? calendar(attempt.cron, attempt.timezone).next(at)[0] : at + attempt.intervalSeconds * 1000;
    // Cron timestamps anchor observations and recurrence. The target sees wall-clock starts.
    const startedAt = this.outboundStartTime(at);
    if (startedAt < (attempt.lastOutboundStartedAt ?? -Infinity) + floor) {
      if (calendarMode) {
        attempt.nextDue = nextDue;
        this.ctx.storage.kv.put("context", state);
      }
      return;
    }
    const observation = { maintenance: !!attempt.maintenance, paused: false };
    this.checking.set(id, observation);
    attempt.lastOutboundCheckAt = at;
    attempt.lastOutboundStartedAt = startedAt;
    attempt.nextDue = nextDue;
    this.ctx.storage.kv.put("context", state);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), attempt.timeoutSeconds * 1000);
    let success = false;
    let socket: Socket | undefined;
    try {
      if (attempt.kind === "tcp") {
        const hostname = attempt.hostname.includes(":") ? `[${attempt.hostname}]` : attempt.hostname;
        socket = connect({ hostname, port: attempt.port });
        void socket.closed.catch(() => {});
        await Promise.race([
          socket.opened,
          new Promise<never>((_resolve, reject) => {
            controller.signal.addEventListener("abort", () => reject(new Error("TCP timeout")), { once: true });
          }),
        ]);
        success = true;
      } else {
        const response = await fetch(attempt.url, {
          method: "GET",
          signal: controller.signal,
          redirect: "follow",
        });
        success = response.status >= 200 && response.status < 300;
        await response.body?.cancel();
      }
    } catch {
      success = false;
    } finally {
      clearTimeout(timeout);
      if (socket) {
        // Native close can wait for connection establishment past our observation deadline.
        const closing = socket;
        this.ctx.waitUntil(Promise.resolve().then(() => closing.close()).catch(() => {}));
      }
      this.checking.delete(id);
    }
    const current = this.read(Math.max(at, Date.now()));
    // Record the executed attempt without overwriting newer configuration.
    const monitor = current.monitors.find(monitor => monitor.id === attempt.id);
    if (!monitor || current.paused || observation.paused) return;
    await this.record(current, monitor, at, success, attempt.failureThreshold, attempt.recoveryThreshold, observation.maintenance, (monitor.scheduleRevision ?? 0) !== (attempt.scheduleRevision ?? 0));
  }

  private calendarChecking = new Set<string>();

  private async checkCalendarHeartbeat(id: string, at: number) {
    if (this.calendarChecking.has(id)) return;
    this.calendarChecking.add(id);
    const initial = this.read(at);
    const revision = initial.monitors.find(monitor => monitor.id === id)?.scheduleRevision ?? 0;
    const pauseGeneration = initial.pauseGeneration ?? 0;
    try {
      // Persist the cursor with each outcome before delivery; later dispatch resumes the batch.
      for (let processed = 0; processed < 128; processed++) {
        const current = this.read(at);
        const monitor = current.monitors.find(monitor => monitor.id === id);
        if (!monitor || current.paused || (current.pauseGeneration ?? 0) !== pauseGeneration || monitor.scheduleMode !== "calendar" || (monitor.scheduleRevision ?? 0) !== revision) return;
        const occurrence = monitor.nextDue;
        const deadline = occurrence + monitor.graceSeconds * 1000;
        if (at <= deadline) return;
        const success = this.ctx.storage.sql.exec("SELECT 1 FROM calendar_receipts WHERE monitorId = ? AND occurrence = ?", id, occurrence).toArray().length > 0;
        const maintenance = this.ctx.storage.sql.exec("SELECT 1 FROM calendar_maintenance WHERE monitorId = ? AND startedAt <= ? AND endsAt > ? AND endsAt > startedAt LIMIT 1", id, deadline, occurrence).toArray().length > 0;
        monitor.nextDue = calendar(monitor.cron, monitor.timezone).next(occurrence)[0];
        const endedBetweenWindows = this.ctx.storage.sql.exec("SELECT 1 FROM calendar_maintenance WHERE monitorId = ? AND endsAt > ? AND endsAt <= ? LIMIT 1", id, monitor.lastResult?.at ?? monitor.createdAt, occurrence).toArray().length > 0;
        if (maintenance || endedBetweenWindows) { monitor.failures = 0; monitor.successes = 0; }
        await this.record(current, monitor, deadline, success, 1, monitor.recoveryThreshold, maintenance);
      }
    } finally {
      this.calendarChecking.delete(id);
    }
  }

  private async record(current: StoredContext, monitor: Monitor, at: number, success: boolean, failureThreshold: number, recoveryThreshold: number, maintenance = !!monitor.maintenance, resetProgress = false) {
    if (current.paused) return;
    const pauseGeneration = current.pauseGeneration ?? 0;
    let transition: "opened" | "recovered" | undefined;
    let transitionedIncident: Pick<Incident, "id" | "openedAt"> | undefined;
    let order: number | undefined;
    const observation = { at, outcome: maintenance ? "maintenance" : success ? "success" : "failure" } as const;
    const now = Date.now();
    const inRange = this.availability.configured && at >= historyStart(Math.max(at, now));
    this.commitViewChanges(() => {
      const previousState = monitor.state;
      monitor.lastResult = observation;
      if (inRange) {
        monitor.historyRevision = (monitor.historyRevision ?? 0) + 1;
        monitor.historyChangedAt = now;
        monitor.historyRetryToken = crypto.randomUUID();
        this.availability.enqueue(monitor.id, observation);
      }
      if (monitor.kind === "heartbeat" && monitor.scheduleMode === "calendar") {
        this.ctx.storage.sql.exec("DELETE FROM calendar_receipts WHERE monitorId = ? AND occurrence < ?", monitor.id, monitor.nextDue);
        this.ctx.storage.sql.exec("DELETE FROM calendar_maintenance WHERE monitorId = ? AND endsAt <= ?", monitor.id, at);
      }
      if (maintenance) {
        this.ctx.storage.kv.put("context", current);
        return monitorScopes(monitor, `monitor/${monitor.id}`);
      }
      monitor.failures = success ? 0 : monitor.failures + 1;
      monitor.successes = success ? monitor.successes + 1 : 0;
      const open = this.ctx.storage.sql
        .exec<Incident>(
          "SELECT * FROM incidents WHERE monitorId = ? AND closedAt IS NULL LIMIT 1",
          monitor.id,
        )
        .toArray()[0];
      if (!open && monitor.failures >= failureThreshold) {
        transition = "opened";
        monitor.state = "down";
        const incidentId = crypto.randomUUID();
        transitionedIncident = { id: incidentId, openedAt: at };
        this.ctx.storage.sql.exec(
          "INSERT INTO incidents (id, monitorId, openedAt, monitorName) VALUES (?, ?, ?, ?)",
          incidentId,
          monitor.id,
          at,
          monitor.name,
        );
      } else if (open && monitor.successes >= recoveryThreshold) {
        this.ctx.storage.sql.exec(
          "UPDATE incidents SET closedAt = ? WHERE id = ?",
          at,
          open.id,
        );
        transition = "recovered";
        transitionedIncident = open;
        monitor.state = "up";
      } else if (!open && success) {
        monitor.state = "up";
      }
      if (resetProgress) { monitor.failures = 0; monitor.successes = 0; }
      if (transition) order = this.nextNotificationOrder(current);
      this.ctx.storage.kv.put("context", current);
      const scopes: ViewScope[] = [`monitor/${monitor.id}`];
      if (transition) scopes.push("incidents");
      if (transition || previousState !== monitor.state) scopes.push("banner");
      return monitorScopes(monitor, ...scopes);
    });
    if (!transition || !transitionedIncident) return;
    if (monitor.notificationSelections?.length) {
      await this.enqueueNotifications(monitor, pauseGeneration, {
        id: transitionedIncident.id + ":" + transition,
        kind: transition === "opened" ? "incident.opened" : "incident.recovered",
        at,
        order,
        incidentId: transitionedIncident.id,
        openedAt: transitionedIncident.openedAt,
        monitorName: monitor.name,
      });
    }
  }

  private nextNotificationOrder(state: StoredContext) {
    state.notificationOrder = (state.notificationOrder ?? 0) + 1;
    return state.notificationOrder;
  }

  private async enqueueNotifications(monitor: Monitor, pauseGeneration: number, event: NotificationJob["event"]) {
    const contextId = this.ctx.id.toString();
    const jobs: NotificationJob[] = (monitor.notificationSelections ?? []).map(selection => ({
      ...selection, contextId, monitorId: monitor.id, pauseGeneration,
      deliveryId: event.id + ":" + selection.destinationId, event,
    }));
    // The storage output gate holds the Queue handoff until the transition is durable.
    for (let i = 0; i < jobs.length; i += 100) {
      try {
        if (!this.env.NOTIFICATION_QUEUE) throw new Error("Queue binding unavailable");
        await this.env.NOTIFICATION_QUEUE.sendBatch(jobs.slice(i, i + 100).map(body => ({ body })));
      } catch {
        console.error(JSON.stringify({ event: "notification_enqueue_failed", eventId: event.id }));
      }
    }
  }

  /** @deprecated Retained for source compatibility. The engine no longer calls this method. */
  protected async onIncidentTransition(_event: IncidentTransition): Promise<void> {}

  resolveAlert(job: NotificationEligibility): AlertDestination | null {
    if (job.contextId !== this.ctx.id.toString()) return null;
    const state = this.read();
    if (state.paused || (state.pauseGeneration ?? 0) !== job.pauseGeneration) return null;
    const selected = state.monitors.find(monitor => monitor.id === job.monitorId)?.notificationSelections;
    if (!selected?.some(selection => selection.destinationId === job.destinationId && selection.generation === job.generation)) return null;
    if (this.notificationCompleted(job.deliveryId)) return null;
    const destination = state.destinations?.find(candidate => candidate.id === job.destinationId);
    if (destination?.channel === "webhook") return { channel: "webhook", url: destination.url };
    if (destination?.channel !== "email" || !destination.confirmed) return null;
    let withdrawal = state.emailWithdrawals?.[destination.id];
    if (!withdrawal && this.ctx.id.equals(this.env.MONITORING.idFromName("personal"))) {
      const origin = notificationOrigin(this.env.NOTIFICATION_PUBLIC_ORIGIN);
      if (origin) {
        withdrawal = { token: crypto.randomUUID(), origin };
        (state.emailWithdrawals ??= {})[destination.id] = withdrawal;
        this.ctx.storage.kv.put("context", state);
      }
    }
    if (!withdrawal) return null;
    return {
      channel: "email", address: destination.address,
      unsubscribeUrl: new URL(recipientAction.unsubscribe.path + "#" + withdrawal.token, withdrawal.origin).href,
    };
  }

  resolveWebhook(job: NotificationEligibility) {
    const destination = this.resolveAlert(job);
    return destination?.channel === "webhook" ? destination.url : null;
  }

  protected notificationCompleted(deliveryId: string) {
    return this.ctx.storage.sql.exec("SELECT 1 FROM notification_completions WHERE deliveryId = ? AND expiresAt > ?", deliveryId, Date.now())
      .toArray().length > 0;
  }

  reportSubmission(job: NotificationDeliveryIdentity, report: SubmissionReport) {
    if (job.contextId !== this.ctx.id.toString()) return;
    const state = this.read();
    const destination = state.destinations?.find(destination => destination.id === job.destinationId);
    if (!destination) return;
    const accepted = report.result.status === "accepted";
    if (report.confirmation && (destination.channel !== "email" ||
        (state.emailConfirmations?.[destination.id]?.id !== job.deliveryId && !(accepted && destination.confirmed)))) return;
    const current = destination.submission;
    const terminal = report.result.status !== "retrying";
    const now = Date.now();
    this.commitViewChanges(() => {
      const sql = this.ctx.storage.sql;
      if (!accepted) {
        if (this.notificationCompleted(job.deliveryId)) return {};
        const [retry] = sql.exec<{ attempt: number; at: number }>(
          "SELECT attempt, at FROM notification_retries WHERE deliveryId = ? AND expiresAt > ?",
          job.deliveryId, now,
        ).toArray();
        // The latest Settings result may already be for a different event.
        const latest = retry ?? (current?.deliveryId === job.deliveryId
          ? { attempt: current.attempt, at: current.result.at } : undefined);
        if (latest) {
          const order = report.attempt - latest.attempt || report.result.at - latest.at;
          if (order < 0 || (order === 0 && !terminal)) return {};
        }
      }
      sql.exec("DELETE FROM notification_retries WHERE expiresAt <= ?", now);
      if (terminal) {
        // Retain completed identities through the maximum source Queue retention window.
        sql.exec("DELETE FROM notification_completions WHERE expiresAt <= ?", now);
        sql.exec("INSERT OR IGNORE INTO notification_completions VALUES (?, ?)", job.deliveryId, now + 14 * DAY);
        sql.exec("DELETE FROM notification_retries WHERE deliveryId = ?", job.deliveryId);
      } else {
        sql.exec("INSERT OR REPLACE INTO notification_retries VALUES (?, ?, ?, ?)",
          job.deliveryId, report.attempt, report.result.at, now + 14 * DAY);
      }
      // An unreported cancellation still closes the delivery against delayed retry reports.
      if (report.result.status === "canceled" &&
        (current?.deliveryId !== job.deliveryId || current.result.status !== "retrying")) return {};
      if (current?.deliveryId === job.deliveryId) {
        if (current.result.status === "accepted") return {};
      } else if (current) {
        const order = report.eventAt - current.eventAt ||
          (report.eventOrder ?? 0) - (current.eventOrder ?? 0) || report.queuedAt - current.queuedAt;
        if (order < 0 || (order === 0 && job.deliveryId < current.deliveryId)) return {};
      }
      const eventOrder = report.eventOrder ?? (current?.deliveryId === job.deliveryId ? current.eventOrder : undefined);
      destination.submission = { ...report, eventOrder, deliveryId: job.deliveryId };
      this.ctx.storage.kv.put("context", state);
      return { editor: ["destinations"] };
    });
  }

  async heartbeat(id: string, at: number) {
    const current = this.read();
    const monitor = current.monitors.find(monitor => monitor.id === id);
    if (!monitor || monitor.kind !== "heartbeat") return false;
    const freshnessChanged = monitor.lastSeen !== at;
    const commitFreshness = (occurrence?: number) => this.commitViewChanges(() => {
      if (occurrence !== undefined) this.ctx.storage.sql.exec("INSERT OR IGNORE INTO calendar_receipts (monitorId, occurrence) VALUES (?, ?)", id, occurrence);
      this.ctx.storage.kv.put("context", current);
      return freshnessChanged ? monitorScopes(monitor, `monitor/${id}`) : {};
    });
    monitor.lastSeen = at;
    if (monitor.scheduleMode === "calendar") {
      const occurrence = current.paused ? Infinity : calendar(monitor.cron, monitor.timezone).next(at - monitor.graceSeconds * 1000 - 1)[0];
      commitFreshness(occurrence <= at && occurrence >= monitor.nextDue ? occurrence : undefined);
    } else if (current.paused) {
      commitFreshness();
    } else if (monitor.maintenance) {
      await this.record(current, monitor, at, true, 1, monitor.recoveryThreshold, !!monitor.maintenance);
      await this.drainAvailability(1);
    } else if (monitor.state !== "down" || monitor.recoveryReceiptAt === null ||
        at >= monitor.recoveryReceiptAt + monitor.recoverySpacingSeconds * 1000) {
      monitor.recoveryReceiptAt = at;
      await this.record(current, monitor, at, true, 1, monitor.recoveryThreshold, !!monitor.maintenance);
      await this.drainAvailability(1);
    } else {
      commitFreshness();
    }
    return true;
  }

  async rotateHeartbeatSecret(id: string) {
    const secret = crypto.randomUUID() + crypto.randomUUID();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`Bearer ${secret}`));
    const state = this.read();
    const monitor = state.monitors.find(monitor => monitor.id === id && monitor.kind === "heartbeat");
    if (!monitor) return null;
    monitor.heartbeatDigest = digest;
    this.ctx.storage.kv.put("context", state);
    return { secret };
  }

  async hostedHeartbeat(authorization: string, at: number) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(authorization));
    // Read after hashing; rotation and deletion cannot interleave before heartbeat's synchronous commit.
    const monitor = this.read().monitors.find(monitor => monitor.kind === "heartbeat" && monitor.heartbeatDigest && crypto.subtle.timingSafeEqual(digest, monitor.heartbeatDigest));
    return monitor ? this.heartbeat(monitor.id, at) : false;
  }

  private availability = new Availability(this.env, this.ctx);

  availabilityReadiness() {
    return this.availability.readiness(this.read().monitors, Date.now());
  }

  private projectedMonitors(state: StoredContext, projection: StatusProjection) {
    const selected = new Set(projection.monitors.map(monitor => monitor.id));
    return state.monitors.filter(monitor => selected.has(monitor.id));
  }

  private readAvailability(state: StoredContext, projection: StatusProjection, at: number, operator: boolean) {
    return this.availability.read(this.projectedMonitors(state, projection), at, () => {
      const state = this.ctx.storage.kv.get<StoredContext>("context");
      return new Map(state?.monitors.filter(monitor => operator || monitor.published)
        .map(monitor => [monitor.id, monitor.historyRevision]));
    });
  }

  provisionEmailWithdrawals(origin: string) {
    // Confirmation-only builds discarded the invitation origin after consent.
    const state = this.ctx.storage.kv.get<StoredContext | LegacyContext>("context");
    if (!state || !("monitors" in state)) return;
    const missing = state.destinations?.filter(destination =>
      destination.channel === "email" && destination.confirmed && !state.emailWithdrawals?.[destination.id]);
    if (!missing?.length) return;
    const withdrawals = state.emailWithdrawals ??= {};
    for (const { id } of missing) withdrawals[id] = { token: crypto.randomUUID(), origin };
    this.ctx.storage.kv.put("context", state);
  }

  firstMonitorId() { return this.read().monitors[0]?.id ?? null; }

  snapshot(operator = false, secrets = operator) {
    const at = Date.now();
    const state = this.read(at);
    const data = this.project(state, operator, secrets, at);
    return attachAvailability(data, this.availability.cached(this.projectedMonitors(state, data), at));
  }

  async status(operator = false, secrets = operator): Promise<StatusProjection> {
    const at = Date.now();
    const state = this.read(at);
    const data = this.project(state, operator, secrets, at);
    return attachAvailability(data, await this.readAvailability(state, data, at, operator));
  }

  async readView(scope: ViewScope, audience: ViewAudience, minimum = 0) {
    return this.readViews([scope], audience, minimum);
  }

  async readViews(scopes: ViewScope[], audience: ViewAudience, minimum: number) {
    const at = Date.now();
    const state = this.read(at);
    const revision = this.viewClock()[audience];
    const operator = audience !== "public";
    const data = this.project(state, operator, audience === "editor", at, scopes);
    if (revision < minimum || !scopes.some(includesLedger)) return { revision, data };
    const monitors = scopes.includes("monitors") ? data.monitors
      : data.monitors.filter(monitor => scopes.includes(`monitor/${monitor.id}`));
    if (!monitors.length) return { revision, data };
    const history = await this.readAvailability(state, { ...data, monitors }, at, operator);
    return { revision, data: attachAvailability(data, history) };
  }

  private project(state: StoredContext, operator: boolean, secrets: boolean, at: number, scopes?: ViewScope[]) {
    const start = historyStart(at);
    const publicBanner = !operator && scopes?.includes("banner") && !scopes.includes("incidents");
    const withIncidents = !scopes || scopes.includes("incidents") || publicBanner;
    const withAllMonitors = withIncidents || scopes?.includes("monitors") || scopes?.includes("destinations");
    const visible = withAllMonitors || scopes?.some(includesLedger)
      ? state.monitors.filter(monitor => (operator || monitor.published) &&
        (withAllMonitors || scopes?.includes(`monitor/${monitor.id}`))) : [];
    const monitors = visible.map(monitor => ({
      ...publicMonitor(monitor, !!state.paused),
      history: null as AvailabilityHistory | null,
      ...(secrets ? { destinationIds: (monitor.notificationSelections ?? []).map(selection => selection.destinationId) } : {}),
      ...(operator ? {
        kind: monitor.kind,
        ...(monitor.kind === "tcp" ? { hostname: monitor.hostname, port: monitor.port } : monitor.kind === "http" ? { url: monitor.url } : {}),
        published: monitor.published,
        scheduleMode: monitor.scheduleMode ?? "interval",
        ...(monitor.kind !== "heartbeat" && monitor.scheduleMode !== "calendar"
          ? { effectiveIntervalSeconds: Math.max(monitor.intervalSeconds, minimumCheckIntervalSeconds(this.env.MIN_CHECK_INTERVAL_SECONDS)) } : {}),
        ...(monitor.kind !== "heartbeat" && monitor.scheduleMode === "calendar" ? {
          scheduleSuspended: monitor.outboundCalendarFloor?.compatible === false,
          ...(monitor.outboundCalendarFloor?.compatible === false ? { scheduleSuspensionFloorSeconds: monitor.outboundCalendarFloor.seconds } : {}),
        } : {}),
        ...(monitor.scheduleMode === "calendar" ? { cron: monitor.cron, timezone: monitor.timezone ?? "UTC" } : {}),
        ...(monitor.kind !== "heartbeat" || monitor.scheduleMode !== "calendar" ? { intervalSeconds: monitor.intervalSeconds } : {}), recoveryThreshold: monitor.recoveryThreshold,
        ...(monitor.kind === "heartbeat"
          ? monitor.scheduleMode === "calendar" ? { graceSeconds: monitor.graceSeconds } : { silenceSeconds: monitor.silenceSeconds, recoverySpacingSeconds: monitor.recoverySpacingSeconds }
          : { timeoutSeconds: monitor.timeoutSeconds, failureThreshold: monitor.failureThreshold }),
      } : {}),
    }));
    const includeDestinations = secrets && (!scopes || scopes.includes("destinations"));
    const legacy = includeDestinations && state.destinations?.find(destination => destination.id === state.legacyDestinationId);
    return {
      ...(includeDestinations ? {
        destinations: (state.destinations ?? []).map(({ submission, ...destination }) => ({
          ...destination, ...(submission ? { latestSubmission: submission.result } : {}),
        })),
        webhookUrl: legacy && legacy.channel === "webhook" ? legacy.url : null,
      } : {}),
      ...(operator ? { minCheckIntervalSeconds: minimumCheckIntervalSeconds(this.env.MIN_CHECK_INTERVAL_SECONDS) } : {}),
      paused: !!state.paused,
      pageName: state.pageName,
      monitors,
      monitor: monitors[0] ?? null,
      incidents: withIncidents ? this.ctx.storage.sql
        .exec<Incident>(operator ? "SELECT * FROM incidents ORDER BY openedAt DESC, id"
          : publicBanner ? "SELECT * FROM incidents WHERE openedAt < ? AND closedAt IS NULL"
          : "SELECT * FROM incidents WHERE openedAt < ? AND (closedAt IS NULL OR closedAt > ?) ORDER BY openedAt DESC, id",
          ...(operator ? [] : publicBanner ? [start + 90 * DAY] : [start + 90 * DAY, start]))
        .toArray().filter(incident => operator || visible.some(monitor => monitor.id === incident.monitorId)) : [],
    };
  }
}

function includesLedger(scope: ViewScope) {
  return scope === "monitors" || scope.startsWith("monitor/");
}

function attachAvailability(status: StatusProjection, history: Map<string, AvailabilityHistory | null>): StatusProjection {
  const monitors = status.monitors.map(monitor => ({ ...monitor, history: history.get(monitor.id) ?? null }));
  return { ...status, monitors, monitor: monitors[0] ?? null };
}

async function authorized(request: Request, secret: string | undefined) {
  if (!secret) return false;
  const encoder = new TextEncoder();
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest(
      "SHA-256",
      encoder.encode(request.headers.get("Authorization") ?? ""),
    ),
    crypto.subtle.digest("SHA-256", encoder.encode(`Bearer ${secret}`)),
  ]);
  return crypto.subtle.timingSafeEqual(actual, expected);
}

function createWorker<E extends EngineEnv = EngineEnv>(adapter?: HostedAdapter<E>) {
  const app = createApp(adapter);
  return {
  async scheduled(controller: ScheduledController, env: E) {
    minimumCheckIntervalSeconds(env.MIN_CHECK_INTERVAL_SECONDS);
    const contexts = adapter ? await adapter.contexts(env) : ["personal"];
    const unique = new Map<string, ScheduledContext>();
    for (const value of contexts) {
      const context = typeof value === "string" ? { id: value } : value;
      if (!context || typeof context.id !== "string" || !context.id ||
          !validPolicy(context)) throw new Error("Invalid hosted context");
      const origin = notificationOrigin(context.notificationOrigin);
      const prior = unique.get(context.id);
      if (prior && (prior.paused !== context.paused || prior.policyRevision !== context.policyRevision ||
          prior.notificationOrigin !== origin)) throw new Error("Conflicting hosted context");
      unique.set(context.id, { ...context, notificationOrigin: origin });
    }
    if (!unique.size) return;
    const perContext = Math.floor(availabilityWriteLimit / unique.size);
    const extra = availabilityWriteLimit % unique.size;
    await Promise.all([...unique.values()].map(async (policy, index) => {
      const context = env.MONITORING.getByName(policy.id);
      if (policy.notificationOrigin) await context.provisionEmailWithdrawals(policy.notificationOrigin);
      if (policy.paused !== undefined) await context.setPaused(policy.paused, policy.policyRevision);
      await context.check(controller.scheduledTime, perContext + Number(index < extra));
    }));
  },
  async fetch(request: Request, env: E) {
    try {
      minimumCheckIntervalSeconds(env.MIN_CHECK_INTERVAL_SECONDS);
    } catch (error) {
      console.error(JSON.stringify({ event: "invalid_configuration", message: (error as Error).message }));
      return requestFailed(request);
    }
    try {
      return await app.fetch(request, env);
    } catch {
      return requestFailed(request);
    }
  },
} satisfies ExportedHandler<E>; }

export default createWorker();

export class NotificationDelivery extends WorkerEntrypoint<EngineEnv> {
  async resolveAlert(job: NotificationEligibility) {
    if (!/^[a-f0-9]{64}$/.test(job.contextId)) return null;
    return this.env.MONITORING.get(this.env.MONITORING.idFromString(job.contextId)).resolveAlert(job);
  }

  async resolveConfirmation(job: ConfirmationJob) {
    if (!/^[a-f0-9]{64}$/.test(job.contextId)) return null;
    return this.env.MONITORING.get(this.env.MONITORING.idFromString(job.contextId)).resolveConfirmation(job);
  }

  async markConfirmationSubmitted(job: ConfirmationIdentity) {
    if (!/^[a-f0-9]{64}$/.test(job.contextId)) return;
    await this.env.MONITORING.get(this.env.MONITORING.idFromString(job.contextId)).markConfirmationSubmitted(job);
  }

  async resolveWebhook(job: NotificationEligibility) {
    if (!/^[a-f0-9]{64}$/.test(job.contextId)) return null;
    const context = this.env.MONITORING.get(this.env.MONITORING.idFromString(job.contextId));
    return context.resolveWebhook(job);
  }

  async reportSubmission(job: NotificationDeliveryIdentity, report: SubmissionReport) {
    if (!/^[a-f0-9]{64}$/.test(job.contextId)) return;
    const context = this.env.MONITORING.get(this.env.MONITORING.idFromString(job.contextId));
    await context.reportSubmission(job, report);
  }
}

export function createHostedWorker<E extends EngineEnv = EngineEnv>(adapter: HostedAdapter<E>) {
  if (adapter.contractVersion !== CONTRACT_VERSION) throw new Error("Unsupported Irisbeat contract version");
  return createWorker(adapter);
}

type HttpEnv<E extends EngineEnv> = {
  Bindings: E;
  Variables: {
    resolved: ResolvedContext | undefined;
    context: DurableObjectStub<MonitoringContext>;
    permission: "editor" | "reader";
    value: unknown;
    selectedMonitorId: string | null;
    emailOrigin: Promise<string | undefined>;
  };
};

function requestFailed(request: Request) {
  console.error(JSON.stringify({ event: "request_failed", path: new URL(request.url).pathname }));
  return Response.json({ error: "Internal server error" }, { status: 500, headers: { "Cache-Control": "no-store" } });
}

function methodNotAllowed(allow: string) {
  return new Response(null, { status: 405, headers: { Allow: allow } });
}

function confirmationOrigin<E extends EngineEnv>(c: Context<HttpEnv<E>>) {
  const cached = c.get("emailOrigin");
  if (cached) return cached;
  const origin = configuredConfirmationOrigin(c);
  c.set("emailOrigin", origin);
  return origin;
}

function notificationOrigin(configured: string | undefined) {
  if (!configured) return;
  try {
    const url = new URL(configured);
    if (url.username || url.password || url.href !== url.origin + "/" ||
        (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) return;
    return url.origin;
  } catch {
    return;
  }
}

async function configuredConfirmationOrigin<E extends EngineEnv>(c: Context<HttpEnv<E>>) {
  const resolved = c.get("resolved");
  const origin = notificationOrigin(resolved ? resolved.notificationOrigin : c.env.NOTIFICATION_PUBLIC_ORIGIN);
  const capability = c.env.NOTIFICATION_EMAIL;
  if (!origin || !capability || !c.env.NOTIFICATION_QUEUE) return;
  try {
    if (await capability.isConfigured()) return origin;
  } catch {
    console.error(JSON.stringify({ event: "notification_email_check_failed" }));
  }
}

const viewMediaType = "application/vnd.irisbeat.view+json";

async function operatorSnapshot<E extends EngineEnv>(c: Context<HttpEnv<E>>, status = 200, cached = false) {
  const resolved = c.get("resolved");
  const permission = c.get("permission")!;
  const context = c.get("context");
  const result = cached ? await context.snapshot(true, permission === "editor")
    : await context.status(true, permission === "editor");
  const emailConfigured = permission === "editor" && !!await confirmationOrigin(c);
  if (c.req.header("Accept") === viewMediaType) {
    return Response.json({ ...renderViewSnapshot(result, permission, emailConfigured), hosted: !!resolved, permission }, { status });
  }
  return Response.json({ ...statusJson(result), ...(emailConfigured ? { emailConfigured: true } : {}),
    ...(resolved ? { hosted: true, permission: resolved.permission } : {}) }, { status });
}

function operatorMutationResponse<E extends EngineEnv>(c: Context<HttpEnv<E>>, ack: MutationAck, status = 200, refresh?: ViewScope) {
  if (c.req.header("Accept") === viewMediaType) {
    const scopes = refresh ? mergeScopes(ack.scopes, [refresh]) : ack.scopes;
    return Response.json({ ...ack, scopes }, { status });
  }
  return operatorSnapshot(c, status, true);
}

async function readBoundedBody(request: Request, maxBytes = 4096) {
  if (Number(request.headers.get("Content-Length")) > maxBytes) return null;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let body = "";
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return body + decoder.decode();
      bytes += value.length;
      if (bytes > maxBytes) {
        await reader.cancel();
        return null;
      }
      body += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function createApp<E extends EngineEnv>(adapter?: HostedAdapter<E>) {
  // Use URL.pathname as before: Hono's default path extraction normalizes encoded paths.
  const app = new Hono<HttpEnv<E>>({ getPath: request => new URL(request.url).pathname });
  app.notFound(() => new Response("Not found", { status: 404 }));
  app.onError((_error, c) => requestFailed(c.req.raw));
  app.use("*", async (c, next) => {
    await next();
    if (c.error || c.res.status === 101) return;
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  });
  app.use("*", async (c, next) => {
    const resolved = adapter ? await adapter.resolve(c.req.raw, c.env) : undefined;
    if (resolved && (typeof resolved.id !== "string" || !resolved.id ||
        !["editor", "reader", null].includes(resolved.permission) ||
        !Number.isSafeInteger(resolved.monitorLimit) || resolved.monitorLimit < 0 || !validPolicy(resolved)))
      throw new Error("Invalid hosted context");
    if (adapter && !resolved) return c.notFound();
    const context = c.env.MONITORING.getByName(resolved?.id ?? "personal");
    c.set("resolved", resolved ?? undefined);
    c.set("context", context);
    const origin = notificationOrigin(resolved?.notificationOrigin);
    if (origin) await context.provisionEmailWithdrawals(origin);
    if (resolved?.paused !== undefined) await context.setPaused(resolved.paused, resolved.policyRevision);
    await next();
  });

  app.all("/heartbeat", async (c: Context<HttpEnv<E>>) => {
    if (!c.get("resolved")) return c.notFound();
    if (c.req.method !== "POST") return methodNotAllowed("POST");
    const accepted = await c.get("context").hostedHeartbeat(c.req.header("authorization") ?? "", Date.now());
    return new Response(null, { status: accepted ? 204 : 401 });
  });
  app.all("/heartbeat/*", async (c: Context<HttpEnv<E>>) => {
    if (c.get("resolved")) return new Response(null, { status: 404 });
    if (!(await authorized(c.req.raw, c.env.INSTALLATION_SECRET)))
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (c.req.method !== "POST") return methodNotAllowed("POST");
    const accepted = await c.get("context").heartbeat(c.req.path.slice("/heartbeat/".length), Date.now());
    return new Response(null, { status: accepted ? 204 : 404 });
  });

  // Hono maps HEAD to GET internally; retain this application's existing method contract.
  const getOnly: MiddlewareHandler<HttpEnv<E>> = async (c: Context<HttpEnv<E>>, next) => {
    if (c.req.method !== "GET") return c.notFound();
    await next();
  };
  // Request origin selects a Cache API zone. The trusted DO ID selects the tenant within it.
  const edgeKey = (c: Context<HttpEnv<E>>, resource: string, version: string) => new Request(new URL(
    `/.irisbeat-cache/v1/${c.get("context").id.toString()}/${encodeURIComponent(resource)}/${encodeURIComponent(version)}`, c.req.url
  ));
  const publicRender = async (c: Context<HttpEnv<E>>, resource: StatusRequest, minimum = 0) => {
    const context = c.get("context");
    const cacheResource = Array.isArray(resource) ? "batch:" + resource.join(",") : resource;
    const keyFor = (revision: number, generation: number) => edgeKey(c, cacheResource,
      `${c.env.IRISBEAT_VERSION?.id ?? "source"}:published:${revision}:${generation}`);
    const publication = await context.statusPublicationRevision(resource, minimum);
    if (publication.cacheSeconds && publication.revision < minimum) return c.text("Revision unavailable", 409);
    if (publication.cacheSeconds) {
      const cached = await readEdge(keyFor(publication.revision, publication.generation));
      if (cached) return cachedRenderResponse(cached);
    }
    if (!publication.cacheSeconds) {
      const live = await context.readLiveStatusRender(resource, minimum);
      return live ? renderResponse(live) : c.text("Revision unavailable", 409);
    }
    const render = await context.readPublishedStatus(resource, minimum);
    if (!render) return c.text("Revision unavailable", 409);
    if (render.cacheable)
      await writeEdge(keyFor(render.revision, render.generation), render, publication.cacheSeconds);
    return renderResponse(render);
  };
  app.get("/", getOnly, (c: Context<HttpEnv<E>>) => publicRender(c, "/"));
  app.get("/api/status", getOnly, (c: Context<HttpEnv<E>>) =>
    publicRender(c, c.req.header("Accept") === viewMediaType ? "snapshot" : "/api/status"));
  const asset = (render: StatusRender): MiddlewareHandler<HttpEnv<E>> => async c => {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(render.body));
    const version = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
    const key = edgeKey(c, c.req.path, version);
    const cached = await readEdge(key);
    if (cached) return cachedRenderResponse(cached);
    await writeEdge(key, render, 86_400);
    return renderResponse(render);
  };
  const shell = {
    personal: asset({ body: operatorPage(false), contentType: HTML }),
    hosted: asset({ body: operatorPage(true), contentType: HTML }),
  };
  app.get("/operator", getOnly, (c: Context<HttpEnv<E>>, next) => shell[c.get("resolved") ? "hosted" : "personal"](c, next));
  app.get("/app.css", getOnly, asset({ body: styleSheet, contentType: "text/css; charset=utf-8" }));
  app.get("/theme.js", getOnly, asset({ body: themeScript, contentType: "text/javascript; charset=utf-8" }));
  app.get("/operator.js", getOnly, asset({ body: operatorScript, contentType: "text/javascript; charset=utf-8" }));
  const subscribe: MiddlewareHandler<HttpEnv<E>> = async (c: Context<HttpEnv<E>>) => {
    const url = new URL(c.req.url);
    if (!allowedSubscriptionOrigin(c.req.raw, true)) return new Response(null, { status: 403 });
    if (url.search || c.req.header("Sec-WebSocket-Protocol")) return new Response(null, { status: 400 });
    return c.get("context").fetch(c.req.raw);
  };
  app.get("/api/status/events/v2", getOnly, subscribe);
  app.get("/api/operator/events/v2", getOnly, subscribe);

  for (const action of ["confirm", "unsubscribe"] as const) {
    const { path } = recipientAction[action];
    app.get(path, getOnly, c => c.html(recipientPage(action)));
    app.get(path + ".js", getOnly, () => new Response(recipientScript, { headers: { "Content-Type": "text/javascript; charset=utf-8" } }));
    app.post(path, async c => {
      if (c.req.header("Content-Type")?.split(";")[0] !== "application/x-www-form-urlencoded") return new Response(null, { status: 415 });
      const body = await readBoundedBody(c.req.raw);
      if (body === null) return new Response(null, { status: 413 });
      const tokens = new URLSearchParams(body).getAll("token");
      const [token] = tokens;
      const context = c.get("context");
      const origin = new URL(c.req.url).origin;
      const accepted = tokens.length === 1 && /^[a-f0-9-]{36}$/.test(token) && (action === "confirm"
        ? await context.confirmEmail(token, origin)
        : await context.unsubscribeEmail(token, origin));
      return c.html(recipientPage(action, accepted), accepted ? 200 : 400);
    });
  }

  const monitorPath = "/api/operator/monitors/:id";
  const maintenancePath = monitorPath + "/maintenance";
  const rotationPath = monitorPath + "/heartbeat-secret";
  const previewPath = "/api/operator/schedule-preview";
  const ticketPath = "/api/operator/events/ticket";
  const destinationsPath = "/api/operator/destinations";
  const destinationPath = destinationsPath + "/:id";
  const resendPath = destinationPath + "/confirmation";
  const readinessPath = "/api/operator/history/readiness";
  const publicPartials = "/api/status/partials";
  const operatorPartials = "/api/operator/partials";
  const operatorPartialPaths = [operatorPartials, operatorPartials + "/:section", operatorPartials + "/monitor/:id"];
  const operatorPaths = [readinessPath, ...operatorPartialPaths, ticketPath, previewPath, destinationsPath, destinationPath, resendPath, "/api/operator", "/api/operator/webhook", "/api/operator/monitors", monitorPath, maintenancePath, rotationPath];
  for (const path of operatorPaths) app.use(path, async (c, next) => {
    const resolved = c.get("resolved");
    if (path === rotationPath && !resolved) return c.notFound();
    const permission = resolved ? resolved.permission : await authorized(c.req.raw, c.env.INSTALLATION_SECRET) ? "editor" : null;
    if (!permission) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (permission !== "editor" && c.req.method !== "GET" && path !== ticketPath) return Response.json({ error: "Forbidden" }, { status: 403 });
    c.set("permission", permission);
    if (path !== ticketPath && path !== previewPath) await c.get("context").prepareOutboundCalendars();
    await next();
  });
  const partial = async (c: Context<HttpEnv<E>>) => {
    const operator = c.req.path.startsWith(operatorPartials);
    const prefix = operator ? operatorPartials : publicPartials;
    const batch = c.req.path === prefix;
    const resources = batch ? c.req.queries("scope") ?? [] : [c.req.path.slice(prefix.length + 1)];
    const audience: ViewAudience = operator ? c.get("permission")! : "public";
    const sections = audience === "editor" ? ["page", "banner", "monitors", "incidents", "destinations"]
      : ["page", "banner", "monitors", "incidents"];
    if (!resources.length || resources.length > 37) return c.text("Invalid sections", 400);
    if (resources.some(resource => !sections.includes(resource) && !/^monitor\/[A-Za-z0-9_-]{1,80}$/.test(resource))) return c.notFound();
    const minimum = c.req.query("revision") ?? "0";
    if (!/^\d+$/.test(minimum) || !Number.isSafeInteger(Number(minimum))) return c.text("Invalid revision", 400);
    const requested = resources as ViewScope[];
    const scopes = batch ? mergeScopes([], requested) : requested;
    if (!operator) return publicRender(c, batch ? scopes.sort() : scopes[0], Number(minimum));
    const { revision, data } = await c.get("context").readViews(scopes, audience, Number(minimum));
    if (revision < Number(minimum)) return c.text("Revision unavailable", 409);
    const emailConfigured = scopes.includes("destinations") && !!await confirmationOrigin(c);
    const partials = scopes.map(scope => {
      if (!scope.startsWith("monitor/")) return { scope, data: renderViewPartial(scope, data, audience, emailConfigured) };
      const id = scope.slice("monitor/".length);
      const monitor = data.monitors.find(monitor => monitor.id === id) ?? null;
      const projection = { ...data, monitors: monitor ? [monitor] : [] };
      return { scope, data: renderViewPartial(scope, projection, audience, emailConfigured) };
    });
    return batch ? c.json({ revision, permission: audience, partials })
      : c.json({ revision, ...partials[0].data, permission: audience });
  };
  for (const path of [publicPartials, publicPartials + "/:section", publicPartials + "/monitor/:id", ...operatorPartialPaths]) {
    app.get(path, getOnly, partial);
  }
  app.get(readinessPath, getOnly, async (c: Context<HttpEnv<E>>) => {
    if (c.get("permission") !== "editor") return Response.json({ error: "Forbidden" }, { status: 403 });
    const result = await c.get("context").availabilityReadiness();
    return Response.json(result, { status: result.ready ? 200 : 503 });
  });
  app.post(ticketPath, async c => {
    const url = new URL(c.req.url);
    if (!allowedSubscriptionOrigin(c.req.raw, false)) return new Response(null, { status: 403 });
    const grant = await c.get("context").issueSubscriptionTicket(c.get("resolved")?.id ?? "personal", url.origin, c.get("permission"));
    return grant ? Response.json(grant) : new Response(null, { status: 503 });
  });
  const readBody: MiddlewareHandler<HttpEnv<E>> = async (c: Context<HttpEnv<E>>, next) => {
    const request = c.req.raw;
    if (!request.headers.get("Content-Type")?.startsWith("application/json"))
      return Response.json(
        { error: "Use application/json" },
        { status: 415 },
      );
    const maxBytes = c.req.path === destinationsPath || c.req.path.startsWith(destinationsPath + "/") ? 16_384 : 4096;
    if (Number(request.headers.get("Content-Length")) > maxBytes)
      return new Response(null, { status: 413 });
    const selectedMonitorId = c.req.path === "/api/operator" ? await c.get("context").firstMonitorId() : null;
    c.set("selectedMonitorId", selectedMonitorId);
    const body = await readBoundedBody(request, maxBytes);
    if (body === null) return new Response(null, { status: 413 });
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }
    c.set("value", value);
    await next();
  };
  // IDs are opaque: read the original path rather than Hono's decoded params.
  const monitorId = (c: Context<HttpEnv<E>>) => c.req.path.split("/")[4];
  for (const path of ["/api/operator", "/api/operator/webhook", "/api/operator/monitors", destinationsPath]) {
    app.get(path, async (c: Context<HttpEnv<E>>) => {
      if (c.req.method !== "GET")
        return methodNotAllowed(path === "/api/operator/monitors" || path === destinationsPath ? "GET, POST" : "GET, PUT");
      return operatorSnapshot(c);
    });
  }
  app.post(rotationPath, async (c: Context<HttpEnv<E>>) => {
    const result = await c.get("context").rotateHeartbeatSecret(monitorId(c));
    return result ? Response.json(result) : Response.json({ error: "Monitor not found" }, { status: 404 });
  });
  app.delete(maintenancePath, async (c: Context<HttpEnv<E>>) => {
    const result = await c.get("context").maintenance(monitorId(c), null, true);
    return result ? operatorMutationResponse(c, result) : Response.json({ error: "Monitor not found" }, { status: 404 });
  });
  app.delete(monitorPath, async (c: Context<HttpEnv<E>>) => {
    const result = await c.get("context").remove(monitorId(c));
    return result ? operatorMutationResponse(c, result) : Response.json({ error: "Monitor not found" }, { status: 404 });
  });
  app.put("/api/operator/webhook", readBody, async (c: Context<HttpEnv<E>>) => {
    const value = c.get("value");
    const url = value && typeof value === "object" ? (value as Record<string, unknown>).url : undefined;
    const destination = parseWebhook(url);
    if (destination === undefined) return Response.json({ error: "Enter an HTTPS webhook URL" }, { status: 400 });
    return destinationResponse(c, await c.get("context").configureDestination(null, destination ? { channel: "webhook", url: destination } : null, true));
  });
  function destinationResponse(c: Context<HttpEnv<E>>, result: MutationAck | null | "duplicate" | "duplicate-name" | "unconfigured" | "cooldown" | "paused", status = 200) {
    if (result === "unconfigured") return Response.json({ error: "Email sending is unavailable" }, { status: 503 });
    if (result === "duplicate") return Response.json({ error: "This inbox is already a destination" }, { status: 409 });
    if (result === "duplicate-name") return Response.json({ error: "A destination with this name already exists" }, { status: 409 });
    if (result === "paused") return Response.json({ error: "Confirmation is paused" }, { status: 409 });
    if (result === "cooldown") return Response.json({ error: "Wait five minutes between confirmations for this inbox" }, { status: 429 });
    return result ? operatorMutationResponse(c, result, status) : Response.json({ error: "Destination not found" }, { status: 404 });
  }
  const saveDestination = async (c: Context<HttpEnv<E>>) => {
    const value = c.get("value");
    const fields = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const name = typeof fields.name === "string" ? fields.name.trim() : undefined;
    if (fields.name !== undefined && (!name || name.length > 120 || /[\r\n]/.test(name)))
      return Response.json({ error: "Enter a destination name of up to 120 characters on one line" }, { status: 400 });
    const creating = c.req.method === "POST";
    if (!creating && name && fields.channel === undefined && fields.url === undefined && fields.address === undefined)
      return destinationResponse(c, await c.get("context").configureDestination(monitorId(c), { name }));
    let destination: NewNotificationDestination & { name?: string };
    let origin: string | undefined;
    if (fields.channel === "email") {
      const address = parseEmailAddress(fields.address);
      if (!address) return Response.json({ error: "Enter an email address" }, { status: 400 });
      origin = await confirmationOrigin(c);
      destination = { channel: "email", address, name };
    } else {
      const url = parseWebhook(fields.url);
      if (!url || (fields.channel !== undefined && fields.channel !== "webhook"))
        return Response.json({ error: "Enter an HTTPS webhook URL" }, { status: 400 });
      destination = { channel: "webhook", url, name };
    }
    const result = await c.get("context").configureDestination(creating ? null : monitorId(c), destination, false, origin);
    return destinationResponse(c, result, creating ? 201 : 200);
  };
  app.post(destinationsPath, readBody, saveDestination);
  app.put(destinationPath, readBody, saveDestination);
  app.post(resendPath, async c => {
    const origin = await confirmationOrigin(c);
    return destinationResponse(c, origin ? await c.get("context").resendConfirmation(monitorId(c), origin) : "unconfigured");
  });
  app.delete(destinationPath, async c => {
    return destinationResponse(c, await c.get("context").configureDestination(monitorId(c), null));
  });
  app.put(maintenancePath, readBody, async (c: Context<HttpEnv<E>>) => {
    const result = await c.get("context").maintenance(monitorId(c), c.get("value"));
    if (result === undefined) return Response.json({ error: "Enter a future end time in epoch milliseconds" }, { status: 400 });
    return result ? operatorMutationResponse(c, result) : Response.json({ error: "Monitor not found" }, { status: 404 });
  });
  app.post(previewPath, readBody, async (c: Context<HttpEnv<E>>) => {
    const result = await c.get("context").previewSchedule(c.get("value"));
    return Response.json(result, { status: "error" in result ? 400 : 200 });
  });
  app.patch(monitorPath, readBody, async (c: Context<HttpEnv<E>>) => {
    const result = await c.get("context").edit(monitorId(c), c.get("value"));
    if (result === undefined) return Response.json({ error: "Enter valid Monitor settings and an HTTP(S)/TCP target or Heartbeat settings; type cannot change" }, { status: 400 });
    return result ? operatorMutationResponse(c, result, 200, `monitor/${monitorId(c)}`) : Response.json({ error: "Monitor not found" }, { status: 404 });
  });
  app.post("/api/operator/monitors", readBody, async (c: Context<HttpEnv<E>>) => {
    const value = c.get("value");
    const result = await c.get("context").create(value, c.get("resolved")?.monitorLimit);
    if (result === undefined)
      return Response.json({ error: "Enter a Monitor name and HTTP(S)/TCP target or Heartbeat settings" }, { status: 400 });
    return result ? operatorMutationResponse(c, result, 201) : Response.json({ error: "Monitor allowance reached" }, { status: 409 });
  });
  app.put("/api/operator", readBody, async (c: Context<HttpEnv<E>>) => {
    const value = c.get("value");
    const context = c.get("context");
    if (value && typeof value === "object" && Object.keys(value).length === 1 && "pageName" in value) {
      const pageName = value.pageName;
      if (typeof pageName !== "string" || !pageName.trim() || pageName.length > 120)
        return Response.json({ error: "Enter a page name" }, { status: 400 });
      const ack = (await context.configure({ pageName: pageName.trim() }))!;
      return operatorMutationResponse(c, ack, 200, "page");
    }
    if (c.get("resolved")) return Response.json({ error: "Use the Monitor collection" }, { status: 400 });
    const result = await context.configure(value, c.get("selectedMonitorId"));
    if (result === undefined) return Response.json({ error: "Enter a page name, Monitor name and HTTP(S)/TCP target or Heartbeat settings; type cannot change" }, { status: 400 });
    return result ? operatorMutationResponse(c, result) : Response.json({ error: "Monitor changed; reload before saving" }, { status: 409 });
  });
  for (const path of operatorPaths) app.all(path, () => methodNotAllowed(
    path === readinessPath ? "GET" : (path === rotationPath || path === previewPath) ? "POST" : path === maintenancePath ? "PUT, DELETE" : path === monitorPath ? "PATCH, DELETE" : path === destinationPath ? "PUT, DELETE" : (path === "/api/operator/monitors" || path === destinationsPath) ? "GET, POST" : "GET, PUT",
  ));
  return app;
}
