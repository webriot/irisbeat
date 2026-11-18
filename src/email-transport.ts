// SPDX-License-Identifier: AGPL-3.0-only
import { html } from "hono/html";
import { describeNotification, notificationName } from "./notification-content";
import { parseEmailAddress, type AlertDestination, type NotificationJob } from "./notification-jobs";
import type { TransportOutcome } from "./notification-outcomes";

type EmailBindings = { EMAIL?: SendEmail; EMAIL_FROM?: string };
type EmailContent = { to: string; subject: string; text: string; html: string };

export async function submitEmail(env: EmailBindings, email: EmailContent): Promise<TransportOutcome> {
  const from = parseEmailAddress(env.EMAIL_FROM);
  if (!env.EMAIL || !from) return { status: "permanent", reason: "provider_rejected" };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      env.EMAIL.send({ ...email, from }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Email submission timed out")), 10_000);
      }),
    ]);
    return { status: "accepted" };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    switch (code) {
      case "E_RATE_LIMIT_EXCEEDED":
      case "E_DAILY_LIMIT_EXCEEDED":
        return { status: "temporary", reason: "rate_limited" };
      case "E_INTERNAL_SERVER_ERROR":
      case "E_EMAIL_SENDING_NOT_READY":
        return { status: "temporary", reason: "provider_unavailable" };
      case "E_VALIDATION_ERROR":
      case "E_SENDER_NOT_VERIFIED":
      case "E_SENDER_DOMAIN_NOT_AVAILABLE":
      case "E_SENDER_DOMAIN_NOT_CONFIGURED":
      case "E_RECIPIENT_NOT_ALLOWED":
      case "E_RECIPIENT_PLAN_RESTRICTED":
      case "E_RECIPIENT_SUPPRESSED":
      case "E_ACCOUNT_SUSPENDED":
      case "E_CONTENT_TOO_LARGE":
      case "E_DELIVERY_FAILED":
        return { status: "permanent", reason: "provider_rejected" };
      default:
        return error instanceof TypeError
          ? { status: "permanent", reason: "provider_rejected" }
          : { status: "temporary", reason: "network" };
    }
  } finally {
    clearTimeout(timeout);
  }
}

export function submitAlertEmail(
  { address, unsubscribeUrl }: Extract<AlertDestination, { channel: "email" }>,
  { event }: NotificationJob,
  env: EmailBindings,
) {
  const name = notificationName(event);
  const { summary, lines } = describeNotification(event);
  return submitEmail(env, {
    to: address,
    subject: "Irisbeat: " + summary,
    text: [summary, name, ...lines, "", "Unsubscribe: " + unsubscribeUrl].join("\n"),
    html: html`<h1>${summary}</h1><p>${name}</p>${lines.map(line => html`<p>${line}</p>`)}
      <p><a href="${unsubscribeUrl}">Unsubscribe</a></p>`.toString(),
  });
}
