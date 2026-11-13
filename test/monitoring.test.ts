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
async function configure(configuration = config) {
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
    monitorId: (await status()).monitors[0].id,
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
  expect(await (await request("/")).text()).toContain("No Monitors published");
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

it("presents the selected Status ledger with Monitor configuration beside page settings", async () => {
  const operator = await (await request("/operator")).text();
  expect(operator).toContain('<table aria-label="Monitors">');
  expect(operator).toContain('<th scope="col">Monitor</th>');
  expect(operator).toContain('<th scope="col">State</th>');
  expect(operator).toContain('<aside aria-labelledby="page-settings">');
  expect(operator).toContain('id="page-settings">Status page</h2>');
  expect(operator).not.toContain("Schedule Maintenance");
  expect(operator).toContain("Save webhook");
  expect(operator).toContain('for="webhookUrl"');
  expect(operator).toContain('id="webhook"');
  await configure();
  network.use(
    http.get(config.url, () => new HttpResponse(null, { status: 200 })),
  );
  await tick(0);
  const page = await (await request("/")).text();
  expect(page).toContain("All services operational");
  expect(page).toContain('<article aria-labelledby="monitor-name">');
  expect(page.indexOf("All services operational")).toBeLessThan(
    page.indexOf('id="monitor-name"'),
  );
  expect(page.indexOf('id="monitor-name"')).toBeLessThan(
    page.indexOf('id="incident-heading"'),
  );
  expect(page).not.toContain("90 UTC-day");
  expect((await request("/app.css")).headers.get("Content-Type")).toContain(
    "text/css",
  );
});


it.each(["page name", "Monitor name", "unchanged"])(
  "preserves detection progress when saving %s",
  async (change) => {
    await configure();
    network.use(http.get(config.url, () => new HttpResponse(null, { status: 503 })));
    await tick(0);
    const updated = {
      ...config,
      ...(change === "page name"
        ? { pageName: "Renamed page" }
        : change === "Monitor name" ? { name: "Renamed website" } : {}),
    };
    expect((await configure(updated)).status).toBe(200);
    await tick(60_000);
    expect(await status()).toMatchObject({
      monitor: { state: "down" },
      incidents: [{ openedAt: start + 60_000, closedAt: null }],
    });
    network.use(http.get(config.url, () => new HttpResponse(null, { status: 204 })));
    await tick(120_000);
    await configure(updated);
    await tick(180_000);
    expect(await status()).toMatchObject({
      monitor: { state: "up" },
      incidents: [{ openedAt: start + 60_000, closedAt: start + 180_000 }],
    });
  },
);

it.each(["page name", "target"])(
  "records an in-flight check while saving %s for later attempts",
  async (change) => {
    await configure();
    network.use(http.get(config.url, () => new HttpResponse(null, { status: 503 })));
    await tick(0);
    const updated = {
      ...config,
      ...(change === "target"
        ? { url: "https://new-target.example/health" }
        : { pageName: "Renamed during check" }),
    };
    let savedStatus = 0;
    const outbound = vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
      savedStatus = (await configure(updated)).status;
      return new Response(null, { status: 503 });
    });
    await tick(60_000);
    expect(savedStatus).toBe(200);
    expect(outbound).toHaveBeenCalledWith(
      config.url, expect.objectContaining({ method: "GET" }),
    );
    expect(await status()).toMatchObject({
      pageName: updated.pageName,
      monitor: {
        state: "down",
        lastResult: { at: start + 60_000, outcome: "failure" },
      },
      incidents: [{ openedAt: start + 60_000, closedAt: null }],
    });
    expect(
      await (await request("/api/operator", { headers: { authorization } })).json(),
    ).toMatchObject({
      pageName: updated.pageName,
      monitor: { url: updated.url },
    });
    vi.restoreAllMocks();
    network.use(http.get(updated.url, () => new HttpResponse(null, { status: 204 })));
    await tick(120_000);
    await tick(180_000);
    expect(await status()).toMatchObject({
      monitor: { state: "up" },
      incidents: [{ openedAt: start + 60_000, closedAt: start + 180_000 }],
    });
  },
);

