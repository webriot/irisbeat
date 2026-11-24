// SPDX-License-Identifier: AGPL-3.0-only
import { env } from "cloudflare:workers";
import { createScheduledController, evictDurableObject, reset } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { captureNotifications } from "./notification-queue";
import worker, { createHostedWorker, type Status } from "../src/index";

const hosted = createHostedWorker({
  contractVersion: "1",
  resolve: request => ({
    id: new URL(request.url).hostname,
    permission: request.headers.get("authorization") === "Bearer editor" ? "editor" : "reader",
    monitorLimit: 5,
  }),
  contexts: () => [],
});

function api(path: string, method = "GET", value?: unknown, host = "personal.example", token = host === "personal.example" ? "test-installation-secret" : "editor") {
  return (host === "personal.example" ? worker : hosted).fetch(new Request("https://" + host + path, {
    method, headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  }), env);
}

async function status(response: Promise<Response>, expected = 200) {
  const result = await response;
  expect(result.status).toBe(expected);
  return result.json<Status>();
}

const destinations = "/api/operator/destinations";
const monitors = "/api/operator/monitors";
afterEach(async () => { await reset(); });

it("validates names and keeps them across restarts and older address replacements", async () => {
  const url = "https://hooks.example/alerts";
  for (const name of [" ", "a".repeat(121), "Ops\nAlerts", null]) {
    expect((await api(destinations, "POST", { url, name })).status).toBe(400);
  }
  const [named] = (await status(api(destinations, "POST", { url, name: "  WEBHOOK 1  " }), 201)).destinations!;
  expect(named).toMatchObject({ name: "WEBHOOK 1" });
  expect((await api(destinations, "POST", { url, name: "webhook 1" })).status).toBe(409);
  const [, generated] = (await status(api(destinations, "POST", { url }), 201)).destinations!;
  expect(generated).toMatchObject({ name: "Webhook 2" });
  expect((await api(destinations + "/" + generated.id, "PUT", { url, name: "webhook 1" })).status).toBe(409);
  await evictDurableObject(env.MONITORING.getByName("personal"));
  expect((await status(api(destinations))).destinations).toEqual([named, generated]);
  const replacement = (await status(api(destinations + "/" + generated.id, "PUT", { url: url + "/new" }))).destinations![1];
  expect(replacement).toMatchObject({ name: "Webhook 2", url: url + "/new" });
  expect(replacement.id).not.toBe(generated.id);
  expect((await api(destinations, "POST", { url, name: "σ alerts" })).status).toBe(201);
  expect((await api(destinations, "POST", { url, name: "ς ALERTS" })).status).toBe(409);
});

it("accepts long webhook URLs with names and can rename without resubmitting the address", async () => {
  const url = "https://hooks.example/" + "é".repeat(1950);
  const name = "運".repeat(120);
  const [webhook] = (await status(api(destinations, "POST", { url, name }), 201)).destinations!;
  expect(webhook).toMatchObject({ name, url });

  const discord = "https://discord.com/api/webhooks/123/";
  const longDiscordUrl = discord.padEnd(2048, "x");
  const [, saved] = (await status(api(destinations, "POST", { url: longDiscordUrl }), 201)).destinations!;
  expect(saved).toMatchObject({ url: longDiscordUrl + "/slack" });
  const renamed = await status(api(destinations + "/" + saved.id, "PUT", { name: "Discord" }));
  expect(renamed.destinations![1]).toMatchObject({ id: saved.id, url: longDiscordUrl + "/slack", name: "Discord" });
});

it("stores explicit Monitor selections and clears them on address replacement or removal", async () => {
  const created = await status(api(monitors, "POST", { kind: "heartbeat", name: "Producer" }), 201);
  const monitor = monitors + "/" + created.monitor!.id;
  expect(created.monitor!.destinationIds).toEqual([]);
  const saved = await status(api(destinations, "POST", { url: "https://discord.com/api/v10/webhooks/123/token?wait=true" }), 201);
  const [discord] = saved.destinations!;
  expect(discord).toMatchObject({ channel: "webhook", url: "https://discord.com/api/v10/webhooks/123/token/slack?wait=true" });
  const slackUrl = "https://hooks.slack.com/services/T/B/secret";
  const [_, slack] = (await status(api(destinations, "POST", { url: slackUrl }), 201)).destinations!;
  const selections = [discord.id, slack.id];
  await status(api(monitor, "PATCH", { destinationIds: selections }));
  expect((await api(monitor, "PATCH", { name: "Rejected", destinationIds: ["missing"] })).status).toBe(400);
  await evictDurableObject(env.MONITORING.getByName("personal"));
  expect((await status(api(destinations))).monitor).toMatchObject({ name: "Producer", destinationIds: selections });
  const renamed = await status(api(destinations + "/" + discord.id, "PUT", { url: discord.channel === "webhook" && discord.url, name: "Discord" }));
  expect(renamed.destinations![0]).toMatchObject({ id: discord.id, name: "Discord" });
  expect(renamed.monitor!.destinationIds).toEqual(selections);
  const replaced = await status(api(destinations + "/" + discord.id, "PUT", { url: "https://hooks.example/new", name: "New webhook" }));
  expect(replaced.destinations![0]).toMatchObject({ name: "New webhook" });
  expect(replaced.destinations!.map(item => item.id)).not.toContain(discord.id);
  expect(replaced.monitor!.destinationIds).toEqual([slack.id]);
  const removed = await status(api(destinations + "/" + slack.id, "DELETE"));
  expect(removed.monitor!.destinationIds).toEqual([]);
  for (const path of ["/api/status", "/", "/operator", "/operator.js"]) {
    expect(await (await api(path)).text()).not.toMatch(/hooks\.example\/new|hooks\.slack\.com/);
  }
});

