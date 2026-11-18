// SPDX-License-Identifier: AGPL-3.0-only
export type NotificationDestination = {
  id: string;
  channel: "webhook";
  url: string;
};

export type NotificationSelection = {
  destinationId: string;
  generation: string;
};

type EventIdentity = {
  id: string;
  at: number;
  monitorName: string;
};

export type MaintenanceNotificationEvent = EventIdentity & {
  startedAt: number;
  endsAt: number;
} & (
  | { kind: "maintenance.started" }
  | { kind: "maintenance.updated"; previousEndsAt: number }
  | { kind: "maintenance.ended"; reason: "early" | "expired" }
);

export type NotificationEvent = MaintenanceNotificationEvent | (EventIdentity & {
  kind: "incident.opened" | "incident.recovered";
  incidentId: string;
  openedAt: number;
});

export type NotificationJob = NotificationSelection & {
  contextId: string;
  monitorId: string;
  pauseGeneration: number;
  deliveryId: string;
  event: NotificationEvent;
};
