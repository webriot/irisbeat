// SPDX-License-Identifier: AGPL-3.0-only
import { operatorPage, operatorScript, statusPage, styleSheet } from "./ui";
import { DurableObject } from "cloudflare:workers";

const timingDefaults = {
  intervalSeconds: 60,
  timeoutSeconds: 10,
  failureThreshold: 2,
  recoveryThreshold: 2,
  silenceSeconds: 180,
  recoverySpacingSeconds: 60,
};
const timingBounds = {
  intervalSeconds: [60, 86_400],
  timeoutSeconds: [1, 60],
  failureThreshold: [1, 100],
  recoveryThreshold: [1, 100],
  silenceSeconds: [60, 86_400],
  recoverySpacingSeconds: [60, 86_400],
} as const;
type Timing = typeof timingDefaults;
type Configuration = { pageName: string; name: string; url: string; kind: "http" | "heartbeat" } & Partial<Timing>;
export type Incident = {
  id: string;
  monitorId: string;
  openedAt: number;
  closedAt: number | null;
};
type CheckResult = { at: number; outcome: "success" | "failure" };
type Monitor = Configuration & Timing & {
  id: string;
  state: "unknown" | "up" | "down";
  lastResult: CheckResult | null;
  failures: number;
  successes: number;
  nextDue: number;
  createdAt: number;
  lastSeen: number | null;
  recoveryReceiptAt: number | null;
};
export type Status = ReturnType<MonitoringContext["status"]>;
type StoredContext = { monitor: Monitor | null; webhookUrl?: string | null };

