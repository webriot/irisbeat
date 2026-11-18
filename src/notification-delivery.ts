// SPDX-License-Identifier: AGPL-3.0-only
import { deliverNotification } from "./notification-delivery-policy";
import type { NotificationJob } from "./notification-jobs";
import type { NotificationRecovery, ResultBindings } from "./notification-recovery";
export { NotificationRecovery } from "./notification-recovery";
import { submitWebhook } from "./webhook-transport";

interface DeliveryEnv extends ResultBindings {
  NOTIFICATION_DELIVERY: ResultBindings["NOTIFICATION_DELIVERY"] & {
    resolveWebhook(job: NotificationJob): Promise<string | null>;
  };
  NOTIFICATION_RECOVERY: DurableObjectNamespace<NotificationRecovery>;
}

export default {
  async queue(batch, env) {
    await Promise.all(batch.messages.map(message =>
      deliverNotification(message, message.body.event.at, env, job => env.NOTIFICATION_DELIVERY.resolveWebhook(job), submitWebhook)));
  },
} satisfies ExportedHandler<DeliveryEnv, NotificationJob>;
