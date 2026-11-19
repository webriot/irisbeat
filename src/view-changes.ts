// SPDX-License-Identifier: AGPL-3.0-only
import type { Monitor } from "./monitor-configuration";

export type ViewAudience = "public" | "reader" | "editor";
export type ViewScope = "page" | "banner" | "monitors" | "incidents" | "destinations" | `monitor/${string}`;
export type ViewHint = { type: "changed"; revision: number; scopes: ViewScope[] };
export type ViewChanges = Partial<Record<ViewAudience, ViewScope[]>>;

export function sharedScopes(...scopes: ViewScope[]): ViewChanges {
  return { public: scopes, reader: scopes, editor: scopes };
}

export function monitorScopes(monitor: Monitor, ...scopes: ViewScope[]): ViewChanges {
  const operator = scopes.filter(scope => scope !== "banner");
  return { public: monitor.published ? scopes : [], reader: operator, editor: operator };
}

export function configurationScopes(previous: Monitor | undefined, current: Monitor | undefined, pageChanged: boolean): ViewChanges {
  const page: ViewScope[] = pageChanged ? ["page"] : [];
  const monitor = current ?? previous;
  if (!monitor) return sharedScopes(...page);
  const row = `monitor/${monitor.id}` as const;
  if (!previous || !current) {
    const operator: ViewScope[] = [...page, "monitors"];
    if (previous) operator.push("incidents");
    return {
      public: monitor.published ? [...page, "monitors", "banner", "incidents"] : page,
      reader: operator,
      editor: previous?.notificationSelections?.length ? [...operator, "destinations"] : operator,
    };
  }
  const renamed = current.name !== previous.name;
  const publication = current.published !== previous.published;
  const rowChanged = (["name", "published", "url", "hostname", "port", "scheduleMode", "cron", "timezone",
    "intervalSeconds", "timeoutSeconds", "failureThreshold", "recoveryThreshold", "silenceSeconds",
    "recoverySpacingSeconds", "graceSeconds"] as const).some(key => previous[key] !== current[key]) ||
    (previous.outboundCalendarFloor?.compatible === false) !== (current.outboundCalendarFloor?.compatible === false);
  const previousIds = previous.notificationSelections?.map(selection => selection.destinationId) ?? [];
  const currentIds = current.notificationSelections?.map(selection => selection.destinationId) ?? [];
  const selectionsChanged = previousIds.length !== currentIds.length || previousIds.some((id, index) => id !== currentIds[index]);
  const reader = rowChanged ? [...page, row, ...(renamed ? ["incidents" as const] : [])] : page;
  const editor: ViewScope[] = [...reader];
  if (selectionsChanged) {
    if (!rowChanged) editor.push(row);
    editor.push("destinations");
  }
  const publicScopes: ViewScope[] = [...page];
  if (publication) publicScopes.push("monitors", "banner", "incidents");
  else if (renamed && current.published) publicScopes.push(row, "incidents");
  return { public: publicScopes, reader, editor };
}

export function mergeScopes(scopes: ViewScope[], more: ViewScope[]): ViewScope[] {
  const merged = [...new Set([...scopes, ...more])];
  if (merged.filter(scope => scope.startsWith("monitor/")).length > 32) merged.push("monitors");
  return merged.includes("monitors") ? [...new Set(merged.filter(scope => !scope.startsWith("monitor/")))] : merged;
}
