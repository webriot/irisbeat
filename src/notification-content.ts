// SPDX-License-Identifier: AGPL-3.0-only
import type { NotificationEvent } from "./notification-jobs";

export function notificationName(event: NotificationEvent) {
  return event.monitorName.replace(/\s+/g, " ").replace(/[\p{Cc}\p{Bidi_Control}]/gu, "");
}

export function describeNotification(event: NotificationEvent) {
  const iso = (at: number) => new Date(at).toISOString();
  let summary: string;
  let details: string[] = [];
  switch (event.kind) {
    case "incident.opened":
      summary = "Incident opened";
      break;
    case "incident.recovered":
      summary = "Incident recovered";
      details = ["Opened " + iso(event.openedAt)];
      break;
    case "maintenance.started":
      summary = "Maintenance started";
      details = ["Scheduled end " + iso(event.endsAt)];
      break;
    case "maintenance.updated":
      summary = "Maintenance end time changed";
      details = ["Previous end " + iso(event.previousEndsAt), "Scheduled end " + iso(event.endsAt)];
      break;
    case "maintenance.ended":
      summary = event.reason === "early" ? "Maintenance ended early" : "Maintenance expired";
      details = ["Started " + iso(event.startedAt)];
      if (event.reason === "early") details.push("Scheduled end " + iso(event.endsAt));
      break;
  }
  return { summary, lines: [iso(event.at), ...details] };
}
