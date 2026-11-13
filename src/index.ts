// SPDX-License-Identifier: AGPL-3.0-only
import { operatorPage, operatorScript, statusPage, styleSheet } from "./ui";
import { connect } from "cloudflare:sockets";
import { DurableObject } from "cloudflare:workers";

const timingDefaults = {
  intervalSeconds: 60,
  timeoutSeconds: 10,
  failureThreshold: 2,
  recoveryThreshold: 2,
};
const timingBounds = {
  intervalSeconds: [60, 86_400],
  timeoutSeconds: [1, 60],
  failureThreshold: [1, 100],
  recoveryThreshold: [1, 100],
} as const;
type Timing = typeof timingDefaults;
type Target =
  | { kind: "http"; url: string; hostname?: never; port?: never }
  | { kind: "tcp"; hostname: string; port: number; url?: never };
type MonitorConfiguration = { name: string; published?: boolean } & Target & Partial<Timing>;
type Configuration = MonitorConfiguration & { pageName: string };

export type Incident = {
  id: string;
  monitorId: string;
  monitorName: string | null;
  openedAt: number;
  closedAt: number | null;
};
type CheckResult = { at: number; outcome: "success" | "failure" };
type Monitor = MonitorConfiguration & Timing & {
  published: boolean;
  id: string;
  state: "unknown" | "up" | "down";
  lastResult: CheckResult | null;
  failures: number;
  successes: number;
  nextDue: number;
};
export type Status = ReturnType<MonitoringContext["status"]>;
type StoredContext = { pageName: string; monitors: Monitor[]; webhookUrl?: string | null };
type LegacyContext = { webhookUrl?: string | null; monitor: (Monitor & { pageName: string }) | null };