it("limits destinations and selections to editors of their own context", async () => {
  const url = "https://hooks.example/tenant-secret";
  expect((await api(destinations, "GET", undefined, "personal.example", "")).status).toBe(401);
  const [destination] = (await status(api(destinations, "POST", { url }, "a.example"), 201)).destinations!;
  const reader = await api(destinations, "GET", undefined, "a.example", "reader");
  expect(reader.status).toBe(200);
  expect(await reader.text()).not.toMatch(/tenant-secret|destinations/);
  expect((await api(destinations, "POST", { url }, "a.example", "reader")).status).toBe(403);
  expect((await api(destinations + "/" + destination.id, "DELETE", undefined, "b.example")).status).toBe(404);
  const b = await status(api(monitors, "POST", { name: "Other", kind: "heartbeat" }, "b.example"), 201);
  const monitor = monitors + "/" + b.monitor!.id;
  expect((await api(monitor, "PATCH", { destinationIds: [destination.id] }, "b.example")).status).toBe(400);
  expect((await api(monitor, "PATCH", { destinationIds: [] }, "b.example", "reader")).status).toBe(403);
  expect((await api(monitor, "PATCH", { destinationChanges: { [destination.id]: true } }, "b.example")).status).toBe(400);
  expect((await api(monitor, "PATCH", { destinationChanges: { [destination.id]: false } }, "b.example", "reader")).status).toBe(403);
});

it("applies individual destination changes atomically and rejects invalid selections", async () => {
  const [first] = (await status(api(destinations, "POST", { url: "https://hooks.example/first" }), 201)).destinations!;
  const [_, second] = (await status(api(destinations, "POST", { url: "https://hooks.example/second" }), 201)).destinations!;
  expect((await api(monitors, "POST", { name: "Producer", kind: "heartbeat", destinationChanges: { [first.id]: true } })).status).toBe(400);
  const { monitor } = await status(api(monitors, "POST", { name: "Producer", kind: "heartbeat" }), 201);
  const path = monitors + "/" + monitor!.id;
  await status(api(path, "PATCH", { destinationIds: [first.id] }));
  for (const invalid of [
    { destinationChanges: { missing: true, [first.id]: false } },
    { destinationChanges: { [second.id]: "true" } },
    { destinationChanges: [second.id] },
    { destinationChanges: { [second.id]: true }, destinationIds: [] },
  ]) {
    expect((await api(path, "PATCH", { name: "Rejected", ...invalid })).status).toBe(400);
  }
  expect((await status(api(destinations))).monitor).toMatchObject({ name: "Producer", destinationIds: [first.id] });
  const added = await status(api(path, "PATCH", { destinationChanges: { [second.id]: true } }));
  expect(added.monitor!.destinationIds).toEqual([first.id, second.id]);
  const removed = await status(api(path, "PATCH", { destinationChanges: { [first.id]: false, missing: false } }));
  expect(removed.monitor!.destinationIds).toEqual([second.id]);
});

it("keeps an Incident committed when Queue acceptance fails and never replays it", async () => {
  const start = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(start);
  const openedAt = start + 180_000;
  const created = await status(api(monitors, "POST", { kind: "heartbeat", name: "Producer", recoveryThreshold: 1 }), 201);
  const id = created.monitor!.id;
  const { destinations: saved } = await status(api(destinations, "POST", { url: "https://hooks.example/private-token" }), 201);
  await status(api(monitors + "/" + id, "PATCH", { destinationIds: [saved![0].id] }));
  const notifications = await captureNotifications(true);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await worker.scheduled(createScheduledController({ scheduledTime: openedAt }), env);
    const [incident] = (await status(api("/api/operator"))).incidents;
    expect(incident).toMatchObject({ monitorId: id, openedAt, closedAt: null });
    expect(log.mock.calls).toEqual([[JSON.stringify({ event: "notification_enqueue_failed", eventId: incident.id + ":opened" })]]);
    expect(await notifications.jobs()).toEqual([]);

    await captureNotifications();
    await evictDurableObject(env.MONITORING.getByName("personal"));
    await worker.scheduled(createScheduledController({ scheduledTime: openedAt + 60_000 }), env);
    expect((await status(api("/api/operator"))).incidents).toEqual([incident]);
    expect(await notifications.jobs()).toEqual([]);
    clock.mockReturnValue(openedAt + 120_000);
    expect((await api("/heartbeat/" + id, "POST")).status).toBe(204);
    expect(await notifications.jobs()).toMatchObject([{ event: { kind: "incident.recovered", incidentId: incident.id } }]);
  } finally {
    clock.mockRestore();
    log.mockRestore();
    await captureNotifications();
  }
});
