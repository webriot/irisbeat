// SPDX-License-Identifier: AGPL-3.0-only
import { WorkerEntrypoint } from "cloudflare:workers";
import { html } from "hono/html";
import { deliverNotification, recoverNotificationOutcome, type RecoveryBindings } from "./notification-delivery-policy";
import { parseEmailAddress, type ConfirmationJob, type NotificationJob, type NotificationQueueJob } from "./notification-jobs";
import type { NotificationOutcomeMessage } from "./notification-outcomes";
import type { ResultBindings } from "./notification-recovery";
import { submitWebhook } from "./webhook-transport";

export { NotificationRecovery } from "./notification-recovery";

interface DeliveryEnv extends ResultBindings, RecoveryBindings {
  EMAIL?: SendEmail;
  EMAIL_FROM?: string;
  NOTIFICATION_DELIVERY: ResultBindings["NOTIFICATION_DELIVERY"] & {
    resolveConfirmation(job: ConfirmationJob): Promise<{ address: string; url: string } | null>;
    markConfirmationSubmitted(job: ConfirmationJob): Promise<void>;
    resolveWebhook(job: NotificationJob): Promise<string | null>;
  };
}

export class NotificationEmailCapability extends WorkerEntrypoint<DeliveryEnv> {
  isConfigured() {
    return !!this.env.EMAIL && !!parseEmailAddress(this.env.EMAIL_FROM);
  }
}

async function sendConfirmation(job: ConfirmationJob, env: DeliveryEnv) {
  const from = parseEmailAddress(env.EMAIL_FROM);
  if (!env.EMAIL || !from) throw new Error("Email binding unavailable");
  const destination = await env.NOTIFICATION_DELIVERY.resolveConfirmation(job);
  if (!destination) return;
  const { address, url } = destination;
  const subject = "Confirm Irisbeat email notifications";
  const intro = "Confirm this inbox to receive Irisbeat notifications. This link expires in 24 hours.";
  const email = {
    to: address, from, subject,
    text: intro + "\n\n" + url,
    html: html`<p>${intro}</p><p><a href="${url}">Confirm email</a></p>`.toString(),
  };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      env.EMAIL.send(email),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Email submission timed out")), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  await env.NOTIFICATION_DELIVERY.markConfirmationSubmitted(job);
}

export default {
  async queue(batch, env) {
    await Promise.all(batch.messages.map(async message => {
      const job = message.body;
      if ("submissionReport" in job) return recoverNotificationOutcome(message, job, env);
      if ("kind" in job) {
        try {
          await sendConfirmation(job, env);
        } catch {
          console.error(JSON.stringify({ event: "email_confirmation_submission_failed" }));
        }
        message.ack();
        return;
      }
      return deliverNotification(message, job, job.event.at, env, job => env.NOTIFICATION_DELIVERY.resolveWebhook(job), submitWebhook);
    }));
  },
} satisfies ExportedHandler<DeliveryEnv, NotificationQueueJob | NotificationOutcomeMessage>;
