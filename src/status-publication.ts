// SPDX-License-Identifier: AGPL-3.0-only
import type { Status } from "./index";
import { renderViewPartial, renderViewSnapshot, statusPage } from "./ui";
import type { ViewScope } from "./view-changes";

export type StatusResource = "/" | "/api/status" | "snapshot" | ViewScope;
export type StatusRender = { body: string; contentType: string };
export const HTML = "text/html; charset=utf-8";

export function statusRenderInterval(value: string | undefined) {
  if (value === undefined) return 60_000;
  if (typeof value !== "string" || !/^\d+$/.test(value) || Number(value) > 86_400) {
    console.error(JSON.stringify({ event: "invalid_status_render_interval", binding: "STATUS_RENDER_INTERVAL_SECONDS" }));
    throw new Error("STATUS_RENDER_INTERVAL_SECONDS must be an integer from 0 to 86400");
  }
  return Number(value) * 1000;
}

export function statusWindowEnd(now: number, interval: number) {
  return now - now % interval + interval;
}

export function renderStatus(resource: StatusResource, data: Status, revision: number): StatusRender {
  if (resource === "/") return { body: statusPage(data), contentType: HTML };
  const row = resource.startsWith("monitor/") ? resource.slice("monitor/".length) : null;
  const body = resource === "/api/status" ? data : resource === "snapshot" ? renderViewSnapshot(data, "public", false) : {
    revision,
    ...renderViewPartial(resource, row === null ? data : {
      ...data, monitors: data.monitors.filter(monitor => monitor.id === row),
    }, "public", false),
  };
  return { body: JSON.stringify(body), contentType: "application/json" };
}

export async function readEdge(key: Request) {
  try { return await caches.default.match(key); }
  catch { return undefined; }
}

export async function writeEdge(key: Request, render: StatusRender, ttl: number, revision = 0) {
  if (ttl < 1) return;
  try {
    await caches.default.put(key, new Response(render.body, { headers: {
      "Content-Type": render.contentType,
      "Cache-Control": `public, max-age=${ttl}`,
      "X-Irisbeat-Revision": String(revision),
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