export class MonitoringContext extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS incidents (
      id TEXT PRIMARY KEY, monitorId TEXT NOT NULL, openedAt INTEGER NOT NULL, closedAt INTEGER
    )`);
    if (!ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(incidents)").toArray().some(column => column.name === "monitorName")) {
      ctx.storage.sql.exec("ALTER TABLE incidents ADD COLUMN monitorName TEXT");
    }
  }
  private read(): StoredContext {
    const stored = this.ctx.storage.kv.get<StoredContext | LegacyContext>("context");
    if (!stored) return { pageName: "Irisbeat", monitors: [] };
    if ("monitors" in stored) {
      stored.monitors = stored.monitors.map(monitor => { monitor.kind ??= "http"; return { ...timingDefaults, ...monitor }; });
      return stored;
    }
    const { monitor: legacyMonitor, ...context } = stored;
    const pageName = legacyMonitor?.pageName ?? "Irisbeat";
    const state: StoredContext = {
      ...context,
      pageName,
      monitors: [],
    };
    // Preserve the legacy ID, detector progress and Incident identity on upgrade.
    if (stored.monitor) {
      stored.monitor.kind ??= "http";
      const { pageName: _pageName, ...monitor } = stored.monitor;
      state.monitors.push({ ...timingDefaults, ...monitor, published: true });
    }
    this.ctx.storage.transactionSync(() => {
      if (stored.monitor) this.ctx.storage.sql.exec(
        "UPDATE incidents SET monitorName = ? WHERE monitorId = ? AND monitorName IS NULL",
        stored.monitor.name, stored.monitor.id,
      );
      this.ctx.storage.kv.put("context", state);
    });
    return state;
  }

  configure(configuration: Configuration | { pageName: string }) {
    const state = this.read();
    state.pageName = configuration.pageName;
    // Keep the original single-Monitor save contract for existing clients.
    if ("name" in configuration) {
      const monitor = state.monitors[0];
      const { pageName: _pageName, ...settings } = configuration;
      if (monitor) this.applyEdit(monitor, settings);
      else state.monitors.push(this.newMonitor(settings));
    }
    this.ctx.storage.kv.put("context", state);
    return this.status(true);
  }

  private newMonitor(configuration: MonitorConfiguration): Monitor {
    return { ...timingDefaults, ...configuration, id: crypto.randomUUID(), published: configuration.published ?? true, state: "unknown", lastResult: null,
      failures: 0, successes: 0, nextDue: 0 };
  }

  create(configuration: MonitorConfiguration) {
    const state = this.read();
    state.monitors.push(this.newMonitor(configuration));
    this.ctx.storage.kv.put("context", state);
    return this.status(true);
  }

  configureWebhook(url: string | null) {
    const state = this.read();
    state.webhookUrl = url;
    this.ctx.storage.kv.put("context", state);
    return this.status(true);
  }

  edit(id: string, value: unknown) {
    const state = this.read();
    const monitor = state.monitors.find(monitor => monitor.id === id);
    if (!monitor) return null;
    const patch = parseMonitorPatch(value, monitor);
    if (!patch) return undefined;
    this.applyEdit(monitor, patch);
    this.ctx.storage.kv.put("context", state);
    return this.status(true);
  }

  private applyEdit(monitor: Monitor, patch: Partial<MonitorConfiguration>) {
    // Preserve #3's last-dispatch anchor, including a running attempt.
    if (monitor.nextDue && patch.intervalSeconds !== undefined)
      monitor.nextDue += (patch.intervalSeconds - monitor.intervalSeconds) * 1000;
    Object.assign(monitor, patch);
  }

  remove(id: string) {
    const state = this.read();
    if (!state.monitors.some(monitor => monitor.id === id)) return null;
    state.monitors = state.monitors.filter(monitor => monitor.id !== id);
    this.ctx.storage.kv.put("context", state);
    return this.status(true);
  }

  private checking = new Set<string>();

  async check(at: number) {
    await Promise.all(this.read().monitors.map(monitor => this.checkMonitor(monitor.id, at)));
  }

  private async checkMonitor(id: string, at: number) {
    const state = this.read();
    const attempt = state.monitors.find(monitor => monitor.id === id);
    if (!attempt || this.checking.has(id) || at < attempt.nextDue) return;
    this.checking.add(id);
    attempt.nextDue = at + attempt.intervalSeconds * 1000;
    this.ctx.storage.kv.put("context", state);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), attempt.timeoutSeconds * 1000);
    let success = false;
    let socket: Socket | undefined;
    try {
      if (attempt.kind === "tcp") {
        const hostname = attempt.hostname.includes(":") ? `[${attempt.hostname}]` : attempt.hostname;
        socket = connect({ hostname, port: attempt.port });
        void socket.closed.catch(() => {});
        await Promise.race([
          socket.opened,
          new Promise<never>((_resolve, reject) => {
            controller.signal.addEventListener("abort", () => reject(new Error("TCP timeout")), { once: true });
          }),
        ]);
        success = true;
      } else {
        const response = await fetch(attempt.url, {
          method: "GET",
          signal: controller.signal,
          redirect: "follow",
        });
        success = response.status >= 200 && response.status < 300;
        await response.body?.cancel();
      }
    } catch {
      success = false;
    } finally {
      clearTimeout(timeout);
      if (socket) {
        // Native close can wait for connection establishment past our observation deadline.
        const closing = socket;
        this.ctx.waitUntil(Promise.resolve().then(() => closing.close()).catch(() => {}));
      }
      this.checking.delete(id);
    }
    const current = this.read();
    // Record the executed attempt without overwriting newer configuration.
    const monitor = current.monitors.find(monitor => monitor.id === attempt.id);
    if (!monitor) return;
    monitor.lastResult = { at, outcome: success ? "success" : "failure" };
    monitor.failures = success ? 0 : monitor.failures + 1;
    monitor.successes = success ? monitor.successes + 1 : 0;
    let transition: "opened" | "recovered" | undefined;
    this.ctx.storage.transactionSync(() => {
      const open = this.ctx.storage.sql
        .exec<Incident>(
          "SELECT * FROM incidents WHERE monitorId = ? AND closedAt IS NULL LIMIT 1",
          monitor.id,
        )
        .toArray()[0];
      if (!open && monitor.failures >= attempt.failureThreshold) {
        transition = "opened";
        monitor.state = "down";
        this.ctx.storage.sql.exec(
          "INSERT INTO incidents (id, monitorId, openedAt, monitorName) VALUES (?, ?, ?, ?)",
          crypto.randomUUID(),
          monitor.id,
          at,
          monitor.name,
        );
      } else if (open && monitor.successes >= attempt.recoveryThreshold) {
        this.ctx.storage.sql.exec(
          "UPDATE incidents SET closedAt = ? WHERE id = ?",
          at,
          open.id,
        );
        transition = "recovered";
        monitor.state = "up";
      } else if (!open && success) {
        monitor.state = "up";
      }
      this.ctx.storage.kv.put("context", current);
    });
    // Delivery follows the committed transition; transport failure cannot undo detection.
    if (transition && current.webhookUrl)
      await this.deliverWebhook(current.webhookUrl, monitor.name, transition);
  }

  private async deliverWebhook(
    url: string,
    name: string,
    transition: "opened" | "recovered",
  ) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `${name.replace(/\s+/g, " ")}: Incident ${transition}`,
        }),
        redirect: "manual",
        signal: controller.signal,
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error("Delivery failed");
    } catch {
      console.error(JSON.stringify({ event: "webhook_delivery_failed" }));
    } finally {
      clearTimeout(timeout);
    }
  }

  status(operator = false) {
    const state = this.read();
    const monitors = state.monitors.filter(monitor => operator || monitor.published).map(monitor => ({
      id: monitor.id, name: monitor.name, state: monitor.state, lastResult: monitor.lastResult,
      ...(operator ? {
        kind: monitor.kind,
        ...(monitor.kind === "tcp" ? { hostname: monitor.hostname, port: monitor.port } : { url: monitor.url }),
        published: monitor.published,
        intervalSeconds: monitor.intervalSeconds, timeoutSeconds: monitor.timeoutSeconds,
        failureThreshold: monitor.failureThreshold, recoveryThreshold: monitor.recoveryThreshold,
      } : {}),
    }));
    return {
      ...(operator ? { webhookUrl: state.webhookUrl ?? null } : {}),
      pageName: state.pageName,
      monitors,
      monitor: monitors[0] ?? null,
      incidents: this.ctx.storage.sql
        .exec<Incident>("SELECT * FROM incidents ORDER BY openedAt DESC, id")
        .toArray().filter(incident => operator || monitors.some(monitor => monitor.id === incident.monitorId)),
    };
  }
}

async function authorized(request: Request, secret: string | undefined) {
  if (!secret) return false;
  const encoder = new TextEncoder();
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest(
      "SHA-256",
      encoder.encode(request.headers.get("Authorization") ?? ""),
    ),
    crypto.subtle.digest("SHA-256", encoder.encode(`Bearer ${secret}`)),
  ]);
  return crypto.subtle.timingSafeEqual(actual, expected);
}

function parseConfiguration(value: unknown): Configuration | null {
  if (!value || typeof value !== "object") return null;
  const { pageName, name, url, kind = "http", hostname, port } = value as Record<string, unknown>;
  if (
    typeof pageName !== "string" || !pageName.trim() || pageName.length > 120 ||
    typeof name !== "string" || !name.trim() || name.length > 120
  ) return null;
  try {
    let target: Target;
    if (kind === "tcp") {
      if (typeof hostname !== "string" || !hostname || hostname.length > 253 ||
          !Number.isInteger(port) || typeof port !== "number" || port < 1 || port > 65535)
        return null;
      const host = hostname.toLowerCase();
      if (host.includes(":")) {
        if (host.startsWith("[") && !host.endsWith("]")) return null;
        const literal = host.startsWith("[") ? host.slice(1, -1) : host;
        if (!/^[0-9a-f:.]+$/.test(literal)) return null;
        const parsed = new URL(`http://[${literal}]/`);
        target = { kind, hostname: parsed.hostname.slice(1, -1), port, url: undefined };
      } else {
        if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?$/.test(host))
          return null;
        target = { kind, hostname: host, port, url: undefined };
      }
    } else if (kind === "http") {
      if (typeof url !== "string" || url.length > 2048) return null;
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
        return null;
      parsed.hash = "";
      target = { kind, url: parsed.href, hostname: undefined, port: undefined };
    } else return null;
    const timing: Partial<Timing> = {};
    for (const key of Object.keys(timingDefaults) as (keyof Timing)[]) {
      if (!(key in value)) continue;
      const input = (value as Record<string, unknown>)[key];
      const [min, max] = timingBounds[key];
      if (typeof input !== "number" || !Number.isInteger(input) || input < min || input > max)
        return null;
      timing[key] = input;
    }
    return { pageName: pageName.trim(), name: name.trim(), ...target, ...timing };
  } catch {
    return null;
  }
}

