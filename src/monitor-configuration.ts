// SPDX-License-Identifier: AGPL-3.0-only
import { calendar, type Schedule } from "./calendar";
import { selectableDestination, type NotificationDestination, type NotificationSelection } from "./notification-jobs";

export const destinationPendingConfirmation = "destination_pending_confirmation";

export const timingDefaults = {
  intervalSeconds: 60,
  timeoutSeconds: 10,
  failureThreshold: 2,
  recoveryThreshold: 2,
  silenceSeconds: 180,
  recoverySpacingSeconds: 60,
  graceSeconds: 30,
};
const timingBounds = {
  intervalSeconds: [60, 86_400],
  timeoutSeconds: [1, 60],
  failureThreshold: [1, 100],
  recoveryThreshold: [1, 100],
  silenceSeconds: [60, 86_400],
  recoverySpacingSeconds: [60, 86_400],
  graceSeconds: [1, 86_400],
} as const;
export function minimumCheckIntervalSeconds(value: string | number | undefined) {
  const [min, max] = timingBounds.intervalSeconds;
  if (value === undefined) return min;
  const seconds = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < min || seconds > max)
    throw new Error("MIN_CHECK_INTERVAL_SECONDS must be a whole number from 60 to 86400");
  return seconds;
}
type Timing = typeof timingDefaults;
type Target =
  | { kind: "http"; url: string; hostname?: never; port?: never }
  | { kind: "tcp"; hostname: string; port: number; url?: never }
  | { kind: "heartbeat"; url?: never; hostname?: never; port?: never };
type MonitorConfiguration = { name: string; published?: boolean } & Target & Partial<Timing> & Schedule;
type ScheduleConfiguration = Pick<MonitorConfiguration, "kind" | "scheduleMode" | "cron" | "timezone" | "graceSeconds">;
type Configuration = MonitorConfiguration & { pageName: string };

type CheckResult = { at: number; outcome: "success" | "failure" | "maintenance" };
export type MaintenanceWindow = { startedAt: number; endsAt: number };
export type Monitor = MonitorConfiguration & Timing & {
  maintenance?: MaintenanceWindow | null;
  published: boolean;
  id: string;
  state: "unknown" | "up" | "down";
  lastResult: CheckResult | null;
  failures: number;
  successes: number;
  nextDue: number;
  lastOutboundCheckAt?: number;
  lastOutboundStartedAt?: number;
  outboundCalendarFloor?: { seconds: number; compatible: boolean };
  createdAt: number;
  lastSeen: number | null;
  recoveryReceiptAt: number | null;
  heartbeatDigest?: ArrayBuffer;
  scheduleRevision?: number;
  historyRevision?: number;
  historyRetryToken?: string;
  historyChangedAt?: number;
  notificationSelections?: NotificationSelection[];
};

export function monitorResource(monitor: Monitor) {
  const common = {
    id: monitor.id,
    name: monitor.name,
    published: monitor.published,
    scheduleMode: monitor.scheduleMode ?? "interval",
    recoveryThreshold: monitor.recoveryThreshold,
    destinationIds: (monitor.notificationSelections ?? []).map(selection => selection.destinationId),
    ...(monitor.scheduleMode === "calendar"
      ? { cron: monitor.cron, timezone: monitor.timezone ?? "UTC" } : {}),
  };
  if (monitor.kind === "heartbeat") {
    return {
      ...common, kind: monitor.kind,
      ...(monitor.scheduleMode === "calendar" ? { graceSeconds: monitor.graceSeconds } : {
        intervalSeconds: monitor.intervalSeconds,
        silenceSeconds: monitor.silenceSeconds,
        recoverySpacingSeconds: monitor.recoverySpacingSeconds,
      }),
    };
  }
  const outbound = {
    ...common, intervalSeconds: monitor.intervalSeconds,
    timeoutSeconds: monitor.timeoutSeconds, failureThreshold: monitor.failureThreshold,
  };
  return monitor.kind === "tcp"
    ? { ...outbound, kind: monitor.kind, hostname: monitor.hostname, port: monitor.port }
    : { ...outbound, kind: monitor.kind, url: monitor.url };
}

