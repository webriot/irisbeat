// SPDX-License-Identifier: AGPL-3.0-only
import { connect } from "cloudflare:sockets";
import worker from "../src/index";
import { env, exports } from "cloudflare:workers";
import { createScheduledController, evictDurableObject, reset } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("cloudflare:sockets", () => ({ connect: vi.fn() }));

const authorization = "Bearer test-installation-secret";
const config = { pageName: "Service status", name: "Database", kind: "tcp", hostname: "db.example", port: 5432 };
const request = (path: string, init?: RequestInit) => exports.default.fetch(`https://irisbeat.example${path}`, init);
const configure = (value: Record<string, unknown> = config) => request("/api/operator", {
  method: "PUT", headers: { authorization, "Content-Type": "application/json" }, body: JSON.stringify(value),
});
const status = async (): Promise<import("../src/index").Status> => (await request("/api/status")).json();
const start = Date.UTC(2026, 10, 13);
const tick = (offset: number) => worker.scheduled(createScheduledController({ scheduledTime: start + offset, cron: "* * * * *" }), env);
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

it("configures and persists a TCP Monitor with default timing without publishing its target", async () => {
  const response = await configure();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ monitor: { kind: "tcp", hostname: "db.example", port: 5432,
    intervalSeconds: 60, timeoutSeconds: 10, failureThreshold: 2, recoveryThreshold: 2 } });
  await evictDurableObject(env.MONITORING.getByName("personal"));
  const operator = await request("/api/operator", { headers: { authorization } });
  expect(await operator.json()).toMatchObject({ monitor: { kind: "tcp", hostname: "db.example", port: 5432 } });
  expect(await status()).toMatchObject({ monitor: { name: "Database", state: "unknown", lastResult: null } });
  for (const path of ["/", "/api/status"]) {
    const body = await (await request(path)).text();
    expect(body).not.toContain("db.example");
    expect(body).not.toContain("5432");
  }
});

it("observes TCP connections and closes each socket through failure and recovery thresholds", async () => {
  await configure();
  let outcome = true;
  let connections = 0;
  let closed = 0;
  vi.mocked(connect).mockImplementation(address => {
    expect(address).toEqual({ hostname: "db.example", port: 5432 });
    connections++;
    return {
      opened: outcome ? Promise.resolve({}) : Promise.reject(new Error("refused")),
      closed: Promise.resolve(),
      close: async () => { closed++; },
    } as Socket;
  });
  await tick(0);
  expect(await status()).toMatchObject({ monitor: { state: "up", lastResult: { at: start, outcome: "success" } }, incidents: [] });
  outcome = false;
  await tick(60_000);
  expect((await status()).incidents).toEqual([]);
  await tick(120_000);
  expect(await status()).toMatchObject({ monitor: { state: "down", lastResult: { outcome: "failure" } }, incidents: [{ openedAt: start + 120_000, closedAt: null }] });
  outcome = true;
  await tick(180_000);
  expect((await status()).monitor?.state).toBe("down");
  await tick(240_000);
  expect(await status()).toMatchObject({ monitor: { state: "up" }, incidents: [{ openedAt: start + 120_000, closedAt: start + 240_000 }] });
  expect(connections).toBe(5);
  expect(closed).toBe(5);
});

it("bounds a pending connection by its starting timeout, closes it and recovers on later checks", async () => {
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
  let connections = 0;
  let closed = 0;
  vi.mocked(connect).mockImplementation(() => {
    const attempt = connections++;
    return {
      opened: attempt < 2 ? (async () => {
        if (attempt === 0) await configure({ ...config, timeoutSeconds: 1 });
        return new Promise(() => {});
      })() : Promise.resolve({}),
      closed: Promise.resolve(),
      close: async () => { closed++; },
    } as Socket;
  });
  await tick(0);
  await tick(60_000);
  expect(await status()).toMatchObject({ monitor: { state: "down", lastResult: { outcome: "failure" } }, incidents: [{ openedAt: start + 60_000, closedAt: null }] });
  expect(deadlines).toEqual([5000, 1000]);
  expect(closed).toBe(2);
  await tick(120_000);
  await tick(180_000);
  expect(await status()).toMatchObject({ monitor: { state: "up" }, incidents: [{ openedAt: start + 60_000, closedAt: start + 180_000 }] });
  expect(closed).toBe(4);
});

