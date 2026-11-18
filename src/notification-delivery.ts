// SPDX-License-Identifier: AGPL-3.0-only
import type { NotificationJob } from "./notification-jobs";

interface DeliveryEnv {
  NOTIFICATION_DELIVERY: {
    resolveWebhook(job: NotificationJob): Promise<string | null>;
  };
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
} satisfies ExportedHandler<DeliveryEnv, NotificationJob>;