// Internal synchronous operations owned by MonitoringContext. Only Calendar validation may yield.
type ConfigurationRuntime<State, Result> = {
  minimumCheckIntervalSeconds(): number;
  read(): State;
  commit(state: State, previousName: string, previous?: Monitor, current?: Monitor): Result;
};

export class MonitorConfigurations<State extends { pageName: string; monitors: Monitor[]; destinations?: NotificationDestination[] }, Result> {
  constructor(private runtime: ConfigurationRuntime<State, Result>) {}

  private validInterval(patch: Partial<MonitorConfiguration>, current?: MonitorConfiguration) {
    if ((patch.kind ?? current?.kind) === "heartbeat" || (patch.scheduleMode ?? current?.scheduleMode) === "calendar") return true;
    const interval = patch.intervalSeconds ?? (patch.scheduleMode === "interval" && current?.scheduleMode === "calendar" ? current.intervalSeconds : undefined);
    return interval === undefined || interval >= this.runtime.minimumCheckIntervalSeconds();
  }

  private scheduleProof(configuration: ScheduleConfiguration, fields: object, current?: Monitor) {
    if (configuration.scheduleMode !== "calendar") return null;
    if (configuration.kind !== "heartbeat") {
      if (current?.scheduleMode === "calendar" && !("scheduleMode" in fields || "cron" in fields || "timezone" in fields)) return null;
      const floor = this.runtime.minimumCheckIntervalSeconds();
      if (current?.outboundCalendarFloor?.compatible && current.outboundCalendarFloor.seconds === floor &&
          current.cron === configuration.cron && current.timezone === configuration.timezone) return null;
      return JSON.stringify([configuration.cron, configuration.timezone, floor]);
    }
    const key = JSON.stringify([configuration.cron, configuration.timezone, configuration.graceSeconds ?? timingDefaults.graceSeconds]);
    return current?.scheduleMode === "calendar" && key === JSON.stringify([current.cron, current.timezone, current.graceSeconds]) ? null : key;
  }

  private acceptsProof(configuration: ScheduleConfiguration) {
    const parsed = calendar(configuration.cron, configuration.timezone);
    return configuration.kind === "heartbeat"
      ? parsed.acceptsGraceAsync(configuration.graceSeconds ?? timingDefaults.graceSeconds, Date.now())
      : parsed.acceptsMinimumGap(this.runtime.minimumCheckIntervalSeconds(), Date.now());
  }

  async configure(value: unknown, expectedMonitorId: string | null = null) {
    // Validation yields: re-read and reparse before committing, retaining this request’s proofs.
    const proofs = new Set<string>();
    for (;;) {
      if (!value || typeof value !== "object") return undefined;
      const fields = value as Record<string, unknown>;
      const state = this.runtime.read();
      let configuration: Configuration | { pageName: string };
      let validatedSchedule = false;
      if (Object.keys(fields).length === 1 && "pageName" in fields) {
        if (typeof fields.pageName !== "string" || !fields.pageName.trim() || fields.pageName.length > 120) return undefined;
        configuration = { pageName: fields.pageName.trim() };
      } else {
        // Keep the original single-Monitor save contract for existing clients.
        const monitor = state.monitors[0];
        // A legacy save must never move to a sibling while the request is in flight.
        if ((monitor?.id ?? null) !== expectedMonitorId) return null;
        const schedule = monitor?.scheduleMode === "calendar" && fields.scheduleMode === undefined
          ? { scheduleMode: monitor.scheduleMode, cron: monitor.cron, timezone: monitor.timezone } : {};
        const grace = monitor?.kind === "heartbeat" && (fields.scheduleMode ?? monitor.scheduleMode) === "calendar" ? { graceSeconds: monitor.graceSeconds } : {};
        const parsed = parseConfiguration({ ...schedule, ...grace, ...fields }, monitor?.kind, monitor);
        if (!parsed || !validKindFields({ ...fields, scheduleMode: parsed.scheduleMode ?? "interval" }, parsed.kind) || (monitor && monitor.kind !== parsed.kind) || !this.validInterval(parsed, monitor)) return undefined;
        const proof = this.scheduleProof(parsed, fields, monitor);
        if (proof && !proofs.has(proof)) {
          if (!await this.acceptsProof(parsed)) return undefined;
          proofs.add(proof);
          continue;
        }
        validatedSchedule = proof !== null;
        configuration = parsed;
      }
      const previousName = state.pageName;
      const previous = "kind" in configuration && state.monitors[0] ? { ...state.monitors[0] } : undefined;
      if ("kind" in configuration) {
        const { pageName: _pageName, ...settings } = configuration;
        const monitor = state.monitors[0];
        if (monitor) this.applyEdit(monitor, settings, validatedSchedule);
        else state.monitors.push(this.newMonitor(settings));
      }
      state.pageName = configuration.pageName;
      return this.runtime.commit(state, previousName, previous, "kind" in configuration ? state.monitors[0] : undefined);
    }
  }