export class MonitoringContext extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS incidents (
      id TEXT PRIMARY KEY, monitorId TEXT NOT NULL, openedAt INTEGER NOT NULL, closedAt INTEGER
    )`);
  }
  private read(): StoredContext {
    const state = this.ctx.storage.kv.get<StoredContext>("context") ?? { monitor: null };
    if (state.monitor) state.monitor = { ...timingDefaults, ...state.monitor };
    return state;
  }

  configure(configuration: Configuration) {
    const state = this.read();
    state.monitor = {
      ...timingDefaults,
      ...state.monitor,
      ...configuration,
      id: "website",
      createdAt: state.monitor?.createdAt ?? Date.now(),
      lastSeen: state.monitor?.lastSeen ?? null,
      recoveryReceiptAt: state.monitor?.recoveryReceiptAt ?? null,
      state: state.monitor?.state ?? "unknown",
      lastResult: state.monitor?.lastResult ?? null,
      failures: state.monitor?.failures ?? 0,
      successes: state.monitor?.successes ?? 0,
      // Keep the last dispatch as the anchor when the interval changes.
      nextDue: state.monitor?.nextDue
        ? state.monitor.nextDue + ((configuration.intervalSeconds ?? state.monitor.intervalSeconds) - state.monitor.intervalSeconds) * 1000
        : 0,
    };
    this.ctx.storage.kv.put("context", state);
    return this.status(true);
  }

  configureWebhook(url: string | null) {
    const state = this.read();
    state.webhookUrl = url;
    this.ctx.storage.kv.put("context", state);
    return this.status(true);
  }

  private checking = false;

  async check(at: number) {
    const state = this.read();
    const attempt = state.monitor;
    if (attempt?.kind === "heartbeat") {
      if (at >= (attempt.lastSeen ?? attempt.createdAt) + attempt.silenceSeconds * 1000) {
        attempt.recoveryReceiptAt = null;
        await this.record(state, attempt, at, false, 1, attempt.recoveryThreshold);
      }
      return;
    }
    if (!attempt || this.checking || at < attempt.nextDue) return;
    this.checking = true;
    attempt.nextDue = at + attempt.intervalSeconds * 1000;
    this.ctx.storage.kv.put("context", state);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), attempt.timeoutSeconds * 1000);
    let success = false;
    try {
      const response = await fetch(attempt.url, {
        method: "GET",
        signal: controller.signal,
        redirect: "follow",
      });
      success = response.status >= 200 && response.status < 300;
      await response.body?.cancel();
    } catch {
      success = false;
    } finally {
      clearTimeout(timeout);
      this.checking = false;
    }
    const current = this.read();
    // Record the executed attempt without overwriting newer configuration.
    const monitor = current.monitor;
    if (!monitor) return;
    await this.record(current, monitor, at, success, attempt.failureThreshold, attempt.recoveryThreshold);
  }

  private async record(current: StoredContext, monitor: Monitor, at: number, success: boolean, failureThreshold: number, recoveryThreshold: number) {
    monitor.lastResult = { at, outcome: success ? "success" : "failure" };
    monitor.failures = success ? 0 : monitor.failures + 1;
    monitor.successes = success ? monitor.successes + 1 : 0;
    let transition: "opened" | "recovered" | undefined;
    this.ctx.storage.transactionSync(() => {
      const open = this.ctx.storage.sql
        .exec<Incident>(
          "SELECT * FROM incidents WHERE closedAt IS NULL LIMIT 1",
        )
        .toArray()[0];
      if (!open && monitor.failures >= failureThreshold) {
        transition = "opened";
        monitor.state = "down";
        this.ctx.storage.sql.exec(
          "INSERT INTO incidents (id, monitorId, openedAt) VALUES (?, ?, ?)",
          crypto.randomUUID(),
          monitor.id,
          at,
        );
      } else if (open && monitor.successes >= recoveryThreshold) {
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
      current.monitor = monitor;
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

  async heartbeat(id: string, at: number) {
    const current = this.read();
    const monitor = current.monitor;
    if (!monitor || monitor.id !== id || monitor.kind !== "heartbeat") return false;
    monitor.lastSeen = at;
    if (monitor.state !== "down" || monitor.recoveryReceiptAt === null ||
        at >= monitor.recoveryReceiptAt + monitor.recoverySpacingSeconds * 1000) {
      monitor.recoveryReceiptAt = at;
      await this.record(current, monitor, at, true, 1, monitor.recoveryThreshold);
    } else {
      this.ctx.storage.kv.put("context", current);
    }
    return true;
  }

  status(operator = false) {
    const state = this.read();
    return {
      ...(operator ? { webhookUrl: state.webhookUrl ?? null } : {}),
      pageName: state.monitor?.pageName ?? "Irisbeat",
      monitor: state.monitor
        ? {
            id: state.monitor.id,
            name: state.monitor.name,
            kind: state.monitor.kind ?? "http",
            ...(state.monitor.kind === "heartbeat" ? { lastSeen: state.monitor.lastSeen } : {}),
            state: state.monitor.state,
            lastResult: state.monitor.lastResult,
            ...(operator ? {
              url: state.monitor.url,
              intervalSeconds: state.monitor.intervalSeconds,
              timeoutSeconds: state.monitor.timeoutSeconds,
              failureThreshold: state.monitor.failureThreshold,
              recoveryThreshold: state.monitor.recoveryThreshold,
              silenceSeconds: state.monitor.silenceSeconds,
              recoverySpacingSeconds: state.monitor.recoverySpacingSeconds,
            } : {}),
          }
        : null,
      incidents: this.ctx.storage.sql
        .exec<Incident>("SELECT * FROM incidents ORDER BY openedAt DESC, id")
        .toArray(),
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

function parseConfiguration(value: unknown, existingKind: Configuration["kind"] = "http"): Configuration | null {
  if (!value || typeof value !== "object") return null;
  const { pageName, name, url, kind = existingKind } = value as Record<string, unknown>;
  if (
    typeof pageName !== "string" ||
    !pageName.trim() ||
    pageName.length > 120 ||
    typeof name !== "string" ||
    !name.trim() ||
    name.length > 120 ||
    (kind !== "http" && kind !== "heartbeat") ||
    (kind !== "heartbeat" && (typeof url !== "string" || url.length > 2048))
  )
    return null;
  try {
    const target = kind === "http" ? new URL(url as string) : null;
    if (
      target && (!["http:", "https:"].includes(target.protocol) ||
      target.username ||
      target.password)
    )
      return null;
    if (target) target.hash = "";
    const timing: Partial<Timing> = {};
    for (const key of Object.keys(timingDefaults) as (keyof Timing)[]) {
      if (!(key in value)) continue;
      const input = (value as Record<string, unknown>)[key];
      const [min, max] = timingBounds[key];
      if (typeof input !== "number" || !Number.isInteger(input) || input < min || input > max)
        return null;
      timing[key] = input;
    }
    return { pageName: pageName.trim(), name: name.trim(), url: target?.href ?? "", kind: kind as Configuration["kind"], ...timing };
  } catch {
    return null;
  }
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
  if (path.startsWith("/heartbeat/")) {
    if (!(await authorized(request, env.INSTALLATION_SECRET)))
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (request.method !== "POST")
      return new Response(null, { status: 405, headers: { Allow: "POST" } });
    const accepted = await context.heartbeat(path.slice("/heartbeat/".length), Date.now());
    return new Response(null, { status: accepted ? 204 : 404 });
  }
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
  if (path === "/api/operator" || path === "/api/operator/webhook") {
    if (!(await authorized(request, env.INSTALLATION_SECRET)))
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (request.method === "GET")
      return Response.json(await context.status(true));
    if (request.method === "PUT") {
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
      const existing = (await context.status(true)).monitor;
      const configuration = parseConfiguration(value, existing?.kind);
      if (!configuration || (existing && configuration.kind !== existing.kind))
        return Response.json(
          {
            error:
              "Enter names and a valid Monitor kind (unchanged on edits). HTTP requires a credential-free HTTP(S) URL. Use integer seconds: interval, silence and recovery spacing 60–86400; timeout 1–60; thresholds 1–100",
          },
          { status: 400 },
        );
      return Response.json(await context.configure(configuration));
    }
    return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });
  }
  if (path === "/api/status" && request.method === "GET")
    return Response.json(await context.status());
  return new Response("Not found", { status: 404 });
}
