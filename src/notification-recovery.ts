// SPDX-License-Identifier: AGPL-3.0-only
import { DurableObject } from "cloudflare:workers";
import type { DeadLetter, NotificationDeliveryIdentity, SubmissionReport } from "./notification-outcomes";

export type ResultBindings = {
  NOTIFICATION_DELIVERY: { reportSubmission(job: NotificationDeliveryIdentity, report: SubmissionReport): Promise<void> };
  NOTIFICATION_DLQ: Pick<Queue<DeadLetter>, "send">;
};

type Pending =
  | { identity: NotificationDeliveryIdentity; report: SubmissionReport }
  | { letter: DeadLetter };

const RETENTION = 14 * 24 * 60 * 60 * 1000;

export class NotificationRecovery extends DurableObject<ResultBindings> {
  private readonly inFlight = new Set<string>();

  accepted() {
    return (this.ctx.storage.kv.get<number>("accepted") ?? 0) > Date.now();
  }

  async record(identity: NotificationDeliveryIdentity, report: SubmissionReport, letter?: DeadLetter) {
    const storage = this.ctx.storage;
    const now = Date.now();
    const expiresAt = storage.kv.get<number>("expires") ?? now + RETENTION;
    const key = "pending:report:" + report.attempt + ":" + report.result.status;
    const letterKey = "pending:letter:" + report.attempt;
    storage.kv.put("expires", expiresAt);
    if (report.result.status === "accepted") storage.kv.put("accepted", expiresAt);
    if (!storage.kv.get(key)) storage.kv.put<Pending>(key, { identity, report });
    if (letter && !storage.kv.get(letterKey)) storage.kv.put<Pending>(letterKey, { letter });
    await storage.setAlarm(now + 5_000);
    await Promise.all([this.flush(key), letter && this.flush(letterKey)]);
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
    this.inFlight.add(key);
    try {
      if ("letter" in pending) await this.env.NOTIFICATION_DLQ.send(pending.letter);
      else await this.env.NOTIFICATION_DELIVERY.reportSubmission(pending.identity, pending.report);
      kv.delete(key);
    } catch {
      console.error(JSON.stringify({
        event: "letter" in pending ? "notification_dead_letter_failed" : "notification_submission_report_failed",
      }));
    } finally {
      this.inFlight.delete(key);
    }
  }
}