const operatorRequest = (path: string, method = "GET", body?: unknown) =>
  request(path, {
    method,
    headers: { authorization, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

it("creates independent Monitors in creation order and saves page settings separately", async () => {
  const first = await operatorRequest("/api/operator/monitors", "POST", { name: "Zebra", url: config.url, intervalSeconds: 120, timeoutSeconds: 5, failureThreshold: 3, recoveryThreshold: 4 });
  expect(first.status).toBe(201);
  const second = await operatorRequest("/api/operator/monitors", "POST", { name: "Alpha", url: "https://second.example/health" });
  expect(second.status).toBe(201);
  expect((await operatorRequest("/api/operator", "PUT", { pageName: "Fleet" })).status).toBe(200);
  const data = await (await operatorRequest("/api/operator/monitors")).json<import("../src/index").Status>();
  expect(data).toMatchObject({ pageName: "Fleet", monitors: [{ name: "Zebra", published: true, url: config.url, intervalSeconds: 120, timeoutSeconds: 5, failureThreshold: 3, recoveryThreshold: 4 }, { name: "Alpha", published: true, intervalSeconds: 60, timeoutSeconds: 10, failureThreshold: 2, recoveryThreshold: 2 }] });
  expect(data.monitors[0].id).not.toBe(data.monitors[1].id);
  await operatorRequest(`/api/operator/monitors/${data.monitors[0].id}`, "PATCH", { timeoutSeconds: 9 });
  await evictDurableObject(env.MONITORING.getByName("personal"));
  const persisted = await (await operatorRequest("/api/operator")).json<import("../src/index").Status>();
  expect(persisted.monitors).toMatchObject([
    { intervalSeconds: 120, timeoutSeconds: 9, failureThreshold: 3, recoveryThreshold: 4 },
    { intervalSeconds: 60, timeoutSeconds: 10, failureThreshold: 2, recoveryThreshold: 2 },
  ]);
  expect(await status()).toMatchObject({ monitors: [{ name: "Zebra" }, { name: "Alpha" }] });
});

it("checks private Monitors independently and filters public rows and Incident history", async () => {
  await configure();
  const publicId = (await status()).monitors[0].id;
  const created = await (await operatorRequest("/api/operator/monitors", "POST", { name: "Private", url: "https://private.example/health" })).json<import("../src/index").Status>();
  const id = created.monitors[1].id;
  const path = `/api/operator/monitors/${id}`;
  expect((await operatorRequest(path, "PATCH", { published: false })).status).toBe(200);
  let publicAttempts = 0;
  let privateAttempts = 0;
  network.use(
    http.get(config.url, () => { publicAttempts++; return new HttpResponse(null, { status: 204 }); }),
    http.get("https://private.example/health", () => { privateAttempts++; return new HttpResponse(null, { status: 503 }); }),
  );
  await tick(0);
  await tick(60_000);
  expect([publicAttempts, privateAttempts]).toEqual([2, 2]);
  expect(await status()).toMatchObject({ monitors: [{ name: "Website", state: "up" }], incidents: [] });
  const operator = await (await operatorRequest("/api/operator")).json<import("../src/index").Status>();
  expect(operator.monitors).toHaveLength(2);
  expect(operator.incidents).toMatchObject([{ monitorId: id, closedAt: null }]);
  expect(await (await request("/")).text()).toContain("All services operational");
  await operatorRequest(path, "PATCH", { published: true, name: "Published outage" });
  expect((await status()).incidents).toHaveLength(1);
  expect(await (await request("/")).text()).toContain("Services unavailable");
  await operatorRequest(`/api/operator/monitors/${publicId}`, "PATCH", { published: false });
  await operatorRequest(path, "PATCH", { published: false });
  expect(await status()).toMatchObject({ monitors: [], incidents: [] });
  const empty = await (await request("/")).text();
  expect(empty).toContain("No Monitors published");
  expect(empty).not.toContain("All services operational");
  await operatorRequest(path, "PATCH", { published: true });
  await operatorRequest(`/api/operator/monitors/${publicId}`, "PATCH", { published: true });
  expect((await status()).monitors.map(m => m.name)).toEqual(["Website", "Published outage"]);
});

it("deletes configuration during an active check without resurrecting it or erasing authorized Incidents", async () => {
  await configure();
  network.use(http.get(config.url, () => new HttpResponse(null, { status: 503 })));
  await tick(0);
  await tick(60_000);
  const id = (await status()).monitors[0].id;
  const before = (await status()).incidents;
  let deletedStatus = 0;
  const outbound = vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
    const deleted = await operatorRequest(`/api/operator/monitors/${id}`, "DELETE");
    deletedStatus = deleted.status;
    // Deleting while an attempt runs must not let a replacement inherit its result.
    expect((await operatorRequest("/api/operator/monitors", "POST", { name: "Replacement", url: "https://replacement.example" })).status).toBe(201);
    return new Response(null, { status: 204 });
  });
  await tick(120_000);
  expect(outbound).toHaveBeenCalledTimes(1);
  expect(deletedStatus).toBe(200);
  vi.restoreAllMocks();
  await evictDurableObject(env.MONITORING.getByName("personal"));
  expect(await status()).toMatchObject({ monitors: [{ name: "Replacement", state: "unknown", lastResult: null }], incidents: [] });
  const operator = await (await operatorRequest("/api/operator")).json<import("../src/index").Status>();
  expect(operator.monitors).toHaveLength(1);
  expect(operator.incidents).toEqual(before);
  let replacementAttempts = 0;
  network.use(http.get("https://replacement.example/", () => { replacementAttempts++; return new HttpResponse(null, { status: 204 }); }));
  await tick(180_000);
  expect(replacementAttempts).toBe(1);
  expect(await status()).toMatchObject({ monitors: [{ state: "up" }], incidents: [] });
  expect((await operatorRequest(`/api/operator/monitors/${id}`, "DELETE")).status).toBe(404);
  expect((await operatorRequest(`/api/operator/monitors/${id}`, "PATCH", { published: true })).status).toBe(404);
});

it("validates and authenticates every collection mutation without exposing targets", async () => {
  const create = { name: "<Private>", url: "https://private.example/health", published: false };
  for (const [path, method, body] of [
    ["/api/operator/monitors", "POST", create],
    ["/api/operator/monitors", "GET", undefined],
    ["/api/operator/monitors/unknown", "PATCH", { published: true }],
    ["/api/operator/monitors/unknown", "DELETE", undefined],
  ] as const) {
    expect((await request(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) })).status).toBe(401);
  }
  const saved = await operatorRequest("/api/operator/monitors", "POST", create);
  expect(saved.status).toBe(201);
  const id = (await saved.json<import("../src/index").Status>()).monitors[0].id;
  expect((await status()).monitors).toEqual([]);
  for (const body of [{ intervalSeconds: 59 }, { timeoutSeconds: null }, { failureThreshold: "2" }, { recoveryThreshold: 101 }, {}, { published: "false" }, { url: "https://u:p@private.example" }, { name: " " }, { kind: "tcp" }, { url: "ftp://private.example" }]) {
    expect((await operatorRequest(`/api/operator/monitors/${id}`, "PATCH", body)).status).toBe(400);
  }
  for (const body of [{ ...create, intervalSeconds: 59 }, { ...create, timeoutSeconds: null }, { ...create, failureThreshold: "2" }, { ...create, recoveryThreshold: 101 }, { ...create, published: "true" }, { ...create, kind: "tcp" }, { name: "Missing URL" }]) {
    expect((await operatorRequest("/api/operator/monitors", "POST", body)).status).toBe(400);
  }
  expect((await operatorRequest(`/api/operator/monitors/${id}`, "PATCH", { url: "https://new.example/#fragment", name: "Renamed" })).status).toBe(200);
  expect(await (await operatorRequest("/api/operator")).json()).toMatchObject({ monitors: [{ name: "Renamed", url: "https://new.example/", published: false }] });
  const publicText = await (await request("/api/status")).text() + await (await request("/")).text();
  expect(publicText).not.toContain(id);
  expect(publicText).not.toContain("private.example");
  expect(publicText).not.toContain("new.example");
  expect(publicText).not.toContain(env.INSTALLATION_SECRET);
  expect((await operatorRequest(`/api/operator/monitors/${id}`, "POST", create)).headers.get("Allow")).toBe("PATCH, DELETE");
});

