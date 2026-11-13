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
async function configure(configuration: Record<string, unknown> = config) {
  return request("/api/operator", {
    method: "PUT",
    headers: { authorization, "Content-Type": "application/json" },
    body: JSON.stringify(configuration),
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

it("defaults Monitor timing, persists edits and preserves omitted settings", async () => {
  expect(await (await configure()).json()).toMatchObject({ monitor: {
    intervalSeconds: 60, timeoutSeconds: 10, failureThreshold: 2, recoveryThreshold: 2,
  } });
  const timing = { intervalSeconds: 300, timeoutSeconds: 30, failureThreshold: 3, recoveryThreshold: 4 };
  expect(await (await configure({ ...config, ...timing })).json()).toMatchObject({ monitor: timing });
  await evictDurableObject(env.MONITORING.getByName("personal"));
  expect(await (await configure({ ...config, name: "Renamed" })).json()).toMatchObject({ monitor: timing });
});

it("rejects every invalid timing field at the HTTP boundary without changing configuration", async () => {
  const timing = { intervalSeconds: 300, timeoutSeconds: 30, failureThreshold: 3, recoveryThreshold: 4 };
  await configure({ ...config, ...timing });
  const fields = [
    ["intervalSeconds", 59, 86_401],
    ["timeoutSeconds", 0, 61],
    ["failureThreshold", 0, 101],
    ["recoveryThreshold", 0, 101],
  ] as const;
  for (const [field, below, above] of fields) {
    for (const invalid of [below, above, -1, 1.5, "60", null, true, {}, [], 1e100]) {
      const response = await configure({ ...config, ...timing, [field]: invalid });
      expect(response.status, `${field}: ${JSON.stringify(invalid)}`).toBe(400);
      expect(await (await request("/api/operator", { headers: { authorization } })).json()).toMatchObject({ monitor: timing });
    }
  }
  for (const timing of [
    { intervalSeconds: 60, timeoutSeconds: 1, failureThreshold: 1, recoveryThreshold: 1 },
    { intervalSeconds: 86_400, timeoutSeconds: 60, failureThreshold: 100, recoveryThreshold: 100 },
  ]) {
    expect(await (await configure({ ...config, ...timing })).json()).toMatchObject({ monitor: timing });
  }
});

it("reschedules later attempts from the last dispatch without replaying gaps or editing observations", async () => {
  await configure({ ...config, intervalSeconds: 300 });
  let attempts = 0;
  network.use(http.get(config.url, () => { attempts++; return new HttpResponse(null, { status: 204 }); }));
  await tick(0);
  await tick(60_000);
  expect(attempts).toBe(1);
  const observed = await status();
  await configure({ ...config, intervalSeconds: 120 });
  expect(await status()).toEqual(observed);
  await tick(119_999);
  expect(attempts).toBe(1);
  await tick(120_000);
  expect(attempts).toBe(2);
  await configure({ ...config, intervalSeconds: 600 });
  await tick(240_000);
  expect(attempts).toBe(2);
  await tick(720_000);
  await tick(720_000);
  expect(attempts).toBe(3);
  await tick(3_600_000);
  expect(attempts).toBe(4);
  expect(await status()).toMatchObject({ monitor: { lastResult: { at: start + 3_600_000, outcome: "success" } }, incidents: [] });
});

it("applies threshold edits only on later observations while preserving streaks and Incident timestamps", async () => {
  await configure({ ...config, failureThreshold: 3, recoveryThreshold: 3 });
  network.use(http.get(config.url, () => new HttpResponse(null, { status: 503 })));
  await tick(0);
  await tick(60_000);
  const observed = await status();
  expect(observed.incidents).toEqual([]);
  await configure({ ...config, failureThreshold: 1 });
  expect(await status()).toEqual(observed);
  await tick(120_000);
  const opened = await status();
  expect(opened).toMatchObject({ monitor: { state: "down" }, incidents: [{ openedAt: start + 120_000, closedAt: null }] });
  network.use(http.get(config.url, () => new HttpResponse(null, { status: 204 })));
  await tick(180_000);
  await tick(240_000);
  const recovering = await status();
  expect(recovering.monitor?.state).toBe("down");
  await configure({ ...config, recoveryThreshold: 2 });
  expect(await status()).toEqual(recovering);
  await tick(300_000);
  expect(await status()).toMatchObject({ monitor: { state: "up" }, incidents: [{ ...opened.incidents[0], closedAt: start + 300_000 }] });
  const recovered = await status();
  await configure({ ...config, failureThreshold: 100, recoveryThreshold: 100 });
  expect(await status()).toEqual(recovered);
  await evictDurableObject(env.MONITORING.getByName("personal"));
  expect(await status()).toEqual(recovered);
});

it("finishes active failure and recovery attempts with their starting thresholds and retains newer settings", async () => {
  await configure();
  network.use(http.get(config.url, () => new HttpResponse(null, { status: 503 })));
  await tick(0);
  vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
    expect((await configure({ ...config, failureThreshold: 100, intervalSeconds: 120 })).status).toBe(200);
    await tick(60_000); // An overlapping dispatch does not execute another attempt.
    return new Response(null, { status: 503 });
  });
  await tick(60_000);
  expect(await status()).toMatchObject({ monitor: { state: "down", lastResult: { at: start + 60_000 } }, incidents: [{ openedAt: start + 60_000, closedAt: null }] });
  vi.restoreAllMocks();
  network.use(http.get(config.url, () => new HttpResponse(null, { status: 204 })));
  await tick(120_000);
  expect((await status()).monitor?.lastResult?.at).toBe(start + 60_000);
  await tick(180_000);
  vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
    await configure({ ...config, recoveryThreshold: 100 });
    return new Response(null, { status: 204 });
  });
  await tick(300_000);
  const recovered = await status();
  expect(recovered).toMatchObject({ monitor: { state: "up" }, incidents: [{ openedAt: start + 60_000, closedAt: start + 300_000 }] });
  expect(await (await request("/api/operator", { headers: { authorization } })).json()).toMatchObject({ monitor: { failureThreshold: 100, recoveryThreshold: 100, intervalSeconds: 120 } });
  vi.restoreAllMocks();
  network.use(http.get(config.url, () => new HttpResponse(null, { status: 503 })));
  await tick(420_000);
  await tick(540_000);
  expect((await status()).incidents).toEqual(recovered.incidents);
});

