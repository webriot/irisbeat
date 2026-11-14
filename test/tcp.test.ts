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
  expect((await configure({ pageName: "Web", name: "Website", url: "https://web.example" })).status).toBe(400);
  expect(await (await request("/api/operator", { headers: { authorization } })).json()).toEqual(saved);
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
  expect(script).toContain("body.port = Number(byId('port').value)");
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

const mutate = (path: string, method: string, body?: unknown) => request(path, {
  method, headers: { authorization, "Content-Type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const operator = async (): Promise<import("../src/index").Status> => (await request("/api/operator", { headers: { authorization } })).json();

it("creates mixed targets in order, edits only the selected ID and retains settings across eviction", async () => {
  await mutate("/api/operator/webhook", "PUT", { url: "https://alerts.example/mixed" });
  expect((await mutate("/api/operator/monitors", "POST", { name: "Web", url: "https://web.example/health" })).status).toBe(201);
  expect((await mutate("/api/operator/monitors", "POST", { name: "Database", kind: "tcp", hostname: "db.example", port: 5432, published: false })).status).toBe(201);
  const [web, tcp] = (await operator()).monitors;
  expect((await mutate('/api/operator/monitors/' + tcp.id, 'PATCH', { port: 6432, intervalSeconds: 120 })).status).toBe(200);
  expect((await mutate('/api/operator/monitors/' + web.id, 'PATCH', { url: 'https://next.example/health' })).status).toBe(200);
  await evictDurableObject(env.MONITORING.getByName('personal'));
  expect(await operator()).toMatchObject({ webhookUrl: 'https://alerts.example/mixed', monitors: [
    { id: web.id, kind: 'http', url: 'https://next.example/health', intervalSeconds: 60 },
    { id: tcp.id, kind: 'tcp', hostname: 'db.example', port: 6432, intervalSeconds: 120, published: false },
  ] });
  expect((await status()).monitors.map(m => m.id)).toEqual([web.id]);
  expect((await mutate('/api/operator/monitors/' + tcp.id, 'PATCH', { published: true })).status).toBe(200);
  expect((await status()).monitors.map(m => m.id)).toEqual([web.id, tcp.id]);
  for (const path of ['/', '/api/status']) {
    const body = await (await request(path)).text();
    for (const hidden of ['db.example', '6432', 'next.example', 'alerts.example']) expect(body).not.toContain(hidden);
  }
});

it("keeps mixed failures, recoveries and webhook identities independent, including private Monitors", async () => {
  await mutate('/api/operator/webhook', 'PUT', { url: 'https://alerts.example/mixed' });
  await mutate('/api/operator/monitors', 'POST', { name: 'Web', url: 'https://web.example/health' });
  await mutate('/api/operator/monitors', 'POST', { name: 'Database', kind: 'tcp', hostname: 'db.example', port: 5432, published: false });
  const [web, tcp] = (await operator()).monitors;
  let webUp = false;
  let tcpUp = true;
  const messages: unknown[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (init?.method === 'POST') {
      expect(url).toBe('https://alerts.example/mixed');
      messages.push(JSON.parse(String(init.body)));
      return new Response(null, { status: 204 });
    }
    expect(url).toBe('https://web.example/health');
    return new Response(null, { status: webUp ? 204 : 503 });
  });
  vi.mocked(connect).mockImplementation(address => {
    expect(address).toEqual({ hostname: 'db.example', port: 5432 });
    return { opened: tcpUp ? Promise.resolve({}) : Promise.reject(new Error('refused')), closed: Promise.resolve(), close: async () => {} } as Socket;
  });
  await tick(0); await tick(60_000);
  expect(await operator()).toMatchObject({ monitors: [{ id: web.id, state: 'down' }, { id: tcp.id, state: 'up' }], incidents: [{ monitorId: web.id, closedAt: null }] });
  webUp = true; tcpUp = false;
  await tick(120_000); await tick(180_000);
  expect(await operator()).toMatchObject({ monitors: [{ id: web.id, state: 'up' }, { id: tcp.id, state: 'down' }], incidents: [
    { monitorId: tcp.id, openedAt: start + 180_000, closedAt: null },
    { monitorId: web.id, openedAt: start + 60_000, closedAt: start + 180_000 },
  ] });
  expect((await status()).incidents.map(i => i.monitorId)).toEqual([web.id]);
  expect(await (await request('/')).text()).toContain('All services operational');
  await mutate('/api/operator/monitors/' + tcp.id, 'PATCH', { published: true, name: 'Primary database' });
  expect(await (await request('/')).text()).toContain('Services unavailable');
  await evictDurableObject(env.MONITORING.getByName('personal'));
  tcpUp = true;
  await tick(240_000); await tick(300_000);
  expect((await status()).monitors.map(m => m.state)).toEqual(['up', 'up']);
  expect(messages).toHaveLength(4);
  expect(messages).toEqual(expect.arrayContaining([
    { text: 'Web: Incident opened' },
    { text: 'Web: Incident recovered' },
    { text: 'Database: Incident opened' },
    { text: 'Primary database: Incident recovered' },
  ]));
  await mutate('/api/operator/monitors/' + tcp.id, 'DELETE');
  expect((await status()).incidents.map(i => i.monitorId)).toEqual([web.id]);
  expect((await operator()).incidents[0]).toMatchObject({ monitorId: tcp.id, monitorName: 'Database', closedAt: start + 300_000 });
});

it("discards a deleted TCP Monitor's pending result while other IDs keep checking and alerting", async () => {
  await mutate('/api/operator/webhook', 'PUT', { url: 'https://alerts.example/deletion' });
  await mutate('/api/operator/monitors', 'POST', { name: 'Database', kind: 'tcp', hostname: 'db.example', port: 5432, failureThreshold: 1 });
  await mutate('/api/operator/monitors', 'POST', { name: 'Web', url: 'https://web.example/health', failureThreshold: 1, recoveryThreshold: 1 });
  const [tcp, web] = (await operator()).monitors;
  let closed = false;
  vi.mocked(connect).mockImplementation(() => ({
    opened: (async (): Promise<SocketInfo> => {
      await mutate('/api/operator/monitors/' + tcp.id, 'DELETE');
      await tick(60_000);
      webUp = true;
      await tick(120_000);
      throw new Error('late refusal');
    })(),
    closed: Promise.resolve(), close: async () => { closed = true; },
  } as Socket));
  let webUp = false;
  const messages: unknown[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    if (init?.method === 'POST') {
      messages.push(JSON.parse(String(init.body)));
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: webUp ? 204 : 503 });
  });
  await tick(0);
  expect(closed).toBe(true);
  expect(await operator()).toMatchObject({ monitors: [{ id: web.id, state: 'up' }], incidents: [{ monitorId: web.id, closedAt: start + 120_000 }] });
  expect((await operator()).monitors).toHaveLength(1);
  expect((await operator()).incidents).toHaveLength(1);
  expect(messages).toEqual([{ text: 'Web: Incident opened' }, { text: 'Web: Incident recovered' }]);
  await tick(180_000);
  expect(vi.mocked(connect)).toHaveBeenCalledTimes(1);
});