it("rejects malformed TCP targets and timings atomically and keeps HTTP configuration compatible", async () => {
  await configure();
  const saved = await (await request("/api/operator", { headers: { authorization } })).json();
  for (const change of [
    { kind: "udp" }, { kind: null }, { hostname: "" }, { hostname: "host name" },
    { hostname: "https://db.example" }, { hostname: "db.example/path" }, { hostname: "user@db.example" },
    { hostname: "db.example:5432" }, { hostname: "db.example?query" }, { hostname: "db.example#fragment" },
    { hostname: "[::1]:80" }, { hostname: "[::1]/path" }, { hostname: "[::1] " },
    { port: "5432" }, { port: null }, { port: 0 }, { port: 65536 }, { port: 1.5 },
    { intervalSeconds: 59 }, { timeoutSeconds: 61 }, { failureThreshold: 0 }, { recoveryThreshold: 101 },
  ]) {
    expect((await configure({ ...config, ...change })).status, JSON.stringify(change)).toBe(400);
    expect(await (await request("/api/operator", { headers: { authorization } })).json()).toEqual(saved);
  }
  expect(await (await configure({ pageName: "Web", name: "Website", url: "https://web.example" })).json())
    .toMatchObject({ monitor: { kind: "http", url: "https://web.example/" } });
  expect(await (await configure()).json()).toMatchObject({ monitor: { kind: "tcp", hostname: "db.example" } });
});

it("keeps active TCP attempts on their starting target and thresholds while edits reschedule future attempts", async () => {
  await configure({ ...config, failureThreshold: 1 });
  let attempts = 0;
  vi.mocked(connect).mockImplementation(address => {
    const attempt = attempts++;
    expect(address).toEqual(attempt === 0 ? { hostname: "db.example", port: 5432 } : { hostname: "next.example", port: 1234 });
    return {
      opened: (async () => {
        if (attempt === 0) {
          await configure({ ...config, hostname: "next.example", port: 1234, intervalSeconds: 120, failureThreshold: 100 });
          await tick(0);
          throw new Error("connection failed");
        }
        if (attempt === 2) await configure({ ...config, hostname: "next.example", port: 1234, recoveryThreshold: 100 });
        return {};
      })(),
      closed: Promise.resolve(), close: async () => {},
    } as Socket;
  });
  await tick(0);
  const down = await status();
  expect(down).toMatchObject({ monitor: { state: "down" }, incidents: [{ openedAt: start, closedAt: null }] });
  await tick(60_000);
  expect(attempts).toBe(1);
  expect(await status()).toEqual(down);
  await tick(120_000);
  expect((await status()).monitor?.state).toBe("down");
  await tick(240_000);
  expect(await status()).toMatchObject({ monitor: { state: "up" }, incidents: [{ openedAt: start, closedAt: start + 240_000 }] });
  expect(await (await request("/api/operator", { headers: { authorization } })).json()).toMatchObject({ monitor: {
    kind: "tcp", hostname: "next.example", port: 1234, intervalSeconds: 120, failureThreshold: 100, recoveryThreshold: 100,
  } });
});

it("offers HTTP and TCP targets within the Status ledger operator configuration", async () => {
  const html = await (await request("/operator")).text();
  expect(html).toContain('<label for="kind">Check type</label>');
  expect(html).toContain('<option value="http">HTTP(S)</option>');
  expect(html).toContain('<option value="tcp">TCP</option>');
  expect(html).toContain('<label for="hostname">Hostname</label>');
  expect(html).toContain('<label for="port">Port</label>');
  expect(html).toContain('id="port" name="port" type="number" min="1" max="65535"');
  const script = await (await request("/operator.js")).text();
  expect(script).toContain("configuration.port = Number(configuration.port)");
});

it("records synchronous connection errors and tolerates rejected socket cleanup before the next attempt", async () => {
  await configure({ ...config, failureThreshold: 1, recoveryThreshold: 1 });
  vi.mocked(connect).mockImplementationOnce(() => { throw new Error("blocked target"); });
  await tick(0);
  expect(await status()).toMatchObject({ monitor: { state: "down" }, incidents: [{ openedAt: start, closedAt: null }] });
  vi.mocked(connect).mockImplementationOnce(() => ({
    opened: Promise.resolve({}), closed: Promise.reject(new Error("closed")),
    close: async (): Promise<void> => { throw new Error("already closed"); },
  } as Socket));
  await tick(60_000);
  expect(await status()).toMatchObject({ monitor: { state: "up" }, incidents: [{ openedAt: start, closedAt: start + 60_000 }] });
  const html = await (await request("/")).text();
  expect(html).toContain("All services operational");
  expect(html).toContain("Recovered");
  expect(html).not.toContain("db.example");
});

