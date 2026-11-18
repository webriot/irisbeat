// SPDX-License-Identifier: AGPL-3.0-only
import { WorkerEntrypoint } from "cloudflare:workers";
import { html } from "hono/html";
import { describeNotification, notificationName } from "./notification-content";
import { submitAlertEmail, submitEmail } from "./email-transport";
import { parseEmailAddress, type AlertDestination, type ConfirmationJob, type NotificationJob, type NotificationQueueJob } from "./notification-jobs";

interface DeliveryEnv {
  EMAIL?: SendEmail;
  EMAIL_FROM?: string;
  NOTIFICATION_DELIVERY: {
    resolveConfirmation(job: ConfirmationJob): Promise<{ address: string; url: string } | null>;
    markConfirmationSubmitted(job: ConfirmationJob): Promise<void>;
    resolveAlert(job: NotificationJob): Promise<AlertDestination | null>;
  };
}

export class NotificationEmailCapability extends WorkerEntrypoint<DeliveryEnv> {
  isConfigured() {
    return !!this.env.EMAIL && !!parseEmailAddress(this.env.EMAIL_FROM);
  }
}

async function sendConfirmation(job: ConfirmationJob, env: DeliveryEnv) {
  const destination = await env.NOTIFICATION_DELIVERY.resolveConfirmation(job);
  if (!destination) return;
  const { address, url } = destination;
  const subject = "Confirm Irisbeat email notifications";
  const intro = "Confirm this inbox to receive Irisbeat notifications. This link expires in 24 hours.";
  const email = {
    to: address, subject,
    text: intro + "\n\n" + url,
    html: html`<p>${intro}</p><p><a href="${url}">Confirm email</a></p>`.toString(),
  };
  const outcome = await submitEmail(env, email);
  if (outcome.status !== "accepted") throw new Error("Email confirmation submission failed");
  await env.NOTIFICATION_DELIVERY.markConfirmationSubmitted(job);
}

function renderWebhook({ event }: NotificationJob) {
  // Inline code isolates Markdown. Slack decodes its reserved entities and the zero-width
  // separator prevents Discord from expanding broadcast mentions.
  const name = notificationName(event)
    .replaceAll("`", "ˋ").replaceAll("@", "@\u200b")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const { summary, lines } = describeNotification(event);
  return JSON.stringify({ text: ["`" + name + "` · " + summary, ...lines].join("\n") });
}

export default {
  async queue(batch, env) {
    await Promise.all(batch.messages.map(async message => {
      if ("kind" in message.body) {
        try {
          await sendConfirmation(message.body, env);
        } catch {
          console.error(JSON.stringify({ event: "email_confirmation_submission_failed" }));
        }
        message.ack();
        return;
      }
      const destination = await env.NOTIFICATION_DELIVERY.resolveAlert(message.body).catch(() => {
        console.error(JSON.stringify({ event: "notification_eligibility_failed" }));
        return null;
      });
      try {
        if (destination?.channel === "email") {
          const outcome = await submitAlertEmail(destination, message.body, env);
          if (outcome.status !== "accepted") console.error(JSON.stringify({
            event: "email_alert_submission_failed", reason: outcome.reason,
          }));
        } else if (destination?.channel === "webhook") {
          const response = await fetch(destination.url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: renderWebhook(message.body),
            redirect: "manual",
            signal: AbortSignal.timeout(10_000),
          });
          await response.body?.cancel();
          if (!response.ok) throw new Error("Webhook rejected");
        }
      } catch {
        console.error(JSON.stringify({
          event: destination?.channel === "email" ? "email_alert_submission_failed" : "webhook_submission_failed",
        }));
      }
      message.ack();
    }));
  },
} satisfies ExportedHandler<DeliveryEnv, NotificationQueueJob>;