it("snapshots a TCP target per ID while HTTP continues and later TCP attempts use saved edits", async () => {
  await mutate('/api/operator/monitors', 'POST', { name: 'Database', kind: 'tcp', hostname: 'db.example', port: 5432, failureThreshold: 1 });
  await mutate('/api/operator/monitors', 'POST', { name: 'Web', url: 'https://web.example/health' });
  const [tcp, web] = (await operator()).monitors;
  const addresses: unknown[] = [];
  let httpAttempts = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
    expect(url).toBe('https://web.example/health'); httpAttempts++;
    return new Response(null, { status: 204 });
  });
  vi.mocked(connect).mockImplementation(address => {
    addresses.push(address);
    return { opened: (async () => {
      if (addresses.length === 1) {
        await mutate('/api/operator/monitors/' + tcp.id, 'PATCH', { hostname: 'next.example', port: 6432, intervalSeconds: 120, failureThreshold: 100 });
        await tick(120_000);
        throw new Error('starting target refused');
      }
      return {};
    })(), closed: Promise.resolve(), close: async () => {} } as Socket;
  });
  await tick(0);
  expect(await operator()).toMatchObject({ monitors: [{ id: tcp.id, state: 'down', hostname: 'next.example', port: 6432 }, { id: web.id, state: 'up' }], incidents: [{ monitorId: tcp.id, openedAt: start, closedAt: null }] });
  expect(addresses).toEqual([{ hostname: 'db.example', port: 5432 }]);
  expect(httpAttempts).toBe(2);
  await tick(120_000); await tick(240_000);
  expect(addresses).toEqual([{ hostname: 'db.example', port: 5432 }, { hostname: 'next.example', port: 6432 }, { hostname: 'next.example', port: 6432 }]);
  expect((await operator()).incidents[0]).toMatchObject({ monitorId: tcp.id, closedAt: start + 240_000 });
});

