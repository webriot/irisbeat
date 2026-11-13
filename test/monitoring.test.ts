// SPDX-License-Identifier: AGPL-3.0-only
import worker from "../src/index";
import { setupNetwork } from "@msw/cloudflare";
import { http, HttpResponse } from "msw";
import { env, exports } from "cloudflare:workers";
import {
  createScheduledController,
  evictDurableObject,
  reset,
} from "cloudflare:test";
import { beforeAll, afterAll, afterEach, expect, it, vi } from "vitest";

const network = setupNetwork();
beforeAll(() => network.enable());
afterEach(async () => {
  vi.restoreAllMocks();
  network.resetHandlers();
  await reset();
});
afterAll(() => network.disable());
const start = Date.UTC(2026, 10, 13);
async function tick(offset: number) {
  await worker.scheduled(
    createScheduledController({
      scheduledTime: start + offset,
      cron: "* * * * *",
    }),
    env,
  );
}
async function configure() {
  return request("/api/operator", {
    method: "PUT",
    headers: { authorization, "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
}
async function status(): Promise<import("../src/index").Status> {
  return (await request("/api/status")).json();
}

const authorization = "Bearer test-installation-secret";
const config = {
  pageName: "Example status",
  name: "Website",
  url: "https://target.example/health",
};
const request = (path: string, init?: RequestInit) =>
  exports.default.fetch(`https://irisbeat.example${path}`, init);

it("protects operator configuration and persists it without exposing credentials publicly", async () => {
  expect((await request("/api/operator")).status).toBe(401);
  expect(
    (
      await request("/api/operator", {
        method: "PUT",
        body: JSON.stringify(config),
      })
    ).status,
  ).toBe(401);
  const saved = await request("/api/operator", {
    method: "PUT",
    headers: { authorization, "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  expect(saved.status).toBe(200);
  expect(
    await (
      await request("/api/operator", { headers: { authorization } })
    ).json(),
  ).toMatchObject({
    pageName: "Example status",
    monitor: { name: "Website", url: config.url, state: "unknown" },
    incidents: [],
  });
  const publicResponse = await request("/api/status");
  const publicText = await publicResponse.text();
  expect(JSON.parse(publicText)).toMatchObject({
    pageName: "Example status",
    monitor: { name: "Website", state: "unknown" },
  });
  expect(publicText).not.toContain(config.url);
  expect(publicText).not.toContain(env.INSTALLATION_SECRET);
});

it("opens on two observed failures, skips missing executions, and recovers on two 2xx results", async () => {
  await configure();
  network.use(
    http.get(config.url, () => new HttpResponse(null, { status: 503 })),
  );
  await tick(0);
  expect(await status()).toMatchObject({
    monitor: {
      state: "unknown",
      lastResult: { outcome: "failure", at: start },
    },
    incidents: [],
  });
  await tick(59_000);
  expect(await status()).toMatchObject({ incidents: [] });
  // No dispatch for nine minutes: the gap creates no observations.
  expect(await status()).toMatchObject({
    monitor: { lastResult: { at: start } },
    incidents: [],
  });
  await tick(600_000);
  const incident = {
    monitorId: "website",
    openedAt: start + 600_000,
    closedAt: null,
  };
  expect(await status()).toMatchObject({
    monitor: { state: "down" },
    incidents: [incident],
  });
  await evictDurableObject(env.MONITORING.getByName("personal"));
  expect(await status()).toMatchObject({
    pageName: config.pageName,
    monitor: { state: "down" },
    incidents: [incident],
  });
  await tick(660_000);
  expect((await status()).incidents).toHaveLength(1);
  network.use(
    http.get(config.url, () => new HttpResponse(null, { status: 204 })),
  );
  await tick(720_000);
  expect(await status()).toMatchObject({
    monitor: { state: "down" },
    incidents: [incident],
  });
  await tick(780_000);
  expect(await status()).toMatchObject({
    monitor: { state: "up", lastResult: { outcome: "success" } },
    incidents: [{ ...incident, closedAt: start + 780_000 }],
  });
  expect(
    await (
      await request("/api/operator", { headers: { authorization } })
    ).json(),
  ).toMatchObject(await status());
});

it("renders accessible operator controls and escapes public configuration and Incident times", async () => {
  const operator = await (await request("/operator")).text();
  expect(operator).toContain('type="password"');
  expect(operator).toContain('for="pageName"');
  expect(operator).toContain('for="url"');
  expect(operator).not.toContain(env.INSTALLATION_SECRET);
  expect(await (await request("/")).text()).toContain("No Monitor configured");
  await request("/api/operator", {
    method: "PUT",
    headers: { authorization, "Content-Type": "application/json" },
    body: JSON.stringify({ ...config, pageName: "<script>alert(1)</script>" }),
  });
  network.use(
    http.get(config.url, () => new HttpResponse(null, { status: 500 })),
  );
  await tick(0);
  await tick(60_000);
  const page = await request("/");
  expect(page.headers.get("Content-Type")).toContain("text/html");
  const html = await page.text();
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(html).not.toContain("<script>alert(1)</script>");
  expect(html).toContain("Unavailable");
  expect(html).toContain("2026-11-13T00:01:00.000Z");
  expect(html).not.toContain(config.url);
});

it("records a failed observation when the ten-second GET deadline aborts the target", async () => {
  await configure();
  const deadlines: number[] = [];
  const realTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(
    (callback, milliseconds, ...args) => {
      if (milliseconds === 10_000) {
        deadlines.push(milliseconds);
        return realTimeout(callback, 0, ...args);
      }
      return realTimeout(callback, milliseconds, ...args);
    },
  );
  let aborted = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            aborted++;
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      }),
  );
  await tick(0);
  expect(deadlines).toEqual([10_000]);
  expect(aborted).toBe(1);
  expect(await status()).toMatchObject({
    monitor: { lastResult: { at: start, outcome: "failure" } },
    incidents: [],
  });
  vi.restoreAllMocks();
  network.use(http.get(config.url, () => HttpResponse.error()));
  await tick(60_000);
  expect(await status()).toMatchObject({
    monitor: { state: "down" },
    incidents: [{ openedAt: start + 60_000 }],
  });
});

it("rejects invalid configuration without replacing the saved target, and bounds streaming bodies", async () => {
  await configure();
  for (const value of [
    null,
    {},
    { ...config, url: "ftp://target.example" },
    { ...config, url: "https://user:pass@target.example" },
    { ...config, name: " " },
  ]) {
    expect(
      (
        await request("/api/operator", {
          method: "PUT",
          headers: { authorization, "Content-Type": "application/json" },
          body: JSON.stringify(value),
        })
      ).status,
    ).toBe(400);
  }
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          JSON.stringify({ ...config, pageName: "x".repeat(5000) }),
        ),
      );
      controller.close();
    },
  });
  expect(
    (
      await request("/api/operator", {
        method: "PUT",
        headers: { authorization, "Content-Type": "application/json" },
        body,
      })
    ).status,
  ).toBe(413);
  expect(
    await (
      await request("/api/operator", { headers: { authorization } })
    ).json(),
  ).toMatchObject({ pageName: config.pageName, monitor: { url: config.url } });
  expect(
    (
      await request("/api/operator", {
        headers: { authorization: "Bearer wrong" },
      })
    ).status,
  ).toBe(401);
  expect((await request("/api/status")).headers.get("Cache-Control")).toBe(
    "no-store",
  );
});

