// SPDX-License-Identifier: AGPL-3.0-only
import { WorkerEntrypoint } from "cloudflare:workers";
import { html } from "hono/html";
import { parseEmailAddress, type ConfirmationJob, type NotificationJob, type NotificationQueueJob } from "./notification-jobs";

interface DeliveryEnv {
  EMAIL?: SendEmail;
  EMAIL_FROM?: string;
  NOTIFICATION_DELIVERY: {
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

function renderWebhook({ event }: NotificationJob) {
  // Inline code isolates Markdown. Slack decodes its reserved entities and the zero-width
  // separator prevents Discord from expanding broadcast mentions.
  const name = event.monitorName.replace(/\s+/g, " ")
    .replace(/[\p{Cc}\p{Bidi_Control}]/gu, "")
    .replaceAll("`", "ˋ").replaceAll("@", "@\u200b")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const iso = (at: number) => new Date(at).toISOString();
  let summary: string;
  let details = "";
  switch (event.kind) {
    case "incident.opened":
      summary = "Incident opened";
      break;
    case "incident.recovered":
      summary = "Incident recovered";
      details = "\nOpened " + iso(event.openedAt);
      break;
    case "maintenance.started":
      summary = "Maintenance started";
      details = "\nScheduled end " + iso(event.endsAt);
      break;
    case "maintenance.updated":
      summary = "Maintenance end time changed";
      details = "\nPrevious end " + iso(event.previousEndsAt) + "\nScheduled end " + iso(event.endsAt);
      break;
    case "maintenance.ended":
      summary = event.reason === "early" ? "Maintenance ended early" : "Maintenance expired";
      details = "\nStarted " + iso(event.startedAt);
      if (event.reason === "early") details += "\nScheduled end " + iso(event.endsAt);
      break;
  }
  return JSON.stringify({ text: "`" + name + "` · " + summary + "\n" + iso(event.at) + details });
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
      try {
        const body = renderWebhook(message.body);
        const url = await env.NOTIFICATION_DELIVERY.resolveWebhook(message.body);
        if (url) {
          const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
            redirect: "manual",
            signal: AbortSignal.timeout(10_000),
          });
          await response.body?.cancel();
          if (!response.ok) throw new Error("Webhook rejected");
        }
      } catch {
        console.error(JSON.stringify({ event: "webhook_submission_failed" }));
      }
      message.ack();
    }));
  },
} satisfies ExportedHandler<DeliveryEnv, NotificationQueueJob>;
