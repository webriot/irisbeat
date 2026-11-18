// SPDX-License-Identifier: AGPL-3.0-only
import { env } from "cloudflare:workers";
import { evictDurableObject, reset } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
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
  const replaced = await status(api(destinations + "/" + discord.id, "PUT", { url: "https://hooks.example/new" }));
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
});