it("validates per-ID edits atomically and keeps Monitor kind fixed after creation", async () => {
  await mutate('/api/operator/monitors', 'POST', { name: 'Database', kind: 'tcp', hostname: 'db.example', port: 5432 });
  const tcp = (await operator()).monitors[0];
  const path = '/api/operator/monitors/' + tcp.id;
  const saved = await operator();
  for (const patch of [{ port: '6432' }, { port: 65536 }, { hostname: 'host:port' }, { kind: 'udp' }, { intervalSeconds: 59 }, { timeoutSeconds: 0 }, { failureThreshold: 101 }, { recoveryThreshold: 1.5 }]) {
    expect((await mutate(path, 'PATCH', patch)).status).toBe(400);
    expect(await operator()).toEqual(saved);
  }
  expect((await mutate('/api/operator/monitors', 'POST', { name: 'Invalid', kind: 'tcp', hostname: 'db.example', port: 0 })).status).toBe(400);
  expect(await operator()).toEqual(saved);
  expect((await mutate(path, 'PATCH', { kind: 'http', url: 'https://web.example' })).status).toBe(400);
  expect(await operator()).toEqual(saved);
  expect((await mutate(path, 'PATCH', { hostname: 'next.example', port: 6432 })).status).toBe(200);
  expect((await operator()).monitors[0]).toMatchObject({ id: tcp.id, kind: 'tcp', hostname: 'next.example', port: 6432 });
  await mutate('/api/operator/monitors', 'POST', { name: 'Web', url: 'https://web.example' });
  const web = (await operator()).monitors[1];
  const before = await operator();
  expect((await mutate('/api/operator/monitors/' + web.id, 'PATCH', { kind: 'tcp', hostname: 'db.example', port: 5432 })).status).toBe(400);
  expect(await operator()).toEqual(before);
  expect((await configure({ ...config, kind: 'http', url: 'https://web.example' })).status).toBe(400);
  expect(await operator()).toEqual(before);
  expect((await configure({ pageName: 'Status', name: 'Database', kind: 'tcp', hostname: 'later.example', port: 6432 })).status).toBe(200);
  expect((await operator()).monitors[0]).toMatchObject({ id: tcp.id, kind: 'tcp', hostname: 'later.example' });

});

