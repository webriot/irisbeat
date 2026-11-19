// SPDX-License-Identifier: AGPL-3.0-only
import type { Monitor } from "./monitor-configuration";

export const DAY = 86_400_000;
export const historyStart = (at: number) => Math.floor(at / DAY) * DAY - 89 * DAY;
export type HistoryDay = {
  date: string;
  state: "up" | "down" | "degraded" | "maintenance" | "empty";
  successes: number;
  failures: number;
  maintenance: number;
};
export type AvailabilityHistory = { days: HistoryDay[]; percentage: number | null; stale?: true; pending?: true };

type Observation = NonNullable<Monitor["lastResult"]>;
export type AvailabilityQuery = {
  tenantKey: string;
  monitorIds: string[];
  start: number;
  end: number;
  observation?: Observation;
};
export type AvailabilityRow = Omit<HistoryDay, "state"> & { monitorId: string };
export interface AvailabilityQueryService {
  queryAvailability(query: AvailabilityQuery): Promise<AvailabilityRow[]>;
}
export interface AvailabilityEnv {
  AVAILABILITY_HISTORY?: AnalyticsEngineDataset;
  AVAILABILITY_QUERY?: AvailabilityQueryService;
  AVAILABILITY_ACCOUNT_ID?: string;
  AVAILABILITY_API_TOKEN?: string;
  AVAILABILITY_DATASET?: string;
}

type CachedSeries = {
  start: number;
  revision: number;
  freshUntil: number;
  queriedAt?: number;
  pending?: boolean;
  rows: AvailabilityRow[];
};
const flushKey = "availability-flush-at";
const flushDelay = 5_000;
const cacheKey = (id: string) => "availability:" + id;
const batchSize = 50;
// https://developers.cloudflare.com/analytics/analytics-engine/limits/
export const availabilityWriteLimit = 250;
const timeout = 3_000;
const freshFor = 60_000;
const retryAfter = 15_000;
export const historyRetryInterval = 30_000;
export const historyRetryAttempts = 4;
const historyRetryWindow = historyRetryInterval * historyRetryAttempts;
const queriedAt = (cached: CachedSeries) => cached.queriedAt ?? cached.freshUntil - freshFor;
const date = (at: number) => new Date(at).toISOString().slice(0, 10);

function series(rows: AvailabilityRow[], start: number, stale = false, pending = false): AvailabilityHistory {
  const counts = new Map(rows.map(row => [row.date, row]));
  let totalSuccess = 0;
  let totalFailure = 0;
  const days: HistoryDay[] = Array.from({ length: 90 }, (_, index) => {
    const day = date(start + index * DAY);
    const { successes = 0, failures = 0, maintenance = 0 } = counts.get(day) ?? {};
    totalSuccess += successes;
    totalFailure += failures;
    return {
      date: day, successes, failures, maintenance,
      state: successes && failures ? "degraded" : successes ? "up" : failures ? "down" : maintenance ? "maintenance" : "empty",
    };
  });
  return { days, percentage: totalSuccess + totalFailure ? totalSuccess / (totalSuccess + totalFailure) * 100 : null, ...(stale ? { stale: true } : {}), ...(pending ? { pending: true } : {}) };
}

// Only deployment-controlled identifiers and engine-issued IDs reach the SQL builder.
function queryConfiguration(env: AvailabilityEnv) {
  const dataset = env.AVAILABILITY_DATASET ?? "irisbeat_availability";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(dataset) ||
      !/^[a-f0-9]{32}$/.test(env.AVAILABILITY_ACCOUNT_ID ?? "") ||
      !env.AVAILABILITY_API_TOKEN?.trim()) return null;
  return { dataset, account: env.AVAILABILITY_ACCOUNT_ID, token: env.AVAILABILITY_API_TOKEN };
}

