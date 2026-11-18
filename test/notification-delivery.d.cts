// SPDX-License-Identifier: AGPL-3.0-only
export function withDelivery(run: (
  dispatch: (url: string, init: RequestInit) => Promise<Response>,
  confirmationLinkFor: (address: string) => Promise<string>,
) => Promise<void>): Promise<void>;
