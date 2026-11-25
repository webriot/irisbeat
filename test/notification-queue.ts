// SPDX-License-Identifier: AGPL-3.0-only
import { exports } from "cloudflare:workers";
import { expect } from "vitest";
import type { NotificationJob, NotificationQueueJob } from "../src";

const queue = "https://irisbeat.example/__test-notification-queue";

export async function captureNotifications(unavailable = false) {
  await exports.default.fetch(queue + (unavailable ? "?unavailable" : ""), { method: "DELETE" });
  return {
    jobs: async <Job extends NotificationQueueJob = NotificationJob>() => (await exports.default.fetch(queue)).json<Job[]>(),
    async summaries() {
      return (await this.jobs()).filter(({ event }) => event.kind.startsWith("incident.")).map(({ event }) =>
        event.monitorName.replace(/\s+/g, " ") + ": Incident " + event.kind.split(".")[1]);
    },
  };
}

export async function selectWebhooks(request: (path: string, method: string, body?: unknown) => Promise<Response>) {
  const snapshot = await (await request("/api/operator", "GET")).json<import("../src").Status>();
  const destinationIds = snapshot.destinations!.map(destination => destination.id);
  expect(destinationIds.length).toBeGreaterThan(0);
  for (const monitor of snapshot.monitors) {
    expect((await request("/api/operator/monitors/" + monitor.id, "PATCH", { destinationIds })).status).toBe(200);
  }
}
