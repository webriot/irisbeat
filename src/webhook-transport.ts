// SPDX-License-Identifier: AGPL-3.0-only
import { describeNotification, notificationName } from "./notification-content";
import type { NotificationJob } from "./notification-jobs";
import type { TransportOutcome } from "./notification-outcomes";

function renderWebhook({ event }: NotificationJob) {
  // Inline code isolates Markdown. Slack decodes its reserved entities and the zero-width
  // separator prevents Discord from expanding broadcast mentions.
  const name = notificationName(event)
    .replaceAll("`", "ˋ").replaceAll("@", "@\u200b")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const { summary, lines } = describeNotification(event);
  return JSON.stringify({ text: ["`" + name + "` · " + summary, ...lines].join("\n") });
}

export async function submitWebhook(url: string, job: NotificationJob): Promise<TransportOutcome> {
  const body = renderWebhook(job);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { status: "temporary", reason: "network" };
  }
  // Headers decide acceptance. Cleanup failure cannot change the provider outcome.
  void response.body?.cancel().catch(() => {});
  if (response.ok) return { status: "accepted" };
  if (response.status === 429) return { status: "temporary", reason: "rate_limited" };
  if (response.status === 408 || response.status >= 500)
    return { status: "temporary", reason: "provider_unavailable" };
  return { status: "permanent", reason: "provider_rejected" };
}