it("serves collection controls with separate Monitor and page settings forms", async () => {
  const html = await (await request("/operator")).text();
  for (const control of ['id="new-monitor"', 'id="published"', 'id="cancel-edit"', 'id="page-configuration"', 'id="monitor-rows"']) {
    expect(html).toContain(control);
  }
  const script = await (await request("/operator.js")).text();
  expect(script).toContain("Publish");
  expect(script).toContain("Unpublish");
  expect(script).toContain("Delete");
  expect(script).toContain("/api/operator/monitors");
  expect(script).not.toContain("localStorage");
});

it("retains named Incidents independently when one unavailable Monitor recovers and the other is deleted", async () => {
  await configure();
  const other = await (await operatorRequest("/api/operator/monitors", "POST", { name: "Other", url: "https://other.example/health" })).json<import("../src/index").Status>();
  const id = other.monitors[1].id;
  network.use(
    http.get(config.url, () => new HttpResponse(null, { status: 503 })),
    http.get("https://other.example/health", () => new HttpResponse(null, { status: 500 })),
  );
  await tick(0);
  await tick(60_000);
  expect((await status()).incidents).toHaveLength(2);
  network.use(http.get(config.url, () => new HttpResponse(null, { status: 204 })));
  await tick(120_000);
  await tick(180_000);
  expect((await status()).monitors.map(monitor => monitor.state)).toEqual(["up", "down"]);
  expect((await status()).incidents.find(incident => incident.monitorId === id)).toMatchObject({ monitorName: "Other", closedAt: null });
  await operatorRequest(`/api/operator/monitors/${id}`, "DELETE");
  await evictDurableObject(env.MONITORING.getByName("personal"));
  const history = await (await operatorRequest("/api/operator")).json<import("../src/index").Status>();
  expect(history.incidents.find(incident => incident.monitorId === id)).toMatchObject({ monitorName: "Other", closedAt: null });
  expect((await status()).incidents).toMatchObject([{ closedAt: start + 180_000 }]);
});

