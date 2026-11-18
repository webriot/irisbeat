// SPDX-License-Identifier: AGPL-3.0-only
import type {
  ExhaustionReason, NotificationDeliveryIdentity, NotificationOutcomeMessage, SubmissionOutcome, TransportOutcome,
} from "./notification-outcomes";
import type { NotificationRecovery } from "./notification-recovery";

const MAX_ATTEMPTS = 10;
const MAX_AGE = 60 * 60 * 1000;

const RECOVERY_RETRY = { delaySeconds: 5 };

export type RecoveryBindings = {
  NOTIFICATION_RECOVERY: DurableObjectNamespace<NotificationRecovery>;
  NOTIFICATION_OUTCOMES: Pick<Queue<NotificationOutcomeMessage>, "send">;
};

function recovery(bindings: RecoveryBindings, identity: NotificationDeliveryIdentity) {
  return bindings.NOTIFICATION_RECOVERY.getByName(JSON.stringify(identity));
}

function persist(bindings: RecoveryBindings, { identity, submissionReport, exhaustion }: NotificationOutcomeMessage) {
  const { queuedAt, attempt } = submissionReport;
  return recovery(bindings, identity).record(identity, submissionReport,
    exhaustion && { ...identity, queuedAt, attempts: attempt, reason: exhaustion });
}

export async function recoverNotificationOutcome(
  message: Message<unknown>, outcome: NotificationOutcomeMessage, bindings: RecoveryBindings,
) {
  try {
    await persist(bindings, outcome);
    message.ack();
  } catch {
    console.error(JSON.stringify({ event: "notification_outcome_persistence_failed" }));
    message.retry(RECOVERY_RETRY);
  }
}

export async function deliverNotification<Job extends NotificationDeliveryIdentity, Destination>(
  message: Message<unknown>,
  job: Job,
  eventAt: number,
  bindings: RecoveryBindings,
  resolve: (job: Job) => Promise<Destination | null>,
  submit: (destination: Destination, job: Job) => Promise<TransportOutcome>,
) {
  const { attempts, timestamp } = message;
  const queuedAt = timestamp.getTime();
  const expiresAt = queuedAt + MAX_AGE;
  const identity = { contextId: job.contextId, destinationId: job.destinationId, deliveryId: job.deliveryId };
  const outcomeMessage = (result: SubmissionOutcome, at: number): NotificationOutcomeMessage => ({
    identity, submissionReport: { eventAt, queuedAt, attempt: attempts, result: { ...result, at } },
  });
  const finish = async (result: Exclude<SubmissionOutcome, { status: "retrying" }>, at: number, exhaustion?: ExhaustionReason) => {
    const outcome = outcomeMessage(result, at);
    if (exhaustion) outcome.exhaustion = exhaustion;
    try {
      await persist(bindings, outcome);
    } catch {
      console.error(JSON.stringify({ event: "notification_outcome_persistence_failed" }));
      try {
        // A new broker message can recover the outcome even on the source's last delivery.
        await bindings.NOTIFICATION_OUTCOMES.send(outcome);
      } catch {
        console.error(JSON.stringify({ event: "notification_outcome_enqueue_failed" }));
        return message.retry(RECOVERY_RETRY);
      }
    }
    message.ack();
  };
  const exhaust = (reason: ExhaustionReason, at: number) => finish({ status: "failed", reason }, at, reason);
  const retry = async (reason: Extract<SubmissionOutcome, { status: "retrying" }>["reason"], at: number) => {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) return exhaust("expired", at);
    if (attempts >= MAX_ATTEMPTS) return exhaust("attempts_exhausted", at);
    try {
      await persist(bindings, outcomeMessage({ status: "retrying", reason }, at));
    } catch {
      console.error(JSON.stringify({ event: "notification_outcome_persistence_failed" }));
    }
    message.retry({ delaySeconds: Math.min(5 * 2 ** (attempts - 1), Math.ceil(remaining / 1000)) });
  };

  let destination;
  try {
    if (!await recovery(bindings, identity).begin(attempts)) return message.ack();
    destination = await resolve(job);
  } catch {
    return retry("eligibility_unavailable", Date.now());
  }
  if (destination === null) {
    if (attempts > 1) return finish({ status: "canceled" }, Date.now());
    return message.ack();
  }

  const at = Date.now();
  if (at >= expiresAt) return exhaust("expired", at);
  if (attempts > MAX_ATTEMPTS) return exhaust("attempts_exhausted", at);
  let outcome;
  try {
    outcome = await submit(destination, job);
  } catch {
    return retry("network", at);
  }
  if (outcome.status === "temporary") return retry(outcome.reason, at);
  if (outcome.status === "permanent") {
    console.error(JSON.stringify({ event: "notification_submission_failed", reason: outcome.reason }));
    return finish({ status: "failed", reason: outcome.reason }, at);
  }
  return finish(outcome, at);
}