it('does not retarget a legacy save to a TCP sibling during deletion', async () => {
  await mutate('/api/operator/monitors', 'POST', { name: 'First HTTP', url: 'https://first.example/' });
  await mutate('/api/operator/monitors', 'POST', { name: 'TCP sibling', kind: 'tcp', hostname: 'db.example', port: 5432 });
  const [first, sibling] = (await operator()).monitors;
  let reading!: () => void;
  const bodyRead = new Promise<void>(resolve => { reading = resolve; });
  let bodyController!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { bodyController = controller; },
    pull() { reading(); },
  }, { highWaterMark: 0 });
  const pendingSave = worker.fetch(new Request('https://irisbeat.example/api/operator', {
    method: 'PUT', headers: { authorization, 'Content-Type': 'application/json' }, body,
  }), env);
  await bodyRead;
  const removed = await mutate('/api/operator/monitors/' + first.id, 'DELETE');
  bodyController.enqueue(new TextEncoder().encode(JSON.stringify({ pageName: 'Changed', name: 'Edited HTTP', url: 'https://edited.example/' })));
  bodyController.close();
  const saved = await pendingSave;
  expect(removed.status).toBe(200);
  expect(saved.status).toBe(409);
  await evictDurableObject(env.MONITORING.getByName('personal'));
  expect((await operator()).monitors).toEqual([sibling]);
  expect((await operator()).pageName).toBe('Irisbeat');
});

it('rejects cross-kind changes and target fields atomically for every Monitor kind', async () => {
  const configurations = [
    { name: 'Web', kind: 'http', url: 'https://web.example/' },
    { name: 'Database', kind: 'tcp', hostname: 'db.example', port: 5432 },
    { name: 'Producer', kind: 'heartbeat' },
  ];
  for (const configuration of configurations) expect((await mutate('/api/operator/monitors', 'POST', configuration)).status).toBe(201);
  const saved = await operator();
  for (const monitor of saved.monitors) {
    for (const other of configurations.filter(c => c.kind !== monitor.kind)) {
      expect((await mutate('/api/operator/monitors/' + monitor.id, 'PATCH', { ...other, published: false })).status).toBe(400);
      const { kind: _kind, name: _name, ...target } = other;
      if (Object.keys(target).length) {
        expect((await mutate('/api/operator/monitors/' + monitor.id, 'PATCH', { ...target, name: 'Rejected' })).status).toBe(400);
      }
    }
  }
  for (const body of [
    { name: 'Mixed', kind: 'http', url: 'https://web.example/', hostname: 'db.example', port: 5432 },
    { name: 'Mixed', kind: 'tcp', hostname: 'db.example', port: 5432, url: 'https://web.example/' },
    { name: 'Mixed', kind: 'heartbeat', url: 'https://web.example/' },
    { name: 'Mixed', kind: 'heartbeat', hostname: 'db.example', port: 5432 },
  ]) expect((await mutate('/api/operator/monitors', 'POST', body)).status).toBe(400);
  await evictDurableObject(env.MONITORING.getByName('personal'));
  expect(await operator()).toEqual(saved);
});