  private newMonitor(configuration: MonitorConfiguration): Monitor {
    const intervalSeconds = configuration.kind !== "heartbeat" && configuration.scheduleMode !== "calendar"
      ? this.runtime.minimumCheckIntervalSeconds() : timingDefaults.intervalSeconds;
    return { ...timingDefaults, intervalSeconds, scheduleMode: "interval", ...configuration, id: crypto.randomUUID(), published: configuration.published ?? true, state: "unknown", lastResult: null,
      ...(configuration.kind !== "heartbeat" && configuration.scheduleMode === "calendar" ? { outboundCalendarFloor: this.compatibleFloor() } : {}),
      failures: 0, successes: 0, nextDue: configuration.scheduleMode === "calendar" ? calendar(configuration.cron, configuration.timezone).next(Date.now())[0] : 0, createdAt: Date.now(), lastSeen: null, recoveryReceiptAt: null };
  }

  async create(value: unknown, limit?: number) {
    const configuration = parseMonitorPatch(value);
    if (!configuration || !this.validInterval(configuration)) return undefined;
    if (this.scheduleProof(configuration, configuration) && !await this.acceptsProof(configuration)) return undefined;
    const state = this.runtime.read();
    // No await between allowance check and synchronous persistence: concurrent RPCs serialize.
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0 || state.monitors.length >= limit)) return null;
    const monitor = this.newMonitor(configuration);
    if (value && typeof value === "object" && "destinationIds" in value) {
      const selections = replacementSelections(value.destinationIds, state.destinations);
      if (!Array.isArray(selections)) return selections;
      monitor.notificationSelections = selections;
    }
    state.monitors.push(monitor);
    const ack = this.runtime.commit(state, state.pageName, undefined, monitor);
    return { ack, monitor };
  }

  async edit(id: string, value: unknown) {
    // Validation yields: re-read and reparse before committing, retaining this request’s proofs.
    const proofs = new Set<string>();
    for (;;) {
      const state = this.runtime.read();
      const monitor = state.monitors.find(monitor => monitor.id === id);
      if (!monitor) return null;
      const patch = parseMonitorPatch(value, monitor);
      if (!patch || !this.validInterval(patch, monitor)) return undefined;
      const configuration = { ...monitor, ...patch };
      const proof = this.scheduleProof(configuration, value as object, monitor);
      if (proof && !proofs.has(proof)) {
        if (!await this.acceptsProof(configuration)) return undefined;
        proofs.add(proof);
        continue;
      }
      const previous = { ...monitor };
      if (value && typeof value === "object" && "destinationChanges" in value) {
        const changes = value.destinationChanges;
        if ("destinationIds" in value || !changes || typeof changes !== "object" || Array.isArray(changes)) return undefined;
        const entries = Object.entries(changes);
        if (entries.some(([id, selected]) => typeof selected !== "boolean" ||
            (selected && !state.destinations?.some(destination => destination.id === id && selectableDestination(destination))))) return undefined;
        const selections = new Map(monitor.notificationSelections?.map(selection => [selection.destinationId, selection]));
        for (const [destinationId, selected] of entries) {
          if (!selected) selections.delete(destinationId);
          else if (!selections.has(destinationId)) selections.set(destinationId, { destinationId, generation: crypto.randomUUID() });
        }
        monitor.notificationSelections = [...selections.values()];
      }
      if (value && typeof value === "object" && "destinationIds" in value) {
        const selections = replacementSelections(value.destinationIds, state.destinations, monitor.notificationSelections);
        if (!Array.isArray(selections)) return selections;
        monitor.notificationSelections = selections;
      }
      this.applyEdit(monitor, patch, proof !== null);
      const ack = this.runtime.commit(state, state.pageName, previous, monitor);
      return { ack, monitor };
    }
  }

  private compatibleFloor() {
    return { seconds: this.runtime.minimumCheckIntervalSeconds(), compatible: true };
  }

  private applyEdit(monitor: Monitor, patch: Partial<MonitorConfiguration>, validatedSchedule: boolean) {
    const resume = validatedSchedule && monitor.outboundCalendarFloor?.compatible === false;
    if (validatedSchedule && monitor.kind !== "heartbeat") monitor.outboundCalendarFloor = this.compatibleFloor();
    const changed = resume || (["scheduleMode", "cron", "timezone", "graceSeconds"] as const).some(key => patch[key] !== undefined && patch[key] !== monitor[key]);
    if (changed) {
      Object.assign(monitor, patch);
      if (monitor.scheduleMode === "interval") { delete monitor.cron; delete monitor.timezone; delete monitor.outboundCalendarFloor; }
      monitor.recoveryReceiptAt = null;
      monitor.scheduleRevision = (monitor.scheduleRevision ?? 0) + 1;
      monitor.nextDue = monitor.scheduleMode === "calendar" ? calendar(monitor.cron, monitor.timezone).next(Date.now())[0] : Date.now() + monitor.intervalSeconds * 1000;
      monitor.failures = 0;
      monitor.successes = 0;
      return;
    }
    // Preserve #3's last-dispatch anchor, including a running attempt.
    if (monitor.scheduleMode !== "calendar" && monitor.nextDue && patch.intervalSeconds !== undefined)
      monitor.nextDue += (patch.intervalSeconds - monitor.intervalSeconds) * 1000;
    Object.assign(monitor, patch);
  }
}

