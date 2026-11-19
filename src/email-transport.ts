// SPDX-License-Identifier: AGPL-3.0-only
import { html } from "hono/html";
import { submitEmail, type EmailBindings } from "./email-submission";
import { describeNotification, notificationName } from "./notification-content";
import type { AlertDestination, NotificationJob } from "./notification-jobs";

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
