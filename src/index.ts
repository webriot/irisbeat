// SPDX-License-Identifier: AGPL-3.0-only
import { operatorPage, operatorScript, statusPage, styleSheet, themeScript } from "./ui";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { calendar } from "./calendar";
import { MonitorConfigurations, timingDefaults, type Monitor, type MaintenanceWindow } from "./monitor-configuration";
import { connect } from "cloudflare:sockets";
import type { NotificationDestination, NotificationJob } from "./notification-jobs";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

export const CONTRACT_VERSION = "1" as const;
export interface EngineEnv {
  MONITORING: DurableObjectNamespace<MonitoringContext>;
  INSTALLATION_SECRET?: string;
  NOTIFICATION_QUEUE?: Pick<Queue<NotificationJob>, "sendBatch">;
}
type PausePolicy = { paused: boolean; policyRevision: number } | { paused?: undefined; policyRevision?: undefined };
export type ScheduledContext = { id: string } & PausePolicy;
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
export type { MaintenanceNotificationEvent, NotificationDestination, NotificationEvent, NotificationJob } from "./notification-jobs";
export type { MaintenanceWindow } from "./monitor-configuration";
const DAY = 86_400_000;
const historyStart = (at: number) => Math.floor(at / DAY) * DAY - 89 * DAY;
export type HistoryDay = {
  date: string;
  state: "up" | "down" | "degraded" | "maintenance" | "empty";
  successes: number;
  failures: number;
  maintenance: number;
};
export type AvailabilityHistory = { days: HistoryDay[]; percentage: number | null };
type DailyCounts = { day: number; successes: number; failures: number; maintenance: number };
export type Status = ReturnType<MonitoringContext["status"]>;
type StoredContext = {
  pageName: string;
  monitors: Monitor[];
  webhookUrl?: string | null;
  legacyDestinationId?: string;
  destinations?: NotificationDestination[];
  paused?: boolean;
  policyRevision?: number;
  pauseGeneration?: number;
};
type LegacyContext = { webhookUrl?: string | null; monitor: (Monitor & { pageName: string }) | null };

type OperatorSubscription = { audience: "operator"; origin: string; expiresAt: number } & (
  | { authenticated: false; contextId?: never; permission?: never }
  | { authenticated: true; contextId: string; permission: "reader" | "editor" }
);
type Subscription = { pending: boolean; dirty: boolean } & (
  | { audience?: undefined; authenticated?: never; permission?: never }
  | OperatorSubscription
);
type Ticket = { origin: string; contextId: string; permission: "reader" | "editor"; expiresAt: number; leaseEndsAt: number };

function allowedSubscriptionOrigin(request: Request, requireOrigin: boolean) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  return (origin === url.origin || (!requireOrigin && !origin)) &&
    (url.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
}