function replacementSelections(ids: unknown, destinations: NotificationDestination[] = [], existing: NotificationSelection[] = []) {
  if (!Array.isArray(ids) || new Set(ids).size !== ids.length) return undefined;
  const assigned = ids.map(id => destinations.find(destination => destination.id === id));
  if (!assigned.every(destination => destination !== undefined)) return undefined;
  if (!assigned.every(selectableDestination)) return destinationPendingConfirmation;
  return assigned.map(({ id: destinationId }) =>
    existing.find(selection => selection.destinationId === destinationId) ??
    { destinationId, generation: crypto.randomUUID() });
}

function parseConfiguration(value: unknown, existingKind: Configuration["kind"] = "http", current?: MonitorConfiguration): Configuration | null {
  if (!value || typeof value !== "object") return null;
  const { pageName, name, url, kind = existingKind, hostname, port } = value as Record<string, unknown>;
  if (
    typeof pageName !== "string" || !pageName.trim() || pageName.length > 120 ||
    typeof name !== "string" || !name.trim() || name.length > 120
  ) return null;
  try {
    let target: Target;
    if (kind === "tcp") {
      if (typeof hostname !== "string" || !hostname || hostname.length > 253 ||
          !Number.isInteger(port) || typeof port !== "number" || port < 1 || port > 65535)
        return null;
      const host = hostname.toLowerCase();
      if (host.includes(":")) {
        if (host.startsWith("[") && !host.endsWith("]")) return null;
        const literal = host.startsWith("[") ? host.slice(1, -1) : host;
        if (!/^[0-9a-f:.]+$/.test(literal)) return null;
        const parsed = new URL(`http://[${literal}]/`);
        target = { kind, hostname: parsed.hostname.slice(1, -1), port, url: undefined };
      } else {
        if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?$/.test(host))
          return null;
        target = { kind, hostname: host, port, url: undefined };
      }
    } else if (kind === "http") {
      if (typeof url !== "string" || url.length > 2048) return null;
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
        return null;
      parsed.hash = "";
      target = { kind, url: parsed.href, hostname: undefined, port: undefined };
    } else if (kind === "heartbeat") {
      target = { kind };
    } else return null;
    const timing: Partial<Timing> = {};
    for (const key of Object.keys(timingDefaults) as (keyof Timing)[]) {
      if (!(key in value)) continue;
      const input = (value as Record<string, unknown>)[key];
      const [min, max] = timingBounds[key];
      if (typeof input !== "number" || !Number.isInteger(input) || input < min || input > max)
        return null;
      timing[key] = input;
    }
    const fields = value as Record<string, unknown>;
    const schedule: Schedule = {};
    if (fields.scheduleMode !== undefined) {
      if (!["interval", "calendar"].includes(fields.scheduleMode as string)) return null;
      schedule.scheduleMode = fields.scheduleMode as Schedule["scheduleMode"];
    }
    if (fields.scheduleMode === "calendar") {
      if (current?.scheduleMode === "calendar" && fields.cron === current.cron &&
          (fields.timezone === undefined ? "UTC" : fields.timezone) === current.timezone &&
          (kind !== "heartbeat" || (timing.graceSeconds ?? timingDefaults.graceSeconds) === current.graceSeconds)) {
        schedule.cron = current.cron; schedule.timezone = current.timezone;
      } else {
        const parsed = calendar(fields.cron, fields.timezone === undefined ? "UTC" : fields.timezone);
        parsed.next(Date.now());
        schedule.cron = parsed.cron; schedule.timezone = parsed.timezone;
      }
    } else if ("cron" in fields || "timezone" in fields) return null;
    return { pageName: pageName.trim(), name: name.trim(), ...target, ...timing, ...schedule };
  } catch {
    return null;
  }
}

