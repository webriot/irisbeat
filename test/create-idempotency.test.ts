// SPDX-License-Identifier: AGPL-3.0-only
import { env, exports } from "cloudflare:workers";
import { evictDurableObject, reset } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import worker, { type EngineEnv, type Status } from "../src/index";
import { captureNotifications } from "./notification-queue";

const installation = "test-installation-secret";
const monitors = "/api/v1/monitors";
const destinations = "/api/v1/destinations";
const monitor = { kind: "heartbeat", name: "Nightly job" };

function request(path: string, method = "GET", body?: unknown, key?: string, token: string | null = installation, bindings: EngineEnv = env) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token !== null) headers.set("Authorization", `Bearer ${token}`);
  if (key !== undefined) headers.set("Idempotency-Key", key);
  return worker.fetch(new Request("https://irisbeat.example" + path, { method, headers, body: JSON.stringify(body) }), bindings);
}

async function receipt(response: Response) {
  expect(response.status).toBe(201);
  return { body: await response.text(), headers: [...response.headers] };
}

afterEach(async () => { vi.restoreAllMocks(); await reset(); });

it("recovers the original Monitor response after eviction and an independent edit", async () => {
  const original = await receipt(await request(monitors, "POST", monitor, "monitor-create"));
  const { id } = JSON.parse(original.body);
  expect(original.headers).toContainEqual(["location", `${monitors}/${id}`]);
  expect((await request(`${monitors}/${id}`, "PATCH", { name: "Edited" })).status).toBe(200);
  await evictDurableObject(env.MONITORING.getByName("personal"));

  expect(await receipt(await request(monitors, "POST", monitor, "monitor-create"))).toEqual(original);
  expect(await (await request(`${monitors}/${id}`)).json()).toMatchObject({ id, name: "Edited" });
  expect(await (await request("/api/v1/status")).json()).toMatchObject({ monitors: [{ id, name: "Edited" }] });
});

it("recovers the original pending email destination after consent without another confirmation job", async () => {
  const notifications = await captureNotifications();
  const bindings = {
    ...env, NOTIFICATION_PUBLIC_ORIGIN: "https://irisbeat.example",
    NOTIFICATION_EMAIL: { async isConfigured() { return true; } },
  };
  const email = { channel: "email", address: "Ops@example.com" };
  const original = await receipt(await request(destinations, "POST", email, "email-create", installation, bindings));
  const pending = JSON.parse(original.body);
  expect(pending.confirmed).toBe(false);
  const [job] = await notifications.confirmationJobs();
  const message = await env.MONITORING.getByName("personal").resolveConfirmation(job);
  const confirmation = new URL(message!.url);
  expect((await worker.fetch(new Request(confirmation.origin + confirmation.pathname, {
    method: "POST", body: new URLSearchParams({ token: confirmation.hash.slice(1) }),
  }), bindings)).status).toBe(200);
  await evictDurableObject(env.MONITORING.getByName("personal"));

  // Email capability is unavailable for this retry.
  expect(await receipt(await request(destinations, "POST", email, "email-create"))).toEqual(original);
  expect(await (await request(`${destinations}/${pending.id}`)).json()).toEqual({ ...pending, confirmed: true });
  expect(await notifications.confirmationJobs()).toEqual([job]);
});

const webhook = { url: "https://hooks.example/alerts" };
const calendarMonitor = {
  ...monitor, scheduleMode: "calendar", cron: "0 3 * * *", timezone: "UTC", graceSeconds: 120,
};
const cases = [
  { endpoint: monitors, body: calendarMonitor, changed: { ...calendarMonitor, name: "Changed" }, collection: "monitors" },
  { endpoint: destinations, body: webhook, changed: { url: "https://hooks.example/changed" }, collection: "destinations" },
] as const;
const snapshot = async () => (await request("/api/operator")).json<Status>();

it.each(cases)("$endpoint creates once under concurrent retries and rejects a different body", async ({ endpoint, body, changed, collection }) => {
  const results = await Promise.all(Array.from({ length: 4 }, () =>
    request(endpoint, "POST", body, "concurrent").then(receipt)));
  const first = results[0];
  for (const result of results) expect(result).toEqual(first);
  const conflict = await request(endpoint, "POST", changed, "concurrent");
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toEqual({ error: "Idempotency-Key was already used for a different request" });
  expect((await snapshot())[collection]).toMatchObject([{ id: JSON.parse(first.body).id }]);
});