export class MonitoringContext<E extends EngineEnv = EngineEnv> extends DurableObject<E> {
  constructor(ctx: DurableObjectState, env: E) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS incidents (
      id TEXT PRIMARY KEY, monitorId TEXT NOT NULL, openedAt INTEGER NOT NULL, closedAt INTEGER
    )`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY, monitorId TEXT NOT NULL, at INTEGER NOT NULL, outcome TEXT NOT NULL
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
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS observations_monitor_at ON observations (monitorId, at)");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS observations_at ON observations (at)");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS incidents_opened ON incidents (openedAt DESC, id)");
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
    const operator = new URL(request.url).pathname === "/api/operator/events";
    const audience = operator ? "operator" : "public";
    this.expireSubscriptions();
    const active = this.ctx.getWebSockets(audience);
    if (active.length >= 128 || (operator && active.filter(socket => !socket.deserializeAttachment()?.authenticated).length >= 16))
      return new Response(null, { status: 503 });
    const { 0: client, 1: server } = new WebSocketPair();
    const attachment: Subscription = operator
      ? { pending: false, dirty: false, audience: "operator", origin: new URL(request.url).origin, authenticated: false, expiresAt: Date.now() + 10_000 }
      : { pending: false, dirty: false };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server, [audience]);
    this.scheduleSubscriptionAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    const state = socket.deserializeAttachment() as Subscription;
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
        socket.serializeAttachment({ ...state, ...scope, dirty: state.permission === scope.permission && state.dirty,
          audience: "operator", authenticated: true, expiresAt: scope.leaseEndsAt } satisfies Subscription);
        socket.send("authorized");
        this.scheduleSubscriptionAlarm();
        return;
      }
    }
    if (message !== "ack" || !state?.pending) {
      socket.close(1008, "Read-only subscription");
      return;
    }
    if (state.dirty) socket.send("changed");
    socket.serializeAttachment({ ...state, pending: state.dirty, dirty: false });
  }

  webSocketClose(socket: WebSocket) { socket.close(1000, ""); this.scheduleSubscriptionAlarm(); }
  webSocketError(socket: WebSocket) { socket.close(1011, "Subscription closed"); this.scheduleSubscriptionAlarm(); }

  private subscriptionValid(socket: WebSocket, state: Subscription) {
    if (state.audience !== "operator" || !state.expiresAt || state.expiresAt <= Date.now()) { socket.close(1008, "Authorization expired"); return false; }
    return true;
  }

  private expireSubscriptions() {
    for (const socket of this.ctx.getWebSockets("operator")) {
      if (socket.readyState === WebSocket.OPEN) this.subscriptionValid(socket, socket.deserializeAttachment());
    }
  }

  private subscriptionSnapshot(state: StoredContext) {
    const at = Date.now();
    return { at, value: JSON.stringify(this.project(state, false, false, at)), operator: JSON.stringify(this.project(state, true, true, at)), reader: JSON.stringify(this.project(state, true, false, at)) };
  }

  private scheduleSubscriptionAlarm() {
    const now = Date.now();
    const monitors = this.read().monitors;
    const boundary = (selected: Monitor[]) => selected.length ? Math.min((Math.floor(now / DAY) + 1) * DAY,
      ...selected.flatMap(monitor => monitor.maintenance ? [monitor.maintenance.endsAt] : [])) : Infinity;
    const hasPublic = this.ctx.getWebSockets("public").some(socket => socket.readyState === WebSocket.OPEN);
    const operators = this.ctx.getWebSockets("operator").filter(socket => socket.readyState === WebSocket.OPEN);
    const previous = this.ctx.storage.kv.get<{ publicAt: number; operatorAt: number }>("subscription-boundaries");
    const publicAt = hasPublic ? Math.min(boundary(monitors.filter(monitor => monitor.published)),
      previous && previous.publicAt <= now ? previous.publicAt : Infinity) : Infinity;
    const operatorAt = operators.some(socket => socket.deserializeAttachment()?.authenticated) ? Math.min(boundary(monitors),
      previous && previous.operatorAt <= now ? previous.operatorAt : Infinity) : Infinity;
    // Separate clocks prevent private authorization alarms from announcing public activity.
    this.ctx.storage.kv.put("subscription-boundaries", { publicAt, operatorAt });
    const at = Math.min(publicAt, operatorAt, ...operators.map(socket => (socket.deserializeAttachment() as OperatorSubscription).expiresAt));
    this.ctx.waitUntil(Number.isFinite(at) ? this.ctx.storage.setAlarm(at) : this.ctx.storage.deleteAlarm());
  }

  alarm() {
    const boundaries = this.ctx.storage.kv.get<{ publicAt: number; operatorAt: number }>("subscription-boundaries");
    this.expireSubscriptions();
    this.read();
    if (boundaries && boundaries.publicAt <= Date.now()) this.broadcast("public");
    if (boundaries && boundaries.operatorAt <= Date.now()) this.broadcast("operator");
    this.ctx.storage.kv.delete("subscription-boundaries");
    this.scheduleSubscriptionAlarm();
  }

  private notify(before: { at: number; value: string; operator: string; reader: string }) {
    const state = this.read(before.at);
    if (before.value !== JSON.stringify(this.project(state, false, false, before.at))) this.broadcast("public");
    if (before.operator !== JSON.stringify(this.project(state, true, true, before.at)))
      this.broadcast("operator", before.reader === JSON.stringify(this.project(state, true, false, before.at)));
    this.scheduleSubscriptionAlarm();
  }

  private broadcast(audience: "public" | "operator", editorsOnly = false) {
    for (const socket of this.ctx.getWebSockets(audience)) {
      try {
        if (socket.readyState !== WebSocket.OPEN) continue;
        const state = socket.deserializeAttachment() as Subscription;
        if (audience === "operator" && (!this.subscriptionValid(socket, state) || !state.authenticated)) continue;
        if (editorsOnly && state.permission !== "editor") continue;
        if (!state.pending) socket.send("changed");
        socket.serializeAttachment({ ...state, pending: true, dirty: state.pending });
      } catch { socket.close(1011, "Subscription closed"); }
    }
  }

  private read(at = Date.now(), expiry: { pending?: Promise<void>[]; suppress?: boolean } = {}): StoredContext {
    const stored = this.ctx.storage.kv.get<StoredContext | LegacyContext>("context");
    if (!stored) return { pageName: "Irisbeat", monitors: [] };
    if ("monitors" in stored) {
      stored.monitors = stored.monitors.map(monitor => { monitor.kind ??= "http"; return { ...timingDefaults, scheduleMode: "interval", ...monitor, createdAt: monitor.createdAt ?? 0, lastSeen: monitor.lastSeen ?? null, recoveryReceiptAt: monitor.recoveryReceiptAt ?? null }; });
      let changed = this.migrateWebhook(stored);
      const expired: { monitor: Monitor; window: MaintenanceWindow }[] = [];
      for (const monitor of stored.monitors) {
        const window = monitor.maintenance;
        if (window && at >= window.endsAt) {
          this.endMaintenance(monitor);
          changed = true;
          expired.push({ monitor, window });
        }
      }
      if (changed) this.ctx.storage.transactionSync(() => {
        for (const { monitor, window } of expired) {
          if (monitor.kind !== "heartbeat" || monitor.scheduleMode === "calendar") continue;
          // Watchdog silence uses scheduled time, even when a wall-clock read expires the window first.
          this.ctx.storage.sql.exec("DELETE FROM calendar_maintenance WHERE monitorId = ? AND endsAt <= ?", monitor.id, historyStart(at));
          this.ctx.storage.sql.exec("INSERT INTO calendar_maintenance (monitorId, startedAt, endsAt) VALUES (?, ?, ?)", monitor.id, window.startedAt, window.endsAt);
        }
        this.ctx.storage.kv.put("context", stored);
      });
      for (const { monitor, window } of expired) {
        if (stored.paused || expiry.suppress || !monitor.notificationSelections?.length) continue;
        const send = this.enqueueNotifications(monitor, stored.pauseGeneration ?? 0, {
          id: crypto.randomUUID(),
          kind: "maintenance.ended",
          reason: "expired",
          at: window.endsAt,
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
    this.migrateWebhook(state);
    this.ctx.storage.transactionSync(() => {
      if (stored.monitor) this.ctx.storage.sql.exec(
        "UPDATE incidents SET monitorName = ? WHERE monitorId = ? AND monitorName IS NULL",
        stored.monitor.name, stored.monitor.id,
      );
      this.ctx.storage.kv.put("context", state);
    });
    return state;
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
    const before = this.subscriptionSnapshot(state);
    state.policyRevision = policyRevision;
    if (!!state.paused === paused) {
      this.ctx.storage.kv.put("context", state);
      return;
    }
    state.paused = paused;
    state.pauseGeneration = (state.pauseGeneration ?? 0) + 1;
    if (paused) {
      for (const attempt of this.checking.values()) attempt.paused = true;
    } else {
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
    this.notify(before);
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
      return { cron: parsed.cron, timezone: parsed.timezone, explanation: parsed.explanation, occurrences: parsed.next(after, 3) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Enter a valid Calendar Schedule" };
    }
  }

  private monitorConfigurations = new MonitorConfigurations({
    read: () => this.read(),
    snapshot: (state: StoredContext) => this.subscriptionSnapshot(state),
    commit: (state: StoredContext, before: ReturnType<MonitoringContext["subscriptionSnapshot"]>) => {
      this.ctx.storage.kv.put("context", state);
      this.notify(before);
      return this.status(true);
    },
    resetCalendarEvidence: (monitor: Monitor) => this.resetCalendarEvidence(monitor),
  });

  async configure(value: unknown, expectedMonitorId: string | null = null) {
    return this.monitorConfigurations.configure(value, expectedMonitorId);
  }

  async create(value: unknown, limit?: number) {
    return this.monitorConfigurations.create(value, limit);
  }

  private migrateWebhook(state: StoredContext) {
    if (state.webhookUrl === undefined) return false;
    if (state.webhookUrl) {
      const id = crypto.randomUUID();
      state.legacyDestinationId = id;
      state.destinations = [{ id, channel: "webhook", url: state.webhookUrl }];
    }
    delete state.webhookUrl;
    return true;
  }

  configureDestination(id: string | null, url: string | null, legacy = false) {
    const state = this.read();
    const destinationId = legacy ? state.legacyDestinationId : id;
    const destinations = state.destinations ?? [];
    const existing = destinations.find(destination => destination.id === destinationId);
    if (destinationId && !existing) return null;
    if (existing?.url === url) return this.status(true);
    const before = this.subscriptionSnapshot(state);
    const replacement: NotificationDestination | null = url ? { id: crypto.randomUUID(), channel: "webhook", url } : null;
    state.destinations = existing
      ? destinations.flatMap(destination => destination !== existing ? [destination] : replacement ? [replacement] : [])
      : replacement ? [...destinations, replacement] : destinations;
    if (legacy || (existing && existing.id === state.legacyDestinationId)) state.legacyDestinationId = replacement?.id;
    if (existing) {
      for (const monitor of state.monitors) {
        monitor.notificationSelections = monitor.notificationSelections?.filter(selection => selection.destinationId !== existing.id);
      }
    }
    this.ctx.storage.kv.put("context", state);
    this.notify(before);
    return this.status(true);
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
    const before = this.subscriptionSnapshot(state);
    const monitor = state.monitors.find(monitor => monitor.id === id);
    if (!monitor) return null;
    if (!end && (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).length !== 1 || !("endsAt" in value) ||
        typeof value.endsAt !== "number" || !Number.isSafeInteger(value.endsAt) ||
        value.endsAt <= at || value.endsAt > 8_640_000_000_000_000)) return undefined;
    const previous = monitor.maintenance;
    const next = end ? null : { startedAt: at, endsAt: (value as { endsAt: number }).endsAt };
    if (previous?.endsAt === next?.endsAt) return this.status(true);
    this.ctx.storage.transactionSync(() => {
      if (monitor.kind === "heartbeat" && monitor.scheduleMode === "calendar") {
        // Retain elapsed overlap when an operator cuts a window short or replaces it.
        this.ctx.storage.sql.exec("UPDATE calendar_maintenance SET endsAt = MIN(endsAt, ?) WHERE monitorId = ? AND endsAt > ?", at, id, at);
        if (next) this.ctx.storage.sql.exec("INSERT INTO calendar_maintenance (monitorId, startedAt, endsAt) VALUES (?, ?, ?)", id, next.startedAt, next.endsAt);
      }
      if (next) monitor.maintenance = next;
      else this.endMaintenance(monitor);
      this.ctx.storage.kv.put("context", state);
    });
    if (next) {
      const attempt = this.checking.get(id);
      if (attempt) attempt.maintenance = true;
    }
    this.notify(before);
    if (!state.paused && monitor.notificationSelections?.length) {
      const event = { id: crypto.randomUUID(), at, monitorName: monitor.name };
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
    return this.status(true);
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
    const before = this.subscriptionSnapshot(state);
    if (!state.monitors.some(monitor => monitor.id === id)) return null;
    this.clearCalendarEvidence(id);
    state.monitors = state.monitors.filter(monitor => monitor.id !== id);
    this.ctx.storage.kv.put("context", state);
    this.notify(before);
    return this.status(true);
  }

  // Keep overlap evidence with the running attempt even after a window is replaced or ends.
  private checking = new Map<string, { maintenance: boolean; paused: boolean }>();

  async check(at: number) {
    const pending: Promise<void>[] = [];
    const { monitors } = this.read(Math.max(at, Date.now()), { pending });
    await Promise.all([...pending, ...monitors.map(monitor => this.checkMonitor(monitor.id, at))]);
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
    if (this.checking.has(id) || at < attempt.nextDue) return;
    const observation = { maintenance: !!attempt.maintenance, paused: false };
    this.checking.set(id, observation);
    attempt.nextDue = attempt.scheduleMode === "calendar" ? calendar(attempt.cron, attempt.timezone).next(at)[0] : at + attempt.intervalSeconds * 1000;
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

  private async record(current: StoredContext, monitor: Monitor, at: number, success: boolean, failureThreshold: number, recoveryThreshold: number, maintenance = !!monitor.maintenance, resetProgress = false, before = this.subscriptionSnapshot(current)) {
    if (current.paused) return;
    const pauseGeneration = current.pauseGeneration ?? 0;
    let transition: "opened" | "recovered" | undefined;
    let transitionedIncident: Pick<Incident, "id" | "openedAt"> | undefined;
    this.ctx.storage.transactionSync(() => {
      monitor.lastResult = { at, outcome: maintenance ? "maintenance" : success ? "success" : "failure" };
      if (monitor.kind === "heartbeat" && monitor.scheduleMode === "calendar") {
        this.ctx.storage.sql.exec("DELETE FROM calendar_receipts WHERE monitorId = ? AND occurrence < ?", monitor.id, monitor.nextDue);
        this.ctx.storage.sql.exec("DELETE FROM calendar_maintenance WHERE monitorId = ? AND endsAt <= ?", monitor.id, at);
      }
      if (monitor.kind !== "heartbeat" || monitor.scheduleMode !== "calendar" || at >= historyStart(Math.max(at, Date.now())))
        this.ctx.storage.sql.exec("INSERT INTO observations (monitorId, at, outcome) VALUES (?, ?, ?)", monitor.id, at, monitor.lastResult.outcome);
      // Bounded cleanup keeps the entire current UTC day and never touches Incidents.
      this.ctx.storage.sql.exec(
        "DELETE FROM observations WHERE id IN (SELECT id FROM observations WHERE at < ? ORDER BY at LIMIT 1000)",
        historyStart(Math.max(at, Date.now())),
      );
      if (maintenance) {
        this.ctx.storage.kv.put("context", current);
        return;
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
      this.ctx.storage.kv.put("context", current);
    });
    this.notify(before);
    if (!transition || !transitionedIncident) return;
    if (monitor.notificationSelections?.length) {
      await this.enqueueNotifications(monitor, pauseGeneration, {
        id: transitionedIncident.id + ":" + transition,
        kind: transition === "opened" ? "incident.opened" : "incident.recovered",
        at,
        incidentId: transitionedIncident.id,
        openedAt: transitionedIncident.openedAt,
        monitorName: monitor.name,
      });
    }
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

  resolveWebhook(job: NotificationJob) {
    if (job.contextId !== this.ctx.id.toString()) return null;
    const state = this.read();
    if (state.paused || (state.pauseGeneration ?? 0) !== job.pauseGeneration) return null;
    const selected = state.monitors.find(monitor => monitor.id === job.monitorId)?.notificationSelections;
    if (!selected?.some(selection => selection.destinationId === job.destinationId && selection.generation === job.generation)) return null;
    return state.destinations?.find(destination => destination.channel === "webhook" && destination.id === job.destinationId)?.url ?? null;
  }

  async heartbeat(id: string, at: number) {
    const current = this.read();
    const monitor = current.monitors.find(monitor => monitor.id === id);
    if (!monitor || monitor.kind !== "heartbeat") return false;
    const before = this.subscriptionSnapshot(current);
    monitor.lastSeen = at;
    if (monitor.scheduleMode === "calendar") {
      if (!current.paused) {
        const occurrence = calendar(monitor.cron, monitor.timezone).next(at - monitor.graceSeconds * 1000 - 1)[0];
        if (occurrence <= at && occurrence >= monitor.nextDue) {
          this.ctx.storage.sql.exec("INSERT OR IGNORE INTO calendar_receipts (monitorId, occurrence) VALUES (?, ?)", id, occurrence);
        }
      }
      this.ctx.storage.kv.put("context", current);
      this.notify(before);
    } else if (current.paused) {
      this.ctx.storage.kv.put("context", current);
      this.notify(before);
    } else if (monitor.maintenance) {
      await this.record(current, monitor, at, true, 1, monitor.recoveryThreshold, !!monitor.maintenance, false, before);
    } else if (monitor.state !== "down" || monitor.recoveryReceiptAt === null ||
        at >= monitor.recoveryReceiptAt + monitor.recoverySpacingSeconds * 1000) {
      monitor.recoveryReceiptAt = at;
      await this.record(current, monitor, at, true, 1, monitor.recoveryThreshold, !!monitor.maintenance, false, before);
    } else {
      this.ctx.storage.kv.put("context", current);
      this.notify(before);
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

  // Separate series reads so their failure never hides current state or Incidents.
  protected queryHistory(id: string, start: number, end: number): DailyCounts[] | null {
    return this.ctx.storage.sql.exec<DailyCounts>(
      `SELECT CAST(at / ${DAY} AS INTEGER) AS day,
        SUM(outcome = 'success') AS successes, SUM(outcome = 'failure') AS failures,
        SUM(outcome = 'maintenance') AS maintenance
       FROM observations WHERE monitorId = ? AND at >= ? AND at < ? GROUP BY day`,
      id, start, end,
    ).toArray();
  }

  private history(id: string, start: number): AvailabilityHistory | null {
    try {
      const rows = this.queryHistory(id, start, start + 90 * DAY);
      if (!rows) return null;
      const counts = new Map(rows.map(row => [row.day, row]));
      const days: HistoryDay[] = Array.from({ length: 90 }, (_, index) => {
        const at = start + index * DAY;
        const { successes = 0, failures = 0, maintenance = 0 } = counts.get(at / DAY) ?? {};
        return { date: new Date(at).toISOString().slice(0, 10),
          state: successes && failures ? "degraded" : successes ? "up" : failures ? "down" : maintenance ? "maintenance" : "empty",
          successes, failures, maintenance };
      });
      const successes = days.reduce((total, day) => total + day.successes, 0);
      const failures = days.reduce((total, day) => total + day.failures, 0);
      return { days, percentage: successes + failures ? successes / (successes + failures) * 100 : null };
    } catch {
      console.error(JSON.stringify({ event: "history_query_failed" }));
      return null;
    }
  }

  status(operator = false, secrets = operator) {
    return this.project(this.read(), operator, secrets, Date.now());
  }

  private project(state: StoredContext, operator: boolean, secrets: boolean, at: number) {
    const start = historyStart(at);
    const monitors = state.monitors.filter(monitor => operator || monitor.published).map(monitor => ({
      id: monitor.id, name: monitor.name, kind: monitor.kind, history: this.history(monitor.id, start),
      ...(monitor.kind === "heartbeat" ? { lastSeen: monitor.lastSeen } : {}), state: state.paused ? "paused" as const : monitor.maintenance ? "maintenance" as const : monitor.state, maintenance: monitor.maintenance ?? null, lastResult: monitor.lastResult,
      ...(secrets ? { destinationIds: (monitor.notificationSelections ?? []).map(selection => selection.destinationId) } : {}),
      ...(operator ? {
        kind: monitor.kind,
        ...(monitor.kind === "tcp" ? { hostname: monitor.hostname, port: monitor.port } : monitor.kind === "http" ? { url: monitor.url } : {}),
        published: monitor.published,
        scheduleMode: monitor.scheduleMode ?? "interval",
        ...(monitor.scheduleMode === "calendar" ? { cron: monitor.cron, timezone: monitor.timezone ?? "UTC" } : {}),
        ...(monitor.kind !== "heartbeat" || monitor.scheduleMode !== "calendar" ? { intervalSeconds: monitor.intervalSeconds } : {}), recoveryThreshold: monitor.recoveryThreshold,
        ...(monitor.kind === "heartbeat"
          ? monitor.scheduleMode === "calendar" ? { graceSeconds: monitor.graceSeconds } : { silenceSeconds: monitor.silenceSeconds, recoverySpacingSeconds: monitor.recoverySpacingSeconds }
          : { timeoutSeconds: monitor.timeoutSeconds, failureThreshold: monitor.failureThreshold }),
      } : {}),
    }));
    return {
      ...(secrets ? {
        destinations: state.destinations ?? [],
        webhookUrl: state.destinations?.find(destination => destination.id === state.legacyDestinationId)?.url ?? null,
      } : {}),
      paused: !!state.paused,
      pageName: state.pageName,
      monitors,
      monitor: monitors[0] ?? null,
      incidents: this.ctx.storage.sql
        .exec<Incident>(operator ? "SELECT * FROM incidents ORDER BY openedAt DESC, id"
          : "SELECT * FROM incidents WHERE openedAt < ? AND (closedAt IS NULL OR closedAt > ?) ORDER BY openedAt DESC, id",
          ...(operator ? [] : [start + 90 * DAY, start]))
        .toArray().filter(incident => operator || monitors.some(monitor => monitor.id === incident.monitorId)),
    };
  }
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

function parseWebhook(value: unknown): string | null | undefined {
  if (value === "") return null;
  if (typeof value !== "string" || value.length > 2048 || /\s/.test(value))
    return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
      return undefined;
    const discordPath = url.pathname.match(
      /^(\/api(?:\/v\d+)?\/webhooks\/[^/]+\/[^/]+)(?:\/slack)?\/?$/,
    );
    if (
      /^(?:(?:canary|ptb)\.)?discord(?:app)?\.com$/.test(url.hostname) &&
      discordPath
    ) {
      url.pathname = discordPath[1] + "/slack";
      return url.href;
    }
    return value;
  } catch {
    return undefined;
  }
}

function createWorker<E extends EngineEnv = EngineEnv>(adapter?: HostedAdapter<E>) {
  const app = createApp(adapter);
  return {
  async scheduled(controller: ScheduledController, env: E) {
    const contexts = adapter ? await adapter.contexts(env) : ["personal"];
    const unique = new Map<string, ScheduledContext>();
    for (const value of contexts) {
      const context = typeof value === "string" ? { id: value } : value;
      if (!context || typeof context.id !== "string" || !context.id ||
          !validPolicy(context)) throw new Error("Invalid hosted context");
      const prior = unique.get(context.id);
      if (prior && (prior.paused !== context.paused || prior.policyRevision !== context.policyRevision)) throw new Error("Conflicting hosted context");
      unique.set(context.id, context);
    }
    await Promise.all([...unique.values()].map(async (policy) => {
      const context = env.MONITORING.getByName(policy.id);
      if (policy.paused !== undefined) await context.setPaused(policy.paused, policy.policyRevision);
      await context.check(controller.scheduledTime);
    }));
  },
  async fetch(request: Request, env: E) {
    try {
      return await app.fetch(request, env);
    } catch {
      return requestFailed(request);
    }
  },
} satisfies ExportedHandler<E>; }

export default createWorker();

export class NotificationDelivery extends WorkerEntrypoint<EngineEnv> {
  async resolveWebhook(job: NotificationJob) {
    if (!/^[a-f0-9]{64}$/.test(job.contextId)) return null;
    const context = this.env.MONITORING.get(this.env.MONITORING.idFromString(job.contextId));
    return context.resolveWebhook(job);
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
    selectedMonitor: Status["monitor"] | null;
  };
};

function requestFailed(request: Request) {
  console.error(JSON.stringify({ event: "request_failed", path: new URL(request.url).pathname }));
  return Response.json({ error: "Internal server error" }, { status: 500, headers: { "Cache-Control": "no-store" } });
}

function methodNotAllowed(allow: string) {
  return new Response(null, { status: 405, headers: { Allow: allow } });
}

function operatorResponse<E extends EngineEnv>(c: Context<HttpEnv<E>>, result: Status | null, status = 200) {
  const resolved = c.get("resolved");
  return Response.json(result && { ...result, ...(resolved ? { hosted: true, permission: resolved.permission } : {}) }, { status });
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
  app.get("/", getOnly, async (c: Context<HttpEnv<E>>) => new Response(statusPage(await c.get("context").status()), { headers: { "Content-Type": "text/html; charset=utf-8" } }));
  app.get("/operator", getOnly, (c: Context<HttpEnv<E>>) => new Response(operatorPage(!!c.get("resolved")), { headers: { "Content-Type": "text/html; charset=utf-8" } }));
  app.get("/app.css", getOnly, () => new Response(styleSheet, { headers: { "Content-Type": "text/css; charset=utf-8" } }));
  app.get("/theme.js", getOnly, () => new Response(themeScript, { headers: { "Content-Type": "text/javascript; charset=utf-8" } }));
  app.get("/operator.js", getOnly, () => new Response(operatorScript, { headers: { "Content-Type": "text/javascript; charset=utf-8" } }));
  const subscribe: MiddlewareHandler<HttpEnv<E>> = async (c: Context<HttpEnv<E>>) => {
    const url = new URL(c.req.url);
    if (!allowedSubscriptionOrigin(c.req.raw, true)) return new Response(null, { status: 403 });
    if (url.search || c.req.header("Sec-WebSocket-Protocol")) return new Response(null, { status: 400 });
    return c.get("context").fetch(c.req.raw);
  };
  app.get("/api/status/events", getOnly, subscribe);
  app.get("/api/operator/events", getOnly, subscribe);
  app.get("/api/status", getOnly, async (c: Context<HttpEnv<E>>) => Response.json(await c.get("context").status()));

  const monitorPath = "/api/operator/monitors/:id";
  const maintenancePath = monitorPath + "/maintenance";
  const rotationPath = monitorPath + "/heartbeat-secret";
  const previewPath = "/api/operator/schedule-preview";
  const ticketPath = "/api/operator/events/ticket";
  const destinationsPath = "/api/operator/destinations";
  const destinationPath = destinationsPath + "/:id";
  const operatorPaths = [ticketPath, previewPath, destinationsPath, destinationPath, "/api/operator", "/api/operator/webhook", "/api/operator/monitors", monitorPath, maintenancePath, rotationPath];
  for (const path of operatorPaths) app.use(path, async (c, next) => {
    const resolved = c.get("resolved");
    if (path === rotationPath && !resolved) return c.notFound();
    const permission = resolved ? resolved.permission : await authorized(c.req.raw, c.env.INSTALLATION_SECRET) ? "editor" : null;
    if (!permission) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (permission !== "editor" && c.req.method !== "GET" && path !== ticketPath) return Response.json({ error: "Forbidden" }, { status: 403 });
    c.set("permission", permission);
    await next();
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
    if (Number(request.headers.get("Content-Length")) > 4096)
      return new Response(null, { status: 413 });
    const selectedMonitor: Status["monitor"] | null = c.req.path === "/api/operator" ? (await c.get("context").status(true)).monitor : null;
    c.set("selectedMonitor", selectedMonitor);
    let value: unknown;
    const reader = request.body?.getReader();
    let body = "";
    let bytes = 0;
    const decoder = new TextDecoder();
    if (reader) {
      try {
        while (true) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          bytes += chunk.byteLength;
          if (bytes > 4096) {
            await reader.cancel();
            return new Response(null, { status: 413 });
          }
          body += decoder.decode(chunk, { stream: true });
        }
        body += decoder.decode();
      } finally {
        reader.releaseLock();
      }
    }
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
    app.get(path, async (c: Context<HttpEnv<E>>) => c.req.method === "GET"
      ? operatorResponse(c, await c.get("context").status(true, c.get("permission") === "editor"))
      : methodNotAllowed(path === "/api/operator/monitors" || path === destinationsPath ? "GET, POST" : "GET, PUT"));
  }
  app.post(rotationPath, async (c: Context<HttpEnv<E>>) => {
    const result = await c.get("context").rotateHeartbeatSecret(monitorId(c));
    return result ? Response.json(result) : Response.json({ error: "Monitor not found" }, { status: 404 });
  });
  app.delete(maintenancePath, async (c: Context<HttpEnv<E>>) => {
    const result = await c.get("context").maintenance(monitorId(c), null, true);
    return result ? operatorResponse(c, result) : Response.json({ error: "Monitor not found" }, { status: 404 });
  });
  app.delete(monitorPath, async (c: Context<HttpEnv<E>>) => {
    const result = await c.get("context").remove(monitorId(c));
    return result ? operatorResponse(c, result) : Response.json({ error: "Monitor not found" }, { status: 404 });
  });
  app.put("/api/operator/webhook", readBody, async (c: Context<HttpEnv<E>>) => {
    const value = c.get("value");
    const url = value && typeof value === "object" ? (value as Record<string, unknown>).url : undefined;
    const destination = parseWebhook(url);
    if (destination === undefined) return Response.json({ error: "Enter an HTTPS webhook URL" }, { status: 400 });
    return operatorResponse(c, await c.get("context").configureDestination(null, destination, true));
  });
  const saveDestination = async (c: Context<HttpEnv<E>>) => {
    const value = c.get("value");
    const url = parseWebhook(value && typeof value === "object" && "url" in value ? value.url : undefined);
    if (!url) return Response.json({ error: "Enter an HTTPS webhook URL" }, { status: 400 });
    const creating = c.req.method === "POST";
    const result = await c.get("context").configureDestination(creating ? null : c.req.path.split("/")[4], url);
    return result ? operatorResponse(c, result, creating ? 201 : 200)
      : Response.json({ error: "Destination not found" }, { status: 404 });
  };
  app.post(destinationsPath, readBody, saveDestination);
  app.put(destinationPath, readBody, saveDestination);
  app.delete(destinationPath, async c => {
    const result = await c.get("context").configureDestination(c.req.path.split("/")[4], null);
    return result ? operatorResponse(c, result) : Response.json({ error: "Destination not found" }, { status: 404 });
  });
  app.put(maintenancePath, readBody, async (c: Context<HttpEnv<E>>) => {
    const result = await c.get("context").maintenance(monitorId(c), c.get("value"));
    if (result === undefined) return Response.json({ error: "Enter a future end time in epoch milliseconds" }, { status: 400 });
    return result ? operatorResponse(c, result) : Response.json({ error: "Monitor not found" }, { status: 404 });
  });
  app.post(previewPath, readBody, async (c: Context<HttpEnv<E>>) => {
    const result = await c.get("context").previewSchedule(c.get("value"));
    return Response.json(result, { status: "error" in result ? 400 : 200 });
  });
  app.patch(monitorPath, readBody, async (c: Context<HttpEnv<E>>) => {
    const result = await c.get("context").edit(monitorId(c), c.get("value"));
    if (result === undefined) return Response.json({ error: "Enter valid Monitor settings and an HTTP(S)/TCP target or Heartbeat settings; type cannot change" }, { status: 400 });
    return result ? operatorResponse(c, result) : Response.json({ error: "Monitor not found" }, { status: 404 });
  });
  app.post("/api/operator/monitors", readBody, async (c: Context<HttpEnv<E>>) => {
    const value = c.get("value");
    const result = await c.get("context").create(value, c.get("resolved")?.monitorLimit);
    if (result === undefined)
      return Response.json({ error: "Enter a Monitor name and HTTP(S)/TCP target or Heartbeat settings" }, { status: 400 });
    return result ? operatorResponse(c, result, 201) : Response.json({ error: "Monitor allowance reached" }, { status: 409 });
  });
  app.put("/api/operator", readBody, async (c: Context<HttpEnv<E>>) => {
    const value = c.get("value");
    const context = c.get("context");
    if (value && typeof value === "object" && Object.keys(value).length === 1 && "pageName" in value) {
      const pageName = value.pageName;
      if (typeof pageName !== "string" || !pageName.trim() || pageName.length > 120)
        return Response.json({ error: "Enter a page name" }, { status: 400 });
      return operatorResponse(c, await context.configure({ pageName: pageName.trim() }) ?? null);
    }
    if (c.get("resolved")) return Response.json({ error: "Use the Monitor collection" }, { status: 400 });
    const selectedMonitor = c.get("selectedMonitor");
    const result = await context.configure(value, selectedMonitor?.id ?? null);
    if (result === undefined) return Response.json({ error: "Enter a page name, Monitor name and HTTP(S)/TCP target or Heartbeat settings; type cannot change" }, { status: 400 });
    return result ? operatorResponse(c, result) : Response.json({ error: "Monitor changed; reload before saving" }, { status: 409 });
  });
  for (const path of operatorPaths) app.all(path, () => methodNotAllowed(
    (path === rotationPath || path === previewPath) ? "POST" : path === maintenancePath ? "PUT, DELETE" : path === monitorPath ? "PATCH, DELETE" : path === destinationPath ? "PUT, DELETE" : (path === "/api/operator/monitors" || path === destinationsPath) ? "GET, POST" : "GET, PUT",
  ));
  return app;
}
