// SPDX-License-Identifier: AGPL-3.0-only
import type { AvailabilityQuery, AvailabilityRow } from "../src/index";

// Wrangler discards local Analytics Engine writes. This fake replaces that external boundary.
export function availabilityFixture(storage?: DurableObjectStorage) {
  const key = "test:analytics-points";
  const records = storage?.kv.get<{ point: AnalyticsEngineDataPoint; loggedAt: number }[]>(key) ?? [];
  const queries: AvailabilityQuery[] = [];
  let mode = "available";
  let holdFailure = false;
  return {
    get points() { return records.map(({ point }) => point); },
    queries,
    setMode(value: string) {
      if (value === "held-failure") holdFailure = true;
      if (value === "release-failure" || value === "available") holdFailure = false;
      mode = value;
      if (value === "available") { records.length = 0; queries.length = 0; }
    },
    bindings: {
      AVAILABILITY_HISTORY: {
        writeDataPoint(point?: AnalyticsEngineDataPoint) {
          if (mode === "write-rejected") throw new Error("Substituted synchronous Analytics Engine write failure");
          if (point && mode !== "write-failed") {
            records.push({ point, loggedAt: Math.floor(Date.now() / 1000) });
            storage?.kv.put(key, records);
          }
        },
      },
      AVAILABILITY_QUERY: {
        async queryAvailability(query: AvailabilityQuery): Promise<AvailabilityRow[]> {
          queries.push(query);
          if (mode === "held-failure") {
            while (holdFailure) await new Promise(resolve => setTimeout(resolve, 10));
            throw new Error("Substituted delayed Analytics Engine query failure");
          }
          if (mode === "lagging") return [];
          if (mode === "failed" || mode === "missing") throw new Error("Substituted Analytics Engine query failure");
          const rows = new Map<string, AvailabilityRow>();
          for (const { point, loggedAt } of records) {
            const [monitorId, outcome] = point.blobs ?? [];
            const at = point.doubles?.[0]!;
            if (typeof monitorId !== "string" || !query.monitorIds.includes(monitorId) || point.indexes?.[0] !== query.tenantKey ||
                at < query.start || at >= query.end || (query.loggedBefore !== undefined && loggedAt >= query.loggedBefore) || (query.observation && (at !== query.observation.at || outcome !== query.observation.outcome))) continue;
            const date = new Date(at).toISOString().slice(0, 10);
            const key = monitorId + ":" + date;
            const row = rows.get(key) ?? { monitorId, date, successes: 0, failures: 0, maintenance: 0 };
            if (outcome === "success") row.successes++;
            if (outcome === "failure") row.failures++;
            if (outcome === "maintenance") row.maintenance++;
            rows.set(key, row);
          }
          while (mode === "held") await new Promise(resolve => setTimeout(resolve, 10));
          return [...rows.values()];
        },
      },
    },
  };
}