async function directQuery(env: AvailabilityEnv, query: AvailabilityQuery) {
  const config = queryConfiguration(env);
  if (!config) throw new Error("Analytics Engine SQL configuration missing");
  const { tenantKey, monitorIds, start, end, observation } = query;
  if (!/^[a-f0-9]{64}$/.test(tenantKey) || monitorIds.some(id => !/^[a-zA-Z0-9_-]{1,128}$/.test(id)))
    throw new Error("Invalid Analytics Engine scope");
  const selection = monitorIds.map(id => "'" + id + "'").join(", ");
  const exact = observation ? ` AND double1 = ${observation.at} AND blob2 = '${observation.outcome}'` : "";
  const sql = `SELECT blob1 AS monitorId,
    formatDateTime(toDateTime(double1 / 1000, 'UTC'), '%Y-%m-%d', 'UTC') AS date,
    SUM(IF(blob2 = 'success', _sample_interval, 0)) AS successes,
    SUM(IF(blob2 = 'failure', _sample_interval, 0)) AS failures,
    SUM(IF(blob2 = 'maintenance', _sample_interval, 0)) AS maintenance
    FROM ${config.dataset}
    WHERE index1 = '${tenantKey}' AND blob1 IN (${selection})
      AND double1 >= ${start} AND double1 < ${end}${exact}
    GROUP BY monitorId, date
    LIMIT ${monitorIds.length * 90}
    FORMAT JSON`;
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${config.account}/analytics_engine/sql`, {
    method: "POST", body: sql, headers: { Authorization: "Bearer " + config.token, "Content-Type": "text/plain" },
    redirect: "error", signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error("Analytics Engine SQL request failed");
  return (await response.json<{ data: unknown }>()).data;
}

function count(value: unknown) {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Invalid Analytics Engine count");
  return parsed;
}

function checkedRows(rows: unknown, query: AvailabilityQuery): AvailabilityRow[] {
  if (!Array.isArray(rows) || rows.length > query.monitorIds.length * 90) throw new Error("Invalid Analytics Engine result");
  const allowed = new Set(query.monitorIds);
  const first = date(query.start);
  const end = date(query.end);
  const seen = new Set<string>();
  return rows.map(row => {
    if (!row || !allowed.has(row.monitorId) || typeof row.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) ||
        row.date < first || row.date >= end || !Number.isFinite(Date.parse(row.date)) || date(Date.parse(row.date)) !== row.date)
      throw new Error("Invalid Analytics Engine row");
    const key = row.monitorId + ":" + row.date;
    if (seen.has(key)) throw new Error("Duplicate Analytics Engine row");
    seen.add(key);
    return { monitorId: row.monitorId, date: row.date, successes: count(row.successes), failures: count(row.failures), maintenance: count(row.maintenance) };
  });
}

export class Availability {
  private nextAttempt = new Map<string, number>();

  constructor(private env: AvailabilityEnv, private ctx: DurableObjectState) {
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS availability_outbox (
      id INTEGER PRIMARY KEY, monitorId TEXT NOT NULL, at INTEGER NOT NULL, outcome TEXT NOT NULL
    )`);
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS availability_outbox_monitor ON availability_outbox (monitorId)");
    if (this.configured) ctx.storage.sql.exec("DROP TABLE IF EXISTS observations");
  }

  get configured() {
    return typeof this.env.AVAILABILITY_HISTORY?.writeDataPoint === "function" &&
      (typeof this.env.AVAILABILITY_QUERY?.queryAvailability === "function" || !!queryConfiguration(this.env));
  }

  enqueue(monitorId: string, { at, outcome }: Observation) {
    this.ctx.storage.sql.exec("INSERT INTO availability_outbox (monitorId, at, outcome) VALUES (?, ?, ?)", monitorId, at, outcome);
    if (this.flushAt === undefined) this.delayFlush(Date.now());
  }

  get flushAt() {
    return this.configured ? this.ctx.storage.kv.get<number>(flushKey) : undefined;
  }

  delayFlush(now: number) {
    this.ctx.storage.kv.put(flushKey, now + flushDelay);
  }

  flush(now: number, limit: number) {
    const changed = new Set<string>();
    if (!this.configured) return changed;
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM availability_outbox WHERE at < ?", historyStart(now));
    const rows = sql.exec<Observation & { id: number; monitorId: string }>(
      "SELECT id, monitorId, at, outcome FROM availability_outbox ORDER BY id LIMIT ?", limit,
    ).toArray();
    for (const { id, monitorId, at, outcome } of rows) {
      if (!this.write(monitorId, { at, outcome })) break;
      sql.exec("DELETE FROM availability_outbox WHERE id = ?", id);
      changed.add(monitorId);
    }
    if (!sql.exec("SELECT 1 FROM availability_outbox LIMIT 1").toArray().length) {
      this.ctx.storage.kv.delete(flushKey);
    }
    return changed;
  }

  private write(monitorId: string, observation: Observation) {
    try {
      if (!this.env.AVAILABILITY_HISTORY) throw new Error("Analytics Engine write binding missing");
      this.env.AVAILABILITY_HISTORY.writeDataPoint({
        indexes: [this.ctx.id.toString()],
        blobs: [monitorId, observation.outcome],
        doubles: [observation.at],
      });
      return true;
    } catch {
      console.error(JSON.stringify({ event: "history_write_failed" }));
      return false;
    }
  }

  remove(monitorId: string) {
    this.nextAttempt.delete(monitorId);
    this.ctx.storage.kv.delete(cacheKey(monitorId));
  }

  private async query(ids: string[], start: number, end: number, observation?: Observation) {
    const query = { tenantKey: this.ctx.id.toString(), monitorIds: ids, start, end, ...(observation ? { observation } : {}) };
    const service = this.env.AVAILABILITY_QUERY;
    if (!service) return checkedRows(await directQuery(this.env, query), query);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Analytics Engine query timed out")), timeout);
      });
      return checkedRows(await Promise.race([service.queryAvailability(query), deadline]), query);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async readiness(monitors: Monitor[], now: number): Promise<
    { ready: true } | { ready: false; reason: "configuration_missing" | "observation_pending" | "observation_unconfirmed" | "query_unavailable" }
  > {
    if (!this.configured) return { ready: false, reason: "configuration_missing" };
    const start = historyStart(now);
    const end = start + 90 * DAY;
    let latest: { id: string; observation: Observation } | undefined;
    for (const { id, historyRevision, lastResult } of monitors) {
      if (historyRevision && lastResult && lastResult.at >= start && lastResult.at < end && (!latest || lastResult.at > latest.observation.at)) {
        latest = { id, observation: lastResult };
      }
    }
    if (!latest) return { ready: false, reason: "observation_pending" };
    const { id, observation } = latest;
    try {
      const rows = await this.query([id], start, end, observation);
      const field = { success: "successes", failure: "failures", maintenance: "maintenance" } as const;
      return rows.some(row => row.date === date(observation.at) && row[field[observation.outcome]] > 0)
        ? { ready: true }
        : { ready: false, reason: "observation_unconfirmed" };
    } catch {
      return { ready: false, reason: "query_unavailable" };
    }
  }

  private cachedSeries(monitor: Monitor, now: number, start: number, configured: boolean) {
    if (!monitor.historyRevision) return configured ? series([], start) : null;
    const cached = this.ctx.storage.kv.get<CachedSeries>(cacheKey(monitor.id));
    return this.cachedHistory(cached, monitor.historyRevision, now, start, configured);
  }

  private cachedHistory(cached: CachedSeries | undefined, revision: number | undefined, now: number, start: number, configured: boolean) {
    if (!cached || Math.abs(cached.start - start) >= 90 * DAY) return null;
    const fresh = configured && cached.start === start && cached.revision === revision && now < cached.freshUntil;
    return series(cached.rows, start, !fresh, cached.pending);
  }

  cached(monitors: Monitor[], now: number) {
    const start = historyStart(now);
    const configured = this.configured;
    return new Map(monitors.map(monitor => [monitor.id, this.cachedSeries(monitor, now, start, configured)]));
  }

  async read(monitors: Monitor[], now: number, currentRevisions: () => Map<string, number | undefined>) {
    const start = historyStart(now);
    const result = new Map<string, AvailabilityHistory | null>();
    const pending: Monitor[] = [];
    const configured = this.configured;
    for (const monitor of monitors) {
      const cached = this.cachedSeries(monitor, now, start, configured);
      result.set(monitor.id, cached);
      if (monitor.historyRevision && (!cached || cached.stale) && configured && now >= (this.nextAttempt.get(monitor.id) ?? -Infinity)) {
        pending.push(monitor);
      }
    }
    const batches = [];
    for (let offset = 0; offset < pending.length; offset += batchSize) batches.push(pending.slice(offset, offset + batchSize));
    await Promise.all(batches.map(async batch => {
      try {
        const rows = await this.query(batch.map(monitor => monitor.id), start, start + 90 * DAY);
        const rowsByMonitor = new Map(batch.map(({ id }) => [id, [] as AvailabilityRow[]]));
        for (const row of rows) rowsByMonitor.get(row.monitorId)!.push(row);
        const revisions = currentRevisions();
        for (const { id, historyRevision, historyChangedAt } of batch) {
          if (!revisions.has(id)) { result.set(id, null); continue; }
          const revision = historyRevision!;
          const key = cacheKey(id);
          const previous = this.ctx.storage.kv.get<CachedSeries>(key);
          const pendingUntil = (historyChangedAt ?? -Infinity) + historyRetryWindow;
          const queued = this.ctx.storage.sql.exec("SELECT 1 FROM availability_outbox WHERE monitorId = ? LIMIT 1", id).toArray().length > 0;
          const pending = queued || now < pendingUntil;
          const freshUntil = queued ? now + retryAfter
            : pending ? Math.min(now + retryAfter, pendingUntil) : now + freshFor;
          let latest: CachedSeries = {
            start, revision, queriedAt: now, freshUntil,
            rows: rowsByMonitor.get(id)!, pending,
          };
          // A raced query is still a useful fallback if no newer query has succeeded.
          if (previous && (previous.revision > revision ||
              (previous.revision === revision && queriedAt(previous) >= now))) {
            latest = previous;
          } else {
            this.ctx.storage.kv.put(key, latest);
          }
          const stale = latest.start !== start || latest.revision !== revisions.get(id) || now >= latest.freshUntil;
          if (!stale) this.nextAttempt.delete(id);
          result.set(id, series(latest.rows, start, stale, latest.pending));
        }
      } catch {
        const revisions = currentRevisions();
        for (const { id, historyRevision } of batch) {
          const revision = revisions.get(id);
          const latest = this.ctx.storage.kv.get<CachedSeries>(cacheKey(id));
          result.set(id, revisions.has(id) ? this.cachedHistory(latest, revision, Date.now(), start, configured) : null);
          if (historyRevision === revision && (!latest || latest.revision !== revision || queriedAt(latest) < now)) {
            this.nextAttempt.set(id, Math.max(this.nextAttempt.get(id) ?? -Infinity, now + retryAfter));
          }
        }
        console.error(JSON.stringify({ event: "history_query_failed" }));
      }
    }));
    return result;
  }
}
