// SPDX-License-Identifier: AGPL-3.0-only
import { renderViewPartial, renderViewSnapshot, statusJson, statusPage, type StatusProjection } from "./ui";
import type { ViewScope } from "./view-changes";

export type StatusResource = "/" | "/api/status" | "snapshot" | ViewScope;
export type StatusRequest = StatusResource | ViewScope[];
export type StatusRender = { body: string; contentType: string };
export const HTML = "text/html; charset=utf-8";

export function statusRenderInterval(value: string | undefined) {
  if (value === undefined) return 60_000;
  if (typeof value !== "string" || !/^\d+$/.test(value) || Number(value) > 86_400) {
    console.error(JSON.stringify({ event: "invalid_status_render_interval", binding: "STATUS_RENDER_INTERVAL_SECONDS" }));
    return 60_000;
  }
  return Number(value) * 1000;
}

export function statusWindowEnd(now: number, interval: number) {
  return now - now % interval + interval;
}

function renderPublicPartial(scope: ViewScope, data: StatusProjection) {
  if (!scope.startsWith("monitor/")) return renderViewPartial(scope, data, "public", false);
  const id = scope.slice("monitor/".length);
  return renderViewPartial(scope, { ...data, monitors: data.monitors.filter(monitor => monitor.id === id) }, "public", false);
}

export function renderStatus(resource: StatusRequest, data: StatusProjection, revision: number): StatusRender {
  if (resource === "/") return { body: statusPage(data), contentType: HTML };
  if (Array.isArray(resource)) return {
    body: JSON.stringify({ revision, partials: resource.map(scope => ({ scope, ...renderPublicPartial(scope, data) })) }),
    contentType: "application/json",
  };
  const body = resource === "/api/status" ? statusJson(data) : resource === "snapshot" ? renderViewSnapshot(data, "public", false) : {
    revision,
    ...renderPublicPartial(resource, data),
  };
  return { body: JSON.stringify(body), contentType: "application/json" };
}

export async function readEdge(key: Request) {
  try { return await caches.default.match(key); }
  catch { return undefined; }
}

export async function writeEdge(key: Request, render: StatusRender, ttl: number) {
  if (ttl < 1) return;
  try {
    await caches.default.put(key, new Response(render.body, { headers: {
      "Content-Type": render.contentType,
      "Cache-Control": `public, max-age=${ttl}`,
    } }));
  } catch {
    // A regional cache failure must not make a published resource unavailable.
  }
}

export function renderResponse(render: StatusRender) {
  return new Response(render.body, { headers: { "Content-Type": render.contentType } });
}

export function cachedRenderResponse(response: Response) {
  return new Response(response.body, { headers: { "Content-Type": response.headers.get("Content-Type")! } });
}
