// SPDX-License-Identifier: AGPL-3.0-only
export type NotificationDeliveryIdentity = {
  contextId: string;
  destinationId: string;
  deliveryId: string;
};

export type TransportOutcome =
  | { status: "accepted" }
  | { status: "temporary"; reason: "network" | "rate_limited" | "provider_unavailable" }
  | { status: "permanent"; reason: "provider_rejected" };

export type ExhaustionReason = "expired" | "attempts_exhausted";
export type SubmissionOutcome =
  | { status: "accepted" }
  | { status: "canceled" }
  | { status: "retrying"; reason: Extract<TransportOutcome, { status: "temporary" }>["reason"] | "eligibility_unavailable" }
  | { status: "failed"; reason: Extract<TransportOutcome, { status: "permanent" }>["reason"] | ExhaustionReason };
export type SubmissionResult = SubmissionOutcome & { at: number };

export type SubmissionReport = {
  eventAt: number;
  queuedAt: number;
  attempt: number;
  result: SubmissionResult;
};

export type DeadLetter = NotificationDeliveryIdentity & {
  queuedAt: number;
  attempts: number;
  reason: ExhaustionReason;
};