it("resets consecutive streaks and accepts HTTP 299 without replaying duplicate cron deliveries", async () => {
  await request("/api/operator", {
    method: "PUT",
    headers: { authorization, "Content-Type": "application/json" },
    body: JSON.stringify({ ...config, url: "http://target.example/health" }),
  });
  const outcomes = [500, 299, 500, 500, 299, 502, 299, 299];
  let attempts = 0;
  network.use(
    http.get(
      "http://target.example/health",
      () => new HttpResponse(null, { status: outcomes[attempts++] }),
    ),
  );
  await tick(0);
  await tick(0);
  expect(attempts).toBe(1);
  await tick(60_000);
  expect(await status()).toMatchObject({
    monitor: { state: "up" },
    incidents: [],
  });
  await tick(120_000);
  expect(await status()).toMatchObject({
    monitor: { state: "up" },
    incidents: [],
  });
  await tick(180_000);
  await tick(240_000);
  await tick(300_000);
  await tick(360_000);
  expect(await status()).toMatchObject({
    monitor: { state: "down" },
    incidents: [{ openedAt: start + 180_000, closedAt: null }],
  });
  await tick(420_000);
  await tick(360_000);
  expect(attempts).toBe(8);
  expect(await status()).toMatchObject({
    monitor: { state: "up" },
    incidents: [{ openedAt: start + 180_000, closedAt: start + 420_000 }],
  });
});
