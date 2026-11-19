// SPDX-License-Identifier: AGPL-3.0-only
import { DurableObject } from "cloudflare:workers";
import { submitConfirmation } from "./email-confirmation-transport";
import { parseEmailAddress, type ConfirmationIdentity, type ConfirmationJob, type NotificationEligibility, type NotificationQueueJob, type TerminalNotificationJob } from "./notification-jobs";
import type {
  DeadLetter, ExhaustionReason, NotificationDeliveryIdentity, SubmissionOutcome, SubmissionReport, TransportOutcome,
} from "./notification-outcomes";
import { submitWebhook } from "./webhook-transport";

export type DeliveryBindings = {
  EMAIL?: SendEmail;
  EMAIL_FROM?: string;
  NOTIFICATION_DELIVERY: {
    resolveConfirmation(job: ConfirmationJob): Promise<{ address: string; url: string } | null>;
    markConfirmationSubmitted(job: ConfirmationIdentity): Promise<void>;
    resolveWebhook(job: NotificationEligibility): Promise<string | null>;
    reportSubmission(job: NotificationDeliveryIdentity, report: SubmissionReport): Promise<void>;
  };
  NOTIFICATION_DLQ: Pick<Queue<DeadLetter>, "send">;
};

type Pending =
  | { identity: NotificationDeliveryIdentity; report: SubmissionReport }
  | { confirmation: ConfirmationIdentity }
  | { letter: DeadLetter };

const MAX_SUBMISSIONS = 10;
export const LAST_BROKER_DELIVERY = 11;
const MAX_AGE = 60 * 60 * 1000;
const RETENTION = 14 * 24 * 60 * 60 * 1000;

export class NotificationRecovery extends DurableObject<DeliveryBindings> {
  private readonly inFlight = new Set<string>();
  private readonly submitting = new Set<Promise<TransportOutcome>>();

  private closed(now: number) {
    const { kv } = this.ctx.storage;
    return (kv.get<number>("accepted") ?? 0) > now || (kv.get<number>("terminal") ?? 0) > now;
  }

  async deliver(job: NotificationQueueJob | TerminalNotificationJob, brokerAttempt: number, timestamp: number): Promise<number | null> {
    const storage = this.ctx.storage;
    const { kv } = storage;
    const identity = { contextId: job.contextId, destinationId: job.destinationId, deliveryId: job.deliveryId };
    const confirmation = "kind" in job ? { ...identity, pauseGeneration: job.pauseGeneration } : undefined;
    const { at: eventAt, order: eventOrder } = "kind" in job ? job : job.event;
    const superseded = () => this.closed(Date.now()) || brokerAttempt < (kv.get<number>("broker-attempt") ?? 0);
    if (superseded()) return null;
    const knownQueuedAt = kv.get<number>("queued-at");
    if (knownQueuedAt === undefined || timestamp < knownQueuedAt) kv.put("queued-at", timestamp);
    if (!kv.get("expires")) {
      const expires = Date.now() + RETENTION;
      kv.put("expires", expires);
      await storage.setAlarm(expires);
    }

    let submit: (() => Promise<TransportOutcome>) | undefined;
    let eligible = false;
    let eligibilityAvailable = true;
    try {
      if ("kind" in job) {
        const from = parseEmailAddress(this.env.EMAIL_FROM);
        const destination = await this.env.NOTIFICATION_DELIVERY.resolveConfirmation(job);
        eligible = !!destination;
        if (destination) submit = () => submitConfirmation(this.env.EMAIL, from, destination);
      } else {
        const url = await this.env.NOTIFICATION_DELIVERY.resolveWebhook(job);
        eligible = !!url;
        if (url && !("terminal" in job)) submit = () => submitWebhook(url, job);
      }
    } catch {
      eligibilityAvailable = false;
    }

    const at = Date.now();
    if (superseded()) return null;
    const queuedAt = kv.get<number>("queued-at") ?? timestamp;
    const expiresAt = queuedAt + MAX_AGE;
    const previous = kv.get<number>("attempt") ?? 0;
    // Older Recovery objects tracked only broker ordinals. Treat their high-water mark as spent.
    let submissions = kv.get<number>("submissions") ?? Math.min(previous, MAX_SUBMISSIONS);
    const attempt = previous + 1;
    const record = (result: SubmissionOutcome, exhaustion?: ExhaustionReason) => this.stage(
      identity, {
        eventAt, eventOrder, queuedAt,
        attempt: exhaustion ? Math.max(attempt, kv.get<number>("attempt") ?? 0) : attempt,
        result: { ...result, at: exhaustion ? Date.now() : at }, ...(confirmation && { confirmation: true }),
      },
      exhaustion && { ...identity, queuedAt, attempts: kv.get<number>("submissions") ?? submissions, reason: exhaustion },
      result.status === "accepted" ? confirmation : undefined,
    );
    const exhaust = async (reason: ExhaustionReason) => {
      if (brokerAttempt >= LAST_BROKER_DELIVERY) kv.put("broker-attempt", LAST_BROKER_DELIVERY);
      // Keep this delivery outstanding until every admitted provider call can record acceptance.
      while (this.submitting.size) await Promise.all(this.submitting);
      await record({ status: "failed", reason }, reason);
    };
    const retry = async (reason: Extract<SubmissionOutcome, { status: "retrying" }>["reason"], count: number) => {
      const now = Date.now();
      if (this.closed(now)) return null;
      const remaining = expiresAt - now;
      if (remaining <= 0) await exhaust("expired");
      else if ((kv.get<number>("submissions") ?? submissions) >= MAX_SUBMISSIONS || brokerAttempt >= LAST_BROKER_DELIVERY) await exhaust("attempts_exhausted");
      else {
        await record({ status: "retrying", reason });
        return this.closed(Date.now()) ? null : Math.min(5 * 2 ** (count - 1), Math.ceil(remaining / 1000));
      }
      return null;
    };
    if (kv.get("submissions") === undefined) kv.put("submissions", submissions);
    if (!eligible && eligibilityAvailable) {
      await record({ status: "canceled" });
      return null;
    }
    if (at >= expiresAt) await exhaust("expired");
    else if (submissions >= MAX_SUBMISSIONS || brokerAttempt >= LAST_BROKER_DELIVERY) await exhaust("attempts_exhausted");
    else if (!submit) return retry("eligibility_unavailable", brokerAttempt);
    else {
      // The output gate commits the reservation before releasing the provider call.
      kv.put("broker-attempt", brokerAttempt);
      kv.put("attempt", attempt);
      kv.put("submissions", ++submissions);
      const submitted = submit().catch((): TransportOutcome => ({ status: "temporary", reason: "network" }));
      this.submitting.add(submitted);
      const outcome = await submitted;
      this.submitting.delete(submitted);
      if (outcome.status === "temporary") return retry(outcome.reason, submissions);
      if (outcome.status === "permanent") {
        console.error(JSON.stringify({ event: "notification_submission_failed", reason: outcome.reason }));
        await record({ status: "failed", reason: outcome.reason });
      } else await record(outcome);
    }
    return null;
  }

