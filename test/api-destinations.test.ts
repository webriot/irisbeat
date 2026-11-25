// SPDX-License-Identifier: AGPL-3.0-only
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import worker, { createHostedWorker, type EngineEnv, type NotificationDestination, type Status } from "../src/index";
import { captureNotifications } from "./notification-queue";

const installation = "test-installation-secret";
const destinations = "/api/v1/destinations";
const operatorDestinations = "/api/operator/destinations";
const monitors = "/api/operator/monitors";

function request(path: string, method = "GET", body?: unknown, token: string | null = installation, bindings: EngineEnv = env, app = worker) {
  return app.fetch(new Request("https://irisbeat.example" + path, {
    method,
    headers: { ...(token === null ? {} : { authorization: "Bearer " + token }), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), bindings);
}

async function resource(response: Promise<Response>, expected = 200) {
  const result = await response;
  expect(result.status).toBe(expected);
  expect(result.headers.get("Cache-Control")).toBe("no-store");
  return result.json<NotificationDestination>();
}

afterEach(async () => { await reset(); });

it("creates a webhook and returns its exact saved resource", async () => {
  const created = await resource(request(destinations, "POST", {
    channel: "webhook", name: " Ops ", url: "https://discord.com/api/v10/webhooks/123/token?wait=true",
  }), 201);
  expect(created).toEqual({
    id: expect.any(String), name: "Ops", channel: "webhook",
    url: "https://discord.com/api/v10/webhooks/123/token/slack?wait=true",
  });
});

it("reads Operator edits and preserves assignments until address replacement or deletion", async () => {
  const created = await resource(request(destinations, "POST", { url: "https://hooks.example/secret" }), 201);
  const path = destinations + "/" + created.id;
  expect(await resource(request(path))).toEqual(created);

  const independent = await request(operatorDestinations + "/" + created.id, "PUT", { name: "Operator name" });
  expect(independent.status).toBe(200);
  expect(await resource(request(path))).toEqual({ ...created, name: "Operator name" });

  const monitor = await request(monitors, "POST", { kind: "heartbeat", name: "Producer" });
  expect(monitor.status).toBe(201);
  const monitorPath = monitors + "/" + (await monitor.json<Status>()).monitor!.id;
  const assign = async (id: string) => {
    expect((await request(monitorPath, "PATCH", { destinationIds: [id] })).status).toBe(200);
  };
  const selections = async () => (await (await request("/api/operator")).json<Status>()).monitor!.destinationIds;
  await assign(created.id);
  expect(await resource(request(path, "PATCH", { name: "Renamed" }))).toEqual({ ...created, name: "Renamed" });
  expect(await resource(request(path, "PATCH", { url: "https://hooks.example/secret" }))).toEqual({ ...created, name: "Renamed" });
  expect(await selections()).toEqual([created.id]);

  const replacement = await resource(request(path, "PATCH", { url: "https://hooks.example/new-secret" }));
  expect(replacement).toEqual({ id: expect.any(String), channel: "webhook", name: "Renamed", url: "https://hooks.example/new-secret" });
  expect(replacement.id).not.toBe(created.id);
  const replacementPath = destinations + "/" + replacement.id;
  expect(await resource(request(replacementPath))).toEqual(replacement);
  expect(await selections()).toEqual([]);
  expect((await request(path)).status).toBe(404);
  expect((await request(path, "PATCH", { name: "Missing" })).status).toBe(404);

  await assign(replacement.id);
  const removed = await request(replacementPath, "DELETE");
  expect(removed.status).toBe(204);
  expect(await removed.text()).toBe("");
  expect(await selections()).toEqual([]);
  expect((await request(replacementPath)).status).toBe(404);
  expect((await request(replacementPath, "DELETE")).status).toBe(404);
});

it("keeps email destinations pending until recipient consent and requires fresh consent on replacement", async () => {
  const notifications = await captureNotifications();
  const email = { channel: "email", address: "Ops@EXAMPLE.COM", confirmed: true };
  expect((await request(destinations, "POST", email)).status).toBe(503);
  const bindings = {
    ...env, NOTIFICATION_PUBLIC_ORIGIN: "https://irisbeat.example",
    NOTIFICATION_EMAIL: { async isConfigured() { return true; } },
  };
  const pending = await resource(request(destinations, "POST", email, installation, bindings), 201);
  expect(pending).toEqual({
    id: expect.any(String), name: "Email 1", channel: "email", address: "Ops@example.com", confirmed: false,
  });
  const path = destinations + "/" + pending.id;
  expect(await resource(request(path))).toEqual(pending);
  const monitor = await request(monitors, "POST", { kind: "heartbeat", name: "Producer" });
  const monitorPath = monitors + "/" + (await monitor.json<Status>()).monitor!.id;
  expect((await request(monitorPath, "PATCH", { destinationIds: [pending.id] })).status).toBe(400);

  const [job] = await notifications.confirmationJobs();
  expect(job).toMatchObject({ kind: "email.confirmation", destinationId: pending.id });
  // Resolve the link at the same engine boundary used by the delivery Worker.
  const message = await env.MONITORING.get(env.MONITORING.idFromString(job.contextId)).resolveConfirmation(job);
  expect(message?.address).toBe("Ops@example.com");
  const confirmation = new URL(message!.url);
  const consent = await worker.fetch(new Request(confirmation.origin + confirmation.pathname, {
    method: "POST", body: new URLSearchParams({ token: confirmation.hash.slice(1) }),
  }), bindings);
  expect(consent.status).toBe(200);
  expect(await resource(request(path))).toEqual({ ...pending, confirmed: true });
  expect((await request(monitorPath, "PATCH", { destinationIds: [pending.id] })).status).toBe(200);

  const replacement = await resource(request(path, "PATCH", { channel: "email", address: "New@example.com" }, installation, bindings));
  expect(replacement).toEqual({ ...pending, id: expect.any(String), address: "New@example.com" });
  expect(replacement.id).not.toBe(pending.id);
  expect((await request(path)).status).toBe(404);
  const snapshot = await (await request("/api/operator")).json<Status>();
  expect(snapshot.monitor!.destinationIds).toEqual([]);
  expect(await notifications.confirmationJobs()).toMatchObject([job, { kind: "email.confirmation", destinationId: replacement.id }]);
  const replacementPath = destinations + "/" + replacement.id;
  expect((await request(replacementPath, "DELETE")).status).toBe(204);
  expect((await request(replacementPath)).status).toBe(404);
});

it("requires Write authority on every destination method and keeps versioned routes self-hosted", async () => {
  const keys = "/api/operator/api-keys";
  async function issue(role: "read" | "write") {
    const issued = await request(keys, "POST", { name: role, role });
    expect(issued.status).toBe(201);
    return issued.json<{ key: { id: string }; secret: string }>();
  }
  const read = await issue("read");
  const write = await issue("write");
  const value = { url: "https://hooks.example/write-key" };
  const created = await resource(request(destinations, "POST", value, write.secret), 201);
  const path = destinations + "/" + created.id;
  const operations = [
    [destinations, "POST", value],
    [path, "GET"],
    [path, "PATCH", { name: "Write key" }],
    [path, "DELETE"],
  ] as const;
  const hosted = createHostedWorker({
    contractVersion: "1",
    resolve: () => ({ id: "hosted", permission: "editor", monitorLimit: 1 }),
    contexts: () => ["hosted"],
  });
  for (const [endpoint, method, body] of operations) {
    const anonymous = await request(endpoint, method, body, null);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("WWW-Authenticate")).toBe("Bearer");
    const denied = await request(endpoint, method, body, read.secret);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "Forbidden" });
    expect((await request(endpoint, method, body, installation, env, hosted)).status).toBe(404);
  }
  expect((await request(destinations, "POST", null, read.secret)).status).toBe(403);
  expect((await request(operatorDestinations, "GET", undefined, installation, env, hosted)).status).toBe(200);
  expect((await request(operatorDestinations, "GET", undefined, write.secret)).status).toBe(401);
  expect(await resource(request(path, "GET", undefined, write.secret))).toEqual(created);
  expect(await resource(request(path, "PATCH", { name: "Write key" }, write.secret)))
    .toEqual({ ...created, name: "Write key" });
  expect((await request(path, "DELETE", undefined, write.secret)).status).toBe(204);
  expect((await request(keys + "/" + write.key.id, "DELETE")).status).toBe(204);
  expect((await request(destinations, "POST", value, write.secret)).status).toBe(401);
});

it("rejects invalid destination edits without changing the saved configuration", async () => {
  const created = await resource(request(destinations, "POST", { name: "Ops", url: "https://hooks.example/ops" }), 201);
  const path = destinations + "/" + created.id;
  const duplicate = await request(destinations, "POST", { name: "ops", url: "https://hooks.example/other" });
  expect(duplicate.status).toBe(409);
  for (const body of [{}, { name: " " }, { name: "Discard", url: "http://hooks.example" }, { channel: "email" }]) {
    expect((await request(path, "PATCH", body)).status).toBe(400);
  }
  const collection = await request(destinations);
  expect(collection.status).toBe(405);
  expect(collection.headers.get("Allow")).toBe("POST");
  const head = await request(path, "HEAD");
  expect(head.status).toBe(405);
  expect(head.headers.get("Allow")).toBe("GET, PATCH, DELETE");
  expect(await resource(request(path))).toEqual(created);
});