async function saveWebhook(url: unknown, authenticated = true) {
  return request('/api/operator/webhook', {
    method: 'PUT',
    headers: { ...(authenticated ? { authorization } : {}), 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
}

it('saves one context webhook independently and keeps it out of public responses', async () => {
  const url = 'https://hooks.slack.com/services/test/secret?token=private';
  expect((await saveWebhook(url, false)).status).toBe(401);
  expect((await saveWebhook(url)).status).toBe(200);
  await configure();
  await evictDurableObject(env.MONITORING.getByName('personal'));
  expect(await (await request('/api/operator', { headers: { authorization } })).json()).toMatchObject({ webhookUrl: url });
  for (const path of ['/api/status', '/', '/operator', '/operator.js']) {
    expect(await (await request(path)).text()).not.toContain(url);
  }
});

it('rejects invalid or credential-bearing webhook URLs without replacing the saved destination', async () => {
  const url = 'https://hooks.example/secret';
  await saveWebhook(url);
  for (const invalid of [null, 42, 'http://hooks.example', 'ftp://hooks.example', 'https://user:password@hooks.example', 'https://hooks.example/#secret', 'not a URL', ' https://hooks.example', 'https://hooks.example/' + 'x'.repeat(2048)]) {
    expect((await saveWebhook(invalid)).status, String(invalid)).toBe(400);
  }
  expect(await (await request('/api/operator', { headers: { authorization } })).json()).toMatchObject({ webhookUrl: url });
});

it('activates on save and alerts once per actual opening and recovery without resetting detection', async () => {
  await configure({ ...config, name: 'Main\nWebsite' });
  let healthy = false;
  const deliveries: { url: string; body: unknown; contentType: string | null }[] = [];
  network.use(
    http.get(config.url, () => new HttpResponse(null, { status: healthy ? 204 : 503 })),
    http.post('https://hooks.example/*', async ({ request }) => {
      deliveries.push({ url: request.url, body: await request.json(), contentType: request.headers.get('Content-Type') });
      return new HttpResponse(null, { status: 204 });
    }),
  );
  await tick(0);
  expect(deliveries).toEqual([]);
  await saveWebhook('https://hooks.example/first');
  await tick(60_000);
  await tick(120_000);
  expect(deliveries).toEqual([{ url: 'https://hooks.example/first', body: { text: 'Main Website: Incident opened' }, contentType: 'application/json' }]);
  healthy = true;
  await tick(180_000);
  await saveWebhook('https://hooks.example/second');
  await tick(240_000);
  await tick(300_000);
  expect(deliveries).toHaveLength(2);
  expect(deliveries[1]).toMatchObject({ url: 'https://hooks.example/second', body: { text: 'Main Website: Incident recovered' } });
  expect(await status()).toMatchObject({ incidents: [{ openedAt: start + 60_000, closedAt: start + 240_000 }] });
  await saveWebhook('');
  healthy = false;
  await tick(360_000);
  await tick(420_000);
  expect(deliveries).toHaveLength(2);
  expect((await status()).incidents).toHaveLength(2);
});

it('preserves Slack URLs and normalizes Discord compatibility paths exactly once', async () => {
  await configure();
  network.use(http.get(config.url, () => new HttpResponse(null, { status: 503 })));
  const destinations = [
    ['https://hooks.slack.com/services/T/B/Token?x=1', 'https://hooks.slack.com/services/T/B/Token?x=1'],
    ['https://discord.com/api/webhooks/123/token?wait=true', 'https://discord.com/api/webhooks/123/token/slack?wait=true'],
    ['https://discord.com/api/webhooks/123/token/slack', 'https://discord.com/api/webhooks/123/token/slack'],
    ['https://discordapp.com/api/v10/webhooks/123/token/', 'https://discordapp.com/api/v10/webhooks/123/token/slack'],
    ['https://canary.discord.com/api/webhooks/123/token/slack/', 'https://canary.discord.com/api/webhooks/123/token/slack'],
    ['https://discord.com/api/webhooks/123/slack', 'https://discord.com/api/webhooks/123/slack/slack'],
    ['https://discord.com.evil.example/api/webhooks/123/token', 'https://discord.com.evil.example/api/webhooks/123/token'],
  ];
  const received: string[] = [];
  network.use(http.post('*', ({ request }) => { received.push(request.url); return new HttpResponse(null, { status: 204 }); }));
  let offset = 0;
  for (const [input, expected] of destinations) {
    expect((await saveWebhook(input)).status).toBe(200);
    await tick(offset);
    await tick(offset + 60_000);
    expect(received.at(-1)).toBe(expected);
    // Saving the returned destination must remain idempotent.
    const saved = await (await request('/api/operator', { headers: { authorization } })).json() as { webhookUrl: string };
    expect(saved.webhookUrl).toBe(expected);
    await saveWebhook(saved.webhookUrl);
    network.use(http.get(config.url, () => new HttpResponse(null, { status: 204 })));
    await tick(offset + 120_000);
    await tick(offset + 180_000);
    expect(received.at(-1)).toBe(expected);
    network.use(http.get(config.url, () => new HttpResponse(null, { status: 503 })));
    offset += 240_000;
  }
  expect(received).toHaveLength(14);
});

it.each(['rejected', 'network error', 'redirect'])('keeps Incident detection committed when webhook delivery is %s', async (failure) => {
  await configure();
  await saveWebhook('https://hooks.example/credential');
  let healthy = false;
  const messages: unknown[] = [];
  const forwarded: string[] = [];
  network.use(
    http.get(config.url, () => new HttpResponse(null, { status: healthy ? 204 : 503 })),
    http.post('https://hooks.example/credential', async ({ request }) => {
      messages.push(await request.json());
      if (failure === 'network error') return HttpResponse.error();
      if (failure === 'redirect') return HttpResponse.redirect('https://other.example/leak');
      return new HttpResponse('private upstream error', { status: 500 });
    }),
    http.all('https://other.example/leak', ({ request }) => { forwarded.push(request.url); return new HttpResponse(null); }),
  );
  await tick(0);
  await tick(60_000);
  await evictDurableObject(env.MONITORING.getByName('personal'));
  await tick(120_000);
  expect(await status()).toMatchObject({ monitor: { state: 'down' }, incidents: [{ closedAt: null }] });
  expect(messages).toEqual([{ text: 'Website: Incident opened' }]);
  healthy = true;
  await tick(180_000);
  await tick(240_000);
  expect(await status()).toMatchObject({ monitor: { state: 'up' }, incidents: [{ closedAt: start + 240_000 }] });
  expect(messages).toEqual([{ text: 'Website: Incident opened' }, { text: 'Website: Incident recovered' }]);
  expect(forwarded).toEqual([]);
  expect(await (await request('/api/status')).text()).not.toContain('credential');
});

it('bounds webhook delivery time without undoing the opening or leaking the target', async () => {
  await configure();
  await saveWebhook('https://hooks.example/timeout-secret');
  network.use(http.get(config.url, () => new HttpResponse(null, { status: 503 })));
  await tick(0);
  const realTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, milliseconds, ...args) =>
    realTimeout(callback, milliseconds === 10_000 ? 0 : milliseconds, ...args),
  );
  const outbound = globalThis.fetch;
  const deliveries: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (init?.method !== 'POST') return outbound(input, init);
    deliveries.push(String(input));
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('timeout-secret')), { once: true });
    });
  });
  await tick(60_000);
  await tick(120_000);
  expect(deliveries).toEqual(['https://hooks.example/timeout-secret']);
  expect(await status()).toMatchObject({ monitor: { state: 'down' }, incidents: [{ openedAt: start + 60_000, closedAt: null }] });
  expect(await (await request('/api/status')).text()).not.toContain('timeout-secret');
});

