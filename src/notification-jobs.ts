// SPDX-License-Identifier: AGPL-3.0-only
export type NewNotificationDestination = {
  channel: "webhook";
  url: string;
} | {
  channel: "email";
  address: string;
};

export type NotificationDestination = { id: string } & (
  Extract<NewNotificationDestination, { channel: "webhook" }> |
  (Extract<NewNotificationDestination, { channel: "email" }> & { confirmed: boolean })
);

export function selectableDestination(destination: NotificationDestination) {
  return destination.channel === "webhook" || destination.confirmed;
}

export function parseEmailAddress(value: unknown) {
  if (typeof value !== "string" || value.length > 254) return null;
  const parts = value.trim().split("@");
  const [local, domain] = parts;
  if (parts.length !== 2 || local.length > 64 ||
      !/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:[.][a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i.test(local) ||
      !domain.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return null;
  return local + "@" + domain.toLowerCase();
}

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


export type ConfirmationJob = {
  kind: "email.confirmation";
  contextId: string;
  destinationId: string;
  deliveryId: string;
  pauseGeneration: number;
  at: number;
};

export type NotificationQueueJob = NotificationJob | ConfirmationJob;
