// SPDX-License-Identifier: AGPL-3.0-only
import { WorkerEntrypoint } from "cloudflare:workers";
import { parseEmailAddress, type NotificationQueueJob, type TerminalNotificationJob } from "./notification-jobs";
import type { NotificationOutcomeMessage } from "./notification-outcomes";
import { LAST_BROKER_DELIVERY, type DeliveryBindings, type NotificationRecovery } from "./notification-recovery";

export { NotificationRecovery } from "./notification-recovery";

type QueueMessage = NotificationQueueJob | NotificationOutcomeMessage | TerminalNotificationJob;

interface DeliveryEnv extends DeliveryBindings {
  NOTIFICATION_HANDOFF: Pick<Queue<TerminalNotificationJob | NotificationOutcomeMessage>, "send">;
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
      try {
        const recovery = env.NOTIFICATION_RECOVERY.getByName(JSON.stringify(identity));
        if ("submissionReport" in job) {
          // Drain outcome messages queued by an earlier delivery Worker.
          await recovery.record(identity, job.submissionReport, job.exhaustion && {
            ...identity, queuedAt: job.submissionReport.queuedAt,
            attempts: job.submissionReport.attempt, reason: job.exhaustion,
          });
        } else {
          const terminal = "terminal" in job;
          const delaySeconds = await recovery.deliver(job, terminal ? LAST_BROKER_DELIVERY : message.attempts,
            terminal ? job.queuedAt : message.timestamp.getTime());
          if (delaySeconds !== null) return message.retry({ delaySeconds });
        }
        return message.ack();
      } catch {
        console.error(JSON.stringify({ event: "notification_recovery_unavailable" }));
      }
      if (message.attempts >= LAST_BROKER_DELIVERY) {
        // Give terminal bookkeeping a fresh broker retry budget without replaying the provider.
        const handoff: TerminalNotificationJob | NotificationOutcomeMessage =
          "submissionReport" in job || "terminal" in job ? job
          : "kind" in job ? { ...job, terminal: true, queuedAt: message.timestamp.getTime() }
          : {
            ...identity, monitorId: job.monitorId, generation: job.generation, pauseGeneration: job.pauseGeneration,
            event: { at: job.event.at, order: job.event.order }, terminal: true, queuedAt: message.timestamp.getTime(),
          };
        try {
          await env.NOTIFICATION_HANDOFF.send(handoff, { delaySeconds: 5 });
          return message.ack();
        } catch {
          console.error(JSON.stringify({ event: "notification_handoff_unavailable" }));
        }
      }
      message.retry({ delaySeconds: 5 });
    }));
  },
} satisfies ExportedHandler<DeliveryEnv, QueueMessage>;
