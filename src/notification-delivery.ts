// SPDX-License-Identifier: AGPL-3.0-only
import { deliverNotification, recoverNotificationOutcome, type RecoveryBindings } from "./notification-delivery-policy";
import type { NotificationJob } from "./notification-jobs";
import type { NotificationOutcomeMessage } from "./notification-outcomes";
import type { ResultBindings } from "./notification-recovery";
export { NotificationRecovery } from "./notification-recovery";
import { submitWebhook } from "./webhook-transport";

interface DeliveryEnv extends ResultBindings, RecoveryBindings {
  NOTIFICATION_DELIVERY: ResultBindings["NOTIFICATION_DELIVERY"] & {
    resolveWebhook(job: NotificationJob): Promise<string | null>;
  };
}

export default {
  async queue(batch, env) {
    await Promise.all(batch.messages.map(message => {
      const job = message.body;
      if ("submissionReport" in job) return recoverNotificationOutcome(message, job, env);
      return deliverNotification(message, job, job.event.at, env, job => env.NOTIFICATION_DELIVERY.resolveWebhook(job), submitWebhook);
    }));
  },
} satisfies ExportedHandler<DeliveryEnv, NotificationJob | NotificationOutcomeMessage>;