it('keeps HTTP, private TCP and Heartbeat detection, receipts, alerts and retained history independent', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  await mutate('/api/operator/webhook', 'PUT', { url: 'https://alerts.example/three' });
  for (const body of [
    { name: 'Web', url: 'https://web.example/health', failureThreshold: 1, recoveryThreshold: 1 },
    { name: 'Private database', kind: 'tcp', hostname: 'db.example', port: 5432, published: false, failureThreshold: 1, recoveryThreshold: 1 },
    { name: 'Producer', kind: 'heartbeat', silenceSeconds: 60, recoverySpacingSeconds: 120 },
  ]) expect((await mutate('/api/operator/monitors', 'POST', body)).status).toBe(201);
  const [web, tcp, heartbeat] = (await operator()).monitors;
  expect(new Set([web.id, tcp.id, heartbeat.id]).size).toBe(3);
  let webUp = false;
  let tcpUp = true;
  const messages: unknown[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (init?.method === 'POST') {
      expect(url).toBe('https://alerts.example/three');
      messages.push(JSON.parse(String(init.body)));
      return new Response(null, { status: 204 });
    }
    expect(url).toBe('https://web.example/health');
    return new Response(null, { status: webUp ? 204 : 503 });
  });
  vi.mocked(connect).mockImplementation(address => {
    expect(address).toEqual({ hostname: 'db.example', port: 5432 });
    return { opened: tcpUp ? Promise.resolve({}) : Promise.reject(new Error('refused')), closed: Promise.resolve(), close: async () => {} } as Socket;
  });
  const receipt = (id: string) => request('/heartbeat/' + id, { method: 'POST', headers: { authorization }, body: 'ignored' });
  await tick(0);
  webUp = true; tcpUp = false;
  await tick(60_000);
  expect((await operator()).monitors.map(m => [m.id, m.state])).toEqual([[web.id, 'up'], [tcp.id, 'down'], [heartbeat.id, 'down']]);
  const beforeRejectedReceipts = await operator();
  expect((await receipt(web.id)).status).toBe(404);
  expect((await receipt(tcp.id)).status).toBe(404);
  expect(await operator()).toEqual(beforeRejectedReceipts);
  clock.mockReturnValue(start + 80_000); expect((await receipt(heartbeat.id)).status).toBe(204);
  await mutate('/api/operator/monitors/' + heartbeat.id, 'PATCH', { silenceSeconds: 300 });
  clock.mockReturnValue(start + 199_999); await receipt(heartbeat.id);
  expect((await operator()).monitors[2].state).toBe('down');
  clock.mockReturnValue(start + 200_000); await receipt(heartbeat.id);
  tcpUp = true; await tick(200_000);
  expect((await operator()).monitors.map(m => m.state)).toEqual(['up', 'up', 'up']);
  expect(messages).toHaveLength(6);
  expect(messages).toEqual(expect.arrayContaining([
    { text: 'Web: Incident opened' }, { text: 'Web: Incident recovered' },
    { text: 'Private database: Incident opened' }, { text: 'Private database: Incident recovered' },
    { text: 'Producer: Incident opened' }, { text: 'Producer: Incident recovered' },
  ]));
  expect((await status()).monitors.map(m => m.id)).toEqual([web.id, heartbeat.id]);
  expect((await status()).incidents.map(i => i.monitorId)).not.toContain(tcp.id);
  const anonymous = JSON.stringify(await status()) + await (await request('/')).text();
  for (const hidden of ['db.example', '5432', 'web.example', 'alerts.example', 'Private database', 'test-installation-secret']) expect(anonymous).not.toContain(hidden);
  const beforePageSave = await operator();
  expect((await mutate('/api/operator', 'PUT', { pageName: 'Three services' })).status).toBe(200);
  expect((await operator()).monitors).toEqual(beforePageSave.monitors);
  const retained = (await operator()).incidents;
  await mutate('/api/operator/monitors/' + heartbeat.id, 'DELETE');
  await mutate('/api/operator/monitors/' + tcp.id, 'DELETE');
  expect((await receipt(heartbeat.id)).status).toBe(404);
  await evictDurableObject(env.MONITORING.getByName('personal'));
  expect((await operator()).incidents).toEqual(retained);
  expect((await operator()).monitors.map(m => m.id)).toEqual([web.id]);
  expect((await status()).incidents.map(i => i.monitorId)).toEqual([web.id]);
  expect(messages).toHaveLength(6);
});

it('validates and serializes only timing controls supported by each kind', async () => {
  for (const body of [
    { name: 'Web', url: 'https://web.example/' },
    { name: 'Database', kind: 'tcp', hostname: 'db.example', port: 5432 },
    { name: 'Producer', kind: 'heartbeat' },
  ]) expect((await mutate('/api/operator/monitors', 'POST', body)).status).toBe(201);
  const saved = await operator();
  for (const monitor of saved.monitors) {
    const unsupported = monitor.kind === 'heartbeat' ? ['timeoutSeconds', 'failureThreshold'] : ['silenceSeconds', 'recoverySpacingSeconds'];
    for (const field of unsupported) {
      expect(monitor).not.toHaveProperty(field);
      expect((await mutate('/api/operator/monitors/' + monitor.id, 'PATCH', { [field]: 60, name: 'Rejected' })).status).toBe(400);
    }
  }
  expect(await operator()).toEqual(saved);
});