function parseMonitorPatch(value: unknown, current?: MonitorConfiguration): Partial<MonitorConfiguration> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  if (!Object.keys(fields).length || Object.keys(fields).some(key => !["name", "kind", "url", "hostname", "port", "published", ...Object.keys(timingDefaults)].includes(key))) return null;
  if ("published" in fields && typeof fields.published !== "boolean") return null;
  const configuration = parseConfiguration({ pageName: "Irisbeat", name: "Monitor", url: "https://example.com", ...current, ...fields });
  if (!configuration) return null;
  const patch: Record<string, unknown> = {};
  for (const key of ["name", "published", ...Object.keys(timingDefaults)]) {
    if (key in fields) patch[key] = key === "published" ? fields[key] : configuration[key as keyof Configuration];
  }
  if (["kind", "url", "hostname", "port"].some(key => key in fields)) {
    Object.assign(patch, configuration.kind === "tcp"
      ? { kind: "tcp", hostname: configuration.hostname, port: configuration.port, url: undefined }
      : { kind: "http", url: configuration.url, hostname: undefined, port: undefined });
  }
  return patch as Partial<MonitorConfiguration>;
}

function parseWebhook(value: unknown): string | null | undefined {
  if (value === "") return null;
  if (typeof value !== "string" || value.length > 2048 || /\s/.test(value))
    return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
      return undefined;
    const discordPath = url.pathname.match(
      /^(\/api(?:\/v\d+)?\/webhooks\/[^/]+\/[^/]+)(?:\/slack)?\/?$/,
    );
    if (
      /^(?:(?:canary|ptb)\.)?discord(?:app)?\.com$/.test(url.hostname) &&
      discordPath
    ) {
      url.pathname = discordPath[1] + "/slack";
      return url.href;
    }
    return value;
  } catch {
    return undefined;
  }
}

