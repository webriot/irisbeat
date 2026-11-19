// SPDX-License-Identifier: AGPL-3.0-only
import { html } from "hono/html";
import type { TransportOutcome } from "./notification-outcomes";

export async function submitConfirmation(
  email: SendEmail | undefined, from: string | null, { address, url }: { address: string; url: string },
): Promise<TransportOutcome> {
  if (!email || !from) return { status: "permanent", reason: "provider_rejected" };
  const subject = "Confirm Irisbeat email notifications";
  const intro = "Confirm this inbox to receive Irisbeat notifications. This link expires in 24 hours.";
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      email.send({
        to: address, from, subject,
        text: intro + "\n\n" + url,
        html: html`<p>${intro}</p><p><a href="${url}">Confirm email</a></p>`.toString(),
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Email submission timed out")), 10_000);
      }),
    ]);
    return { status: "accepted" };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "E_RATE_LIMIT_EXCEEDED" || code === "E_DAILY_LIMIT_EXCEEDED") {
      return { status: "temporary", reason: "rate_limited" };
    }
    if (code === "E_INTERNAL_SERVER_ERROR") return { status: "temporary", reason: "provider_unavailable" };
    if (error instanceof TypeError || (typeof code === "string" && code.startsWith("E_"))) {
      return { status: "permanent", reason: "provider_rejected" };
    }
    return { status: "temporary", reason: "network" };
  } finally {
    clearTimeout(timeout);
  }
}
