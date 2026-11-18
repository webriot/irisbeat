// SPDX-License-Identifier: AGPL-3.0-only
import type {
  DeadLetter, ExhaustionReason, NotificationDeliveryIdentity, SubmissionOutcome, SubmissionReport, TransportOutcome,
} from "./notification-outcomes";

const MAX_ATTEMPTS = 10;
const MAX_AGE = 60 * 60 * 1000;

export async function deliverNotification<Job extends NotificationDeliveryIdentity, Destination>(
  message: Message<Job>,
  eventAt: number,
  bindings: {
    NOTIFICATION_DELIVERY: { reportSubmission(job: NotificationDeliveryIdentity, report: SubmissionReport): Promise<void> };
    NOTIFICATION_DLQ: Pick<Queue<DeadLetter>, "send">;
  },
  resolve: (job: Job) => Promise<Destination | null>,
  submit: (destination: Destination, job: Job) => Promise<TransportOutcome>,
) {
  const { body: job, attempts, timestamp } = message;
  const queuedAt = timestamp.getTime();
  const expiresAt = queuedAt + MAX_AGE;
  const identity = { contextId: job.contextId, destinationId: job.destinationId, deliveryId: job.deliveryId };
  const report = async (result: SubmissionOutcome, at: number) => {
    try {
      await bindings.NOTIFICATION_DELIVERY.reportSubmission(identity, { eventAt, queuedAt, attempt: attempts, result: { ...result, at } });
    } catch {
      // A reporting outage must never repeat a known provider outcome.
      console.error(JSON.stringify({ event: "notification_submission_report_failed" }));
    }
  };
  const exhaust = async (reason: ExhaustionReason, at: number) => {
    try {
      await bindings.NOTIFICATION_DLQ.send({ ...identity, queuedAt, attempts, reason });
    } catch {
      console.error(JSON.stringify({ event: "notification_dead_letter_failed" }));
      message.retry({ delaySeconds: 5 });
      return;
    }
    await report({ status: "failed", reason }, at);
    message.ack();
  };
  const retry = async (reason: Extract<SubmissionOutcome, { status: "retrying" }>["reason"], at: number) => {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) return exhaust("expired", at);
    if (attempts >= MAX_ATTEMPTS) return exhaust("attempts_exhausted", at);
    await report({ status: "retrying", reason }, at);
    message.retry({ delaySeconds: Math.min(5 * 2 ** (attempts - 1), Math.ceil(remaining / 1000)) });
  };

  let destination;
  try {
    destination = await resolve(job);
  } catch {
    return retry("eligibility_unavailable", Date.now());
  }
  if (destination === null) {
    if (attempts > 1) await report({ status: "canceled" }, Date.now());
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
    await report({ status: "failed", reason: outcome.reason }, at);
  }
  else await report(outcome, at);
  message.ack();
}