export default {
  async scheduled(controller, env) {
    await env.MONITORING.getByName("personal").check(controller.scheduledTime);
  },
  async fetch(request, env) {
    try {
      const response = await handleRequest(request, env);
      response.headers.set("Cache-Control", "no-store");
      response.headers.set("X-Content-Type-Options", "nosniff");
      response.headers.set("Referrer-Policy", "no-referrer");
      response.headers.set(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      );
      return response;
    } catch {
      console.error(
        JSON.stringify({
          event: "request_failed",
          path: new URL(request.url).pathname,
        }),
      );
      return Response.json(
        { error: "Internal server error" },
        { status: 500, headers: { "Cache-Control": "no-store" } },
      );
    }
  },
} satisfies ExportedHandler<Env>;

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  const context = env.MONITORING.getByName("personal");
  if (request.method === "GET") {
    if (path === "/")
      return new Response(statusPage(await context.status()), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    if (path === "/operator")
      return new Response(operatorPage(), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    if (path === "/app.css")
      return new Response(styleSheet, {
        headers: { "Content-Type": "text/css; charset=utf-8" },
      });
    if (path === "/operator.js")
      return new Response(operatorScript, {
        headers: { "Content-Type": "text/javascript; charset=utf-8" },
      });
  }
  const monitorMatch = path.match(/^\/api\/operator\/monitors\/([^/]+)$/);
  if (path === "/api/operator" || path === "/api/operator/webhook" || path === "/api/operator/monitors" || monitorMatch) {
    if (!(await authorized(request, env.INSTALLATION_SECRET)))
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (monitorMatch && request.method === "DELETE") {
      const result = await context.remove(monitorMatch[1]);
      return result ? Response.json(result) : Response.json({ error: "Monitor not found" }, { status: 404 });
    }
    if (request.method === "GET" && !monitorMatch)
      return Response.json(await context.status(true));
    if (((path === "/api/operator" || path === "/api/operator/webhook") && request.method === "PUT") ||
        (path === "/api/operator/monitors" && request.method === "POST") ||
        (monitorMatch && request.method === "PATCH")) {
      if (!request.headers.get("Content-Type")?.startsWith("application/json"))
        return Response.json(
          { error: "Use application/json" },
          { status: 415 },
        );
      if (Number(request.headers.get("Content-Length")) > 4096)
        return new Response(null, { status: 413 });
      let value: unknown;
      const reader = request.body?.getReader();
      let body = "";
      let bytes = 0;
      const decoder = new TextDecoder();
      if (reader) {
        try {
          while (true) {
            const { done, value: chunk } = await reader.read();
            if (done) break;
            bytes += chunk.byteLength;
            if (bytes > 4096) {
              await reader.cancel();
              return new Response(null, { status: 413 });
            }
            body += decoder.decode(chunk, { stream: true });
          }
          body += decoder.decode();
        } finally {
          reader.releaseLock();
        }
      }
      try {
        value = JSON.parse(body);
      } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }
      if (path === "/api/operator/webhook") {
        const url = value && typeof value === "object"
          ? (value as Record<string, unknown>).url
          : undefined;
        const destination = parseWebhook(url);
        if (destination === undefined)
          return Response.json(
            { error: "Enter an HTTPS webhook URL" },
            { status: 400 },
          );
        return Response.json(await context.configureWebhook(destination));
      }
      if (monitorMatch) {
        const result = await context.edit(monitorMatch[1], value);
        if (result === undefined) return Response.json({ error: "Enter valid Monitor settings and an HTTP(S) or TCP target" }, { status: 400 });
        return result ? Response.json(result) : Response.json({ error: "Monitor not found" }, { status: 404 });
      }
      if (path === "/api/operator" && value && typeof value === "object" &&
          Object.keys(value).length === 1 && "pageName" in value) {
        const pageName = value.pageName;
        if (typeof pageName !== "string" || !pageName.trim() || pageName.length > 120)
          return Response.json({ error: "Enter a page name" }, { status: 400 });
        return Response.json(await context.configure({ pageName: pageName.trim() }));
      }
      if (path === "/api/operator/monitors") {
        const fields = value as Record<string, unknown>;
        const configuration = parseConfiguration({ ...fields, pageName: "Irisbeat" });
        if (!parseMonitorPatch(value) || !configuration)
          return Response.json({ error: "Enter a Monitor name and HTTP(S) or TCP target" }, { status: 400 });
        const { pageName: _pageName, ...settings } = configuration;
        return Response.json(await context.create({ ...settings, published: fields.published as boolean | undefined }), { status: 201 });
      }
      const configuration = parseConfiguration(value);
      if (!configuration)
        return Response.json({ error: "Enter a page name, Monitor name and HTTP(S) or TCP target" }, { status: 400 });
      return Response.json(await context.configure(configuration));
    }
    return new Response(null, { status: 405, headers: { Allow: monitorMatch ? "PATCH, DELETE" : path === "/api/operator/monitors" ? "GET, POST" : "GET, PUT" } });
  }
  if (path === "/api/status" && request.method === "GET")
    return Response.json(await context.status());
  return new Response("Not found", { status: 404 });
}