it("uses the configured timeout snapshot while saving a different deadline for the next attempt", async () => {
  await configure({ ...config, timeoutSeconds: 5 });
  const deadlines: number[] = [];
  const realTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, milliseconds, ...args) => {
    if (milliseconds === 5000 || milliseconds === 1000) {
      deadlines.push(milliseconds);
      return realTimeout(callback, 0, ...args);
    }
    return realTimeout(callback, milliseconds, ...args);
  });
  let attempts = 0;
  let aborted = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    const pending = new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted++;
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });
    if (attempts++ === 0) await configure({ ...config, timeoutSeconds: 1 });
    return pending;
  });
  await tick(0);
  await tick(60_000);
  expect(deadlines).toEqual([5000, 1000]);
  expect(aborted).toBe(2);
  expect(await status()).toMatchObject({ monitor: { state: "down", lastResult: { at: start + 60_000, outcome: "failure" } }, incidents: [{ openedAt: start + 60_000 }] });
  expect(await (await request("/api/operator", { headers: { authorization } })).json()).toMatchObject({ monitor: { timeoutSeconds: 1 } });
});

it("serves labeled timing controls inside the existing Monitor configuration", async () => {
  const html = await (await request("/operator")).text();
  for (const [field, label, min, max, value] of [
    ["intervalSeconds", "Interval (seconds)", 60, 86400, 60],
    ["timeoutSeconds", "Timeout (seconds)", 1, 60, 10],
    ["failureThreshold", "Consecutive failures", 1, 100, 2],
    ["recoveryThreshold", "Consecutive successes", 1, 100, 2],
  ]) {
    expect(html).toContain(`<label for="${field}">${label}</label>`);
    expect(html).toContain(`<input id="${field}" name="${field}" type="number" min="${min}" max="${max}" step="1" value="${value}" required>`);
    expect(html.indexOf(`id="${field}"`)).toBeLessThan(html.indexOf('<aside aria-labelledby="page-settings">'));
  }
});
