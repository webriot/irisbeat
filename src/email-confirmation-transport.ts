// SPDX-License-Identifier: AGPL-3.0-only
import { html } from "hono/html";
import { submitEmail, type EmailBindings } from "./email-submission";

export function submitConfirmation({ address, url }: { address: string; url: string }, env: EmailBindings) {
  const intro = "Confirm this inbox to receive Irisbeat notifications. This link expires in 24 hours.";
  return submitEmail(env, {
    to: address,
    subject: "Confirm Irisbeat email notifications",
    text: intro + "\n\n" + url,
    html: html`<p>${intro}</p><p><a href="${url}">Confirm email</a></p>`.toString(),
  });
}