it("delivers named TCP Incident transitions through the context webhook while edits emit no alerts", async () => {
  await request("/api/operator/webhook", { method: "PUT", headers: { authorization, "Content-Type": "application/json" }, body: JSON.stringify({ url: "https://alerts.example/tcp" }) });
  await configure();
  const messages: unknown[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    expect(url).toBe("https://alerts.example/tcp");
    expect(init?.method).toBe("POST");
    messages.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 204 });
  });
  let success = false;
  vi.mocked(connect).mockImplementation(() => ({
    opened: success ? Promise.resolve({}) : Promise.reject(new Error("refused")),
    closed: Promise.resolve(), close: async () => {},
  } as Socket));
  await tick(0);
  expect(messages).toEqual([]);
  await tick(60_000);
  await tick(120_000);
  expect(messages).toEqual([{ text: "Database: Incident opened" }]);
  await configure({ ...config, intervalSeconds: 120 });
  expect(messages).toHaveLength(1);
  success = true;
  await tick(240_000);
  await tick(360_000);
  expect(messages).toEqual([{ text: "Database: Incident opened" }, { text: "Database: Incident recovered" }]);
  expect(await (await request("/api/operator", { headers: { authorization } })).json()).toMatchObject({ webhookUrl: "https://alerts.example/tcp" });
});

it("records timeouts and dispatches later checks while socket cleanup remains pending", async () => {
  await configure({ ...config, timeoutSeconds: 1, failureThreshold: 1, recoveryThreshold: 1 });
  const realTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, milliseconds, ...args) =>
    realTimeout(callback, milliseconds === 1000 ? 0 : milliseconds, ...args));
  let releaseCleanup!: () => void;
  const cleanup = new Promise<void>(resolve => { releaseCleanup = resolve; });
  vi.mocked(connect).mockImplementationOnce(() => ({
    opened: new Promise(() => {}), closed: cleanup, close: () => cleanup,
  } as Socket)).mockImplementation(() => ({
    opened: Promise.resolve({}), closed: Promise.resolve(), close: async () => {},
  } as Socket));
  const pending = tick(0);
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    const completed = await Promise.race([
      pending.then(() => true),
      new Promise<boolean>(resolve => { guard = realTimeout(() => resolve(false), 100); }),
    ]);
    expect(completed).toBe(true);
    expect(await status()).toMatchObject({ monitor: { state: "down", lastResult: { at: start, outcome: "failure" } } });
    await tick(60_000);
    expect(await status()).toMatchObject({ monitor: { state: "up" }, incidents: [{ openedAt: start, closedAt: start + 60_000 }] });
  } finally {
    clearTimeout(guard);
    releaseCleanup();
    await pending;
  }
});

it("records observations even when socket cleanup throws synchronously", async () => {
  await configure();
  vi.mocked(connect).mockImplementation(() => ({
    opened: Promise.resolve({}), closed: Promise.resolve(),
    close: (): Promise<void> => { throw new Error("cleanup failed"); },
  } as Socket));
  await tick(0);
  await tick(60_000);
  expect(await status()).toMatchObject({ monitor: { state: "up", lastResult: { at: start + 60_000, outcome: "success" } } });
});

it.each(["2001:db8::1", "[2001:db8::1]"])("connects an IPv6 target supplied as %s using a bracketed authority", async hostname => {
  expect((await configure({ ...config, hostname })).status).toBe(200);
  vi.mocked(connect).mockImplementation(address => {
    // Native CONNECT builds hostname:port, so an IPv6 hostname needs brackets.
    if (typeof address === "string" || address.hostname !== "[2001:db8::1]") throw new Error("invalid CONNECT authority");
    return { opened: Promise.resolve({}), closed: Promise.resolve(), close: async () => {} } as Socket;
  });
  await tick(0);
  expect(await status()).toMatchObject({ monitor: { state: "up", lastResult: { outcome: "success" } } });
  expect(await (await request("/api/operator", { headers: { authorization } })).json())
    .toMatchObject({ monitor: { hostname: "2001:db8::1", port: 5432 } });
});
