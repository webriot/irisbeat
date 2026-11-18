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

export type NotificationJob = NotificationSelection & {
  contextId: string;
  monitorId: string;
  pauseGeneration: number;
  deliveryId: string;
  event: {
    id: string;
    kind: "incident.opened" | "incident.recovered";
    at: number;
    incidentId: string;
    openedAt: number;
    monitorName: string;
  };
};