  async record(identity: NotificationDeliveryIdentity, report: SubmissionReport, letter?: DeadLetter) {
    if (letter) {
      while (this.submitting.size) await Promise.all(this.submitting);
    }
    await this.stage(identity, report, letter);
  }

  private async stage(identity: NotificationDeliveryIdentity, report: SubmissionReport, letter?: DeadLetter, confirmation?: ConfirmationIdentity) {
    const storage = this.ctx.storage;
    const now = Date.now();
    const accepted = report.result.status === "accepted";
    const latest = storage.kv.get<number>("attempt") ?? 0;
    // An acceptance can still arrive from a provider request that was already in flight.
    if (accepted ? (storage.kv.get<number>("accepted") ?? 0) > now : this.closed(now) || report.attempt < latest) return;
    const expiresAt = storage.kv.get<number>("expires") ?? now + RETENTION;
    const key = "pending:report:" + report.attempt + ":" + report.result.status;
    const letterKey = "pending:letter:" + report.attempt;
    const confirmationKey = "pending:confirmation";
    storage.kv.put("expires", expiresAt);
    storage.kv.put("attempt", Math.max(latest, report.attempt));
    if (accepted) storage.kv.put("accepted", expiresAt);
    else if (report.result.status !== "retrying") storage.kv.put("terminal", expiresAt);
    if (!storage.kv.get(key)) storage.kv.put<Pending>(key, { identity, report });
    if (letter && !storage.kv.get(letterKey)) storage.kv.put<Pending>(letterKey, { letter });
    if (confirmation) storage.kv.put<Pending>(confirmationKey, { confirmation });
    await storage.setAlarm(now + 5_000);
    await Promise.all([this.flush(key), letter && this.flush(letterKey), confirmation && this.flush(confirmationKey)]);
  }

  async alarm() {
    const { kv } = this.ctx.storage;
    const expiresAt = kv.get<number>("expires") ?? 0;
    if (expiresAt <= Date.now()) {
      await this.ctx.storage.deleteAll();
      return;
    }
    const keys = Array.from(kv.list<Pending>({ prefix: "pending:" }), ([key]) => key);
    const delay = kv.get<number>("retry-delay") ?? 10_000;
    if (keys.length) kv.put("retry-delay", Math.min(delay * 2, 60_000));
    await this.ctx.storage.setAlarm(keys.length ? Math.min(expiresAt, Date.now() + delay) : expiresAt);
    await Promise.all(keys.map(key => this.flush(key)));
  }

  private async flush(key: string) {
    const { kv } = this.ctx.storage;
    const pending = kv.get<Pending>(key);
    if (!pending || this.inFlight.has(key)) return;
    if ("report" in pending && pending.report.result.status === "retrying" &&
      (this.closed(Date.now()) || pending.report.attempt < (kv.get<number>("attempt") ?? 0))) {
      kv.delete(key);
      return;
    }
    this.inFlight.add(key);
    try {
      if ("letter" in pending) await this.env.NOTIFICATION_DLQ.send(pending.letter);
      else if ("confirmation" in pending) await this.env.NOTIFICATION_DELIVERY.markConfirmationSubmitted(pending.confirmation);
      else await this.env.NOTIFICATION_DELIVERY.reportSubmission(pending.identity, pending.report);
      kv.delete(key);
    } catch {
      console.error(JSON.stringify({
        event: "letter" in pending ? "notification_dead_letter_failed"
          : "confirmation" in pending ? "email_confirmation_record_failed" : "notification_submission_report_failed",
      }));
    } finally {
      this.inFlight.delete(key);
    }
  }
}