function validKindFields(fields: Record<string, unknown>, kind: Configuration["kind"]) {
  return (fields.scheduleMode !== "interval" || !("graceSeconds" in fields)) &&
    (kind !== "heartbeat" || fields.scheduleMode !== "calendar" || !("intervalSeconds" in fields || "silenceSeconds" in fields || "recoverySpacingSeconds" in fields)) && (kind === "http" || !("url" in fields)) &&
    (kind === "tcp" || !("hostname" in fields || "port" in fields)) &&
    (kind === "heartbeat"
      ? !("timeoutSeconds" in fields || "failureThreshold" in fields)
      : !("silenceSeconds" in fields || "recoverySpacingSeconds" in fields || "graceSeconds" in fields));
}

function parseMonitorPatch(value: unknown): MonitorConfiguration | null;
function parseMonitorPatch(value: unknown, current: MonitorConfiguration): Partial<MonitorConfiguration> | null;
function parseMonitorPatch(value: unknown, current?: MonitorConfiguration): Partial<MonitorConfiguration> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  if (!Object.keys(fields).length || Object.keys(fields).some(key => !["name", "kind", "url", "hostname", "port", "published", "scheduleMode", "cron", "timezone", "destinationIds", "destinationChanges", ...Object.keys(timingDefaults)].includes(key))) return null;
  if ((!current && (!("name" in fields) || "destinationChanges" in fields)) || ("published" in fields && typeof fields.published !== "boolean")) return null;
  const merged: Record<string, unknown> = { pageName: "Irisbeat", name: "Monitor", ...current, ...fields };
  if (fields.scheduleMode === "interval") {
    if ("cron" in fields || "timezone" in fields) return null;
    delete merged.cron; delete merged.timezone;
  }
  const configuration = parseConfiguration(merged, "http", current);
  if (!configuration || (current && configuration.kind !== current.kind) || !validKindFields({ ...fields, scheduleMode: merged.scheduleMode ?? "interval" }, configuration.kind)) return null;
  if (!current) {
    const { pageName: _pageName, ...settings } = configuration;
    return { ...settings, published: fields.published as boolean | undefined };
  }
  const patch: Record<string, unknown> = {};
  for (const key of ["name", "published", ...Object.keys(timingDefaults)]) {
    if (key in fields) patch[key] = key === "published" ? fields[key] : configuration[key as keyof Configuration];
  }
  if (fields.scheduleMode === "interval") Object.assign(patch, { scheduleMode: "interval" });
  else for (const key of ["scheduleMode", "cron", "timezone"] as const) {
    if (key in fields || (fields.scheduleMode === "calendar" && key === "timezone")) patch[key] = configuration[key];
  }
  if (["kind", "url", "hostname", "port"].some(key => key in fields)) {
    Object.assign(patch, configuration.kind === "tcp"
      ? { kind: "tcp", hostname: configuration.hostname, port: configuration.port, url: undefined }
      : configuration.kind === "http" ? { kind: "http", url: configuration.url, hostname: undefined, port: undefined }
      : { kind: "heartbeat" });
  }
  return patch as Partial<MonitorConfiguration>;
}