it.each(cases)("$endpoint expires at the original commit time even after replay", async ({ endpoint, body, changed, collection }) => {
  const start = Date.UTC(2026, 10, 25);
  const day = 86_400_000;
  const clock = vi.spyOn(Date, "now").mockReturnValue(start);
  const original = await receipt(await request(endpoint, "POST", body, "expires"));
  clock.mockReturnValue(start + day - 1);
  expect(await receipt(await request(endpoint, "POST", body, "expires"))).toEqual(original);
  expect((await request(endpoint, "POST", changed, "expires")).status).toBe(409);

  clock.mockReturnValue(start + day);
  const replacement = await receipt(await request(endpoint, "POST", body, "expires"));
  const oldId = JSON.parse(original.body).id;
  const newId = JSON.parse(replacement.body).id;
  expect(newId).not.toBe(oldId);
  expect((await snapshot())[collection]?.map(({ id }) => id)).toEqual([oldId, newId]);
  expect(await receipt(await request(endpoint, "POST", body, "expires"))).toEqual(replacement);
});

it.each(cases)("$endpoint requires current Write access before replay and survives credential rotation", async ({ endpoint, body, changed }) => {
  const keys = "/api/operator/api-keys";
  async function issue(role: "read" | "write") {
    const response = await request(keys, "POST", { name: role, role });
    expect(response.status).toBe(201);
    return response.json<{ key: { id: string }; secret: string }>();
  }
  const originalKey = await issue("write");
  const original = await receipt(await request(endpoint, "POST", body, "rotate", originalKey.secret));
  const replacementKey = await issue("write");
  const readKey = await issue("read");
  expect((await request(`${keys}/${originalKey.key.id}`, "DELETE")).status).toBe(204);

  for (const supplied of [body, changed]) {
    for (const denied of [null, "invalid", originalKey.secret]) {
      const response = await request(endpoint, "POST", supplied, "rotate", denied);
      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    }
    expect((await request(endpoint, "POST", supplied, "rotate", readKey.secret)).status).toBe(403);
  }
  expect(await receipt(await request(endpoint, "POST", body, "rotate", replacementKey.secret))).toEqual(original);
});

it.each(cases)("$endpoint rejects invalid keys and only remembers successful creates", async ({ endpoint, body, collection }) => {
  for (const key of ["", "a b", "one,two", "é", "a".repeat(129)]) {
    const response = await request(endpoint, "POST", body, key);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid Idempotency-Key" });
  }
  const key = "a".repeat(128);
  expect((await request(endpoint, "POST", {}, key)).status).toBe(400);
  const result = await receipt(await request(endpoint, "POST", body, key));
  expect((await snapshot())[collection]).toMatchObject([{ id: JSON.parse(result.body).id }]);
});

it("keeps the original assignment in the Monitor receipt after deleting the destination", async () => {
  const first = await receipt(await request(destinations, "POST", webhook, "shared-key"));
  const destinationId = JSON.parse(first.body).id;
  const assigned = { ...monitor, destinationIds: [destinationId] };
  const second = await receipt(await request(monitors, "POST", assigned, "shared-key"));
  const id = JSON.parse(second.body).id;
  expect(JSON.parse(second.body).destinationIds).toEqual([destinationId]);

  expect((await request(`${destinations}/${destinationId}`, "DELETE")).status).toBe(204);
  expect(await receipt(await request(destinations, "POST", webhook, "shared-key"))).toEqual(first);
  expect((await request(`${destinations}/${destinationId}`)).status).toBe(404);
  expect(await receipt(await request(monitors, "POST", assigned, "shared-key"))).toEqual(second);
  expect(await (await request(`${monitors}/${id}`)).json()).toMatchObject({ destinationIds: [] });
  expect((await request(monitors, "POST", { destinationIds: [destinationId], ...monitor }, "shared-key")).status).toBe(409);
});

it.each(cases)("$endpoint recovers a committed create when response generation fails", async ({ endpoint, body, collection }) => {
  const fixture = "https://irisbeat.example/__test-history?mode=";
  await exports.default.fetch(fixture + "interrupt-observation");
  try {
    expect((await request(endpoint, "POST", body, "missing-response")).status).toBe(500);
  } finally {
    await exports.default.fetch(fixture + "available");
  }
  const committed = (await snapshot())[collection];
  expect(committed).toHaveLength(1);
  await evictDurableObject(env.MONITORING.getByName("personal"));

  const original = await receipt(await request(endpoint, "POST", body, "missing-response"));
  expect(JSON.parse(original.body).id).toBe(committed?.[0].id);
  expect((await snapshot())[collection]).toEqual(committed);
});
