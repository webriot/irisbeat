// SPDX-License-Identifier: AGPL-3.0-only
export type TransportOutcome =
  | { status: "accepted" }
  | { status: "temporary"; reason: "network" | "rate_limited" | "provider_unavailable" }
  | { status: "permanent"; reason: "provider_rejected" };