it('alerts independently for public and private Monitors while every configuration save retains the context destination', async () => {
  const destination = 'https://hooks.example/fleet';
  await saveWebhook(destination);
  await configure();
  const created = await (await operatorRequest('/api/operator/monitors', 'POST', {
    name: 'Private API', url: 'https://private.example/health', published: false,
    intervalSeconds: 120, failureThreshold: 1, recoveryThreshold: 1,
  })).json<import('../src/index').Status>();
  const [website, privateApi] = created.monitors;
  const messages: unknown[] = [];
  let publicHealthy = false;
  let privateHealthy = false;
  network.use(
    http.get(config.url, () => new HttpResponse(null, { status: publicHealthy ? 204 : 503 })),
    http.get('https://private.example/health', () => new HttpResponse(null, { status: privateHealthy ? 204 : 503 })),
    http.post(destination, async ({ request }) => {
      messages.push(await request.json());
      // The alert observes already committed state, even for a private Monitor.
      const committed = await (await operatorRequest('/api/operator')).json<import('../src/index').Status>();
      expect(committed.incidents).toHaveLength(messages.length === 1 ? 1 : 2);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  await tick(0);
  expect(messages).toEqual([{ text: 'Private API: Incident opened' }]);
  expect(await status()).toMatchObject({ monitors: [{ id: website.id }], incidents: [] });
  await operatorRequest('/api/operator', 'PUT', { pageName: 'Fleet' });
  await operatorRequest(`/api/operator/monitors/${website.id}`, 'PATCH', { timeoutSeconds: 5 });
  await operatorRequest(`/api/operator/monitors/${privateApi.id}`, 'PATCH', { published: true });
  await operatorRequest(`/api/operator/monitors/${privateApi.id}`, 'PATCH', { published: false });
  await evictDurableObject(env.MONITORING.getByName('personal'));
  expect(await (await operatorRequest('/api/operator')).json()).toMatchObject({ webhookUrl: destination });
  await tick(60_000);
  await tick(120_000);
  expect(messages).toEqual([{ text: 'Private API: Incident opened' }, { text: 'Website: Incident opened' }]);
  publicHealthy = true;
  await tick(180_000);
  await tick(240_000);
  expect(messages.at(-1)).toEqual({ text: 'Website: Incident recovered' });
  expect(await status()).toMatchObject({ monitors: [{ state: 'up' }], incidents: [{ closedAt: start + 240_000 }] });
  privateHealthy = true;
  await tick(300_000);
  expect(messages).toHaveLength(3);
  await tick(360_000);
  await tick(480_000);
  expect(messages).toEqual([
    { text: 'Private API: Incident opened' }, { text: 'Website: Incident opened' },
    { text: 'Website: Incident recovered' }, { text: 'Private API: Incident recovered' },
  ]);
  await operatorRequest(`/api/operator/monitors/${privateApi.id}`, 'DELETE');
  await operatorRequest(`/api/operator/monitors/${website.id}`, 'DELETE');
  await evictDurableObject(env.MONITORING.getByName('personal'));
  expect(await (await operatorRequest('/api/operator')).json()).toMatchObject({ webhookUrl: destination, monitors: [] });
  expect(messages).toHaveLength(4);
});

it.each(['opening', 'recovery'])('discards a deleted Monitor’s late %s without an alert or future checks', async phase => {
  await configure();
  await saveWebhook('https://hooks.example/deletion');
  let healthy = false;
  let attempts = 0;
  const messages: unknown[] = [];
  network.use(
    http.get(config.url, () => { attempts++; return new HttpResponse(null, { status: healthy ? 204 : 503 }); }),
    http.post('https://hooks.example/deletion', async ({ request }) => {
      messages.push(await request.json()); return new HttpResponse(null, { status: 204 });
    }),
  );
  await tick(0);
  if (phase === 'recovery') { await tick(60_000); healthy = true; await tick(120_000); }
  const before = await status();
  const id = before.monitors[0].id;
  vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
    expect((await operatorRequest(`/api/operator/monitors/${id}`, 'DELETE')).status).toBe(200);
    return new Response(null, { status: healthy ? 204 : 503 });
  });
  await tick(phase === 'opening' ? 60_000 : 180_000);
  vi.restoreAllMocks();
  await evictDurableObject(env.MONITORING.getByName('personal'));
  await tick(240_000);
  await tick(300_000);
  expect(attempts).toBe(phase === 'opening' ? 1 : 3);
  expect(messages).toEqual(phase === 'opening' ? [] : [{ text: 'Website: Incident opened' }]);
  expect(await status()).toMatchObject({ monitors: [], incidents: [] });
  expect(await (await operatorRequest('/api/operator')).json()).toMatchObject({
    webhookUrl: 'https://hooks.example/deletion', monitors: [], incidents: before.incidents,
  });
});

it('uses an active Monitor’s timing snapshot while preserving concurrent context and sibling edits', async () => {
  await configure();
  await saveWebhook('https://hooks.example/old');
  const created = await (await operatorRequest('/api/operator/monitors', 'POST', {
    name: 'Sibling', url: 'https://sibling.example/health', intervalSeconds: 300,
  })).json<import('../src/index').Status>();
  const [website, sibling] = created.monitors;
  const messages: { url: string; body: unknown }[] = [];
  network.use(
    http.get(config.url, () => new HttpResponse(null, { status: 503 })),
    http.get('https://sibling.example/health', () => new HttpResponse(null, { status: 204 })),
    http.get('https://edited.example/health', () => new HttpResponse(null, { status: 503 })),
    http.post('https://hooks.example/*', async ({ request }) => {
      messages.push({ url: request.url, body: await request.json() });
      return new HttpResponse(null, { status: 204 });
    }),
  );
  await tick(0);
  vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
    await operatorRequest(`/api/operator/monitors/${website.id}`, 'PATCH', {
      failureThreshold: 100, intervalSeconds: 120, timeoutSeconds: 1, url: 'https://edited.example/health',
    });
    await operatorRequest(`/api/operator/monitors/${sibling.id}`, 'PATCH', { name: 'Renamed sibling', published: false });
    await operatorRequest('/api/operator', 'PUT', { pageName: 'Edited during attempt' });
    await saveWebhook('https://hooks.example/latest');
    await tick(60_000);
    return new Response(null, { status: 503 });
  });
  await tick(60_000);
  vi.restoreAllMocks();
  expect(messages).toEqual([{ url: 'https://hooks.example/latest', body: { text: 'Website: Incident opened' } }]);
  await evictDurableObject(env.MONITORING.getByName('personal'));
  expect(await (await operatorRequest('/api/operator')).json()).toMatchObject({
    pageName: 'Edited during attempt', webhookUrl: 'https://hooks.example/latest',
    monitors: [
      { id: website.id, state: 'down', failureThreshold: 100, intervalSeconds: 120, timeoutSeconds: 1, url: 'https://edited.example/health' },
      { id: sibling.id, name: 'Renamed sibling', published: false, lastResult: { at: start } },
    ],
  });
  await tick(120_000);
  expect((await status()).monitor?.lastResult?.at).toBe(start + 60_000);
  await tick(180_000);
  expect((await status()).monitor?.lastResult?.at).toBe(start + 180_000);
  expect(messages).toHaveLength(1);
});
