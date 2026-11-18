// SPDX-License-Identifier: AGPL-3.0-only
import { WorkerEntrypoint } from "cloudflare:workers";
import { parseEmailAddress, type NotificationQueueJob } from "./notification-jobs";
import type { NotificationOutcomeMessage } from "./notification-outcomes";
import { LAST_BROKER_DELIVERY, type DeliveryBindings, type NotificationRecovery } from "./notification-recovery";

export { NotificationRecovery } from "./notification-recovery";

interface DeliveryEnv extends DeliveryBindings {
  NOTIFICATION_RECOVERY: DurableObjectNamespace<NotificationRecovery>;
}

export class NotificationEmailCapability extends WorkerEntrypoint<DeliveryEnv> {
  isConfigured() {
    return !!this.env.EMAIL && !!parseEmailAddress(this.env.EMAIL_FROM);
  }
}

export default {
  async queue(batch, env) {
    await Promise.all(batch.messages.map(async message => {
      const job = message.body;
      const identity = "submissionReport" in job ? job.identity : {
        contextId: job.contextId, destinationId: job.destinationId, deliveryId: job.deliveryId,
      };
      // A final broker delivery cannot rely on message.retry() for a transient Recovery outage.
      const tries = message.attempts >= LAST_BROKER_DELIVERY ? 3 : 1;
      for (let i = 0; i < tries; i++) {
        try {
          const recovery = env.NOTIFICATION_RECOVERY.getByName(JSON.stringify(identity));
          if ("submissionReport" in job) {
            // Drain outcome messages queued by an earlier delivery Worker.
            await recovery.record(identity, job.submissionReport, job.exhaustion && {
              ...identity, queuedAt: job.submissionReport.queuedAt,
              attempts: job.submissionReport.attempt, reason: job.exhaustion,
            });
          } else {
            const delaySeconds = await recovery.deliver(job, message.attempts, message.timestamp.getTime());
            if (delaySeconds !== null) return message.retry({ delaySeconds });
          }
          return message.ack();
        } catch {
          console.error(JSON.stringify({ event: "notification_recovery_unavailable" }));
        }
      }
      message.retry({ delaySeconds: 5 });
    }));
  },
} satisfies ExportedHandler<DeliveryEnv, NotificationQueueJob | NotificationOutcomeMessage>;
