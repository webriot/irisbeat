# Irisbeat

Irisbeat is being built as a complete, self-hostable Cloudflare monitoring application. Its planned scope includes HTTP, TCP and heartbeat checks, incidents, maintenance, status pages, webhook alerts and an operator UI.

The first application slice supports one personal HTTP(S) Monitor, authenticated operator configuration, and an anonymous Status page with automatic Incidents. The remaining planned features are tracked in [spec #1](https://github.com/Webriot/irisbeat/issues/1).

## Local development

Requires Node.js 22.12 or later and npm. No Cloudflare account or credentials are needed for tests or the dry-run build.

```sh
npm ci
npm run types
npm test
npm run check
npm run build
```

For interactive local use, create an ignored `.dev.vars` file containing `INSTALLATION_SECRET="<your local secret>"`, then run `npm run dev`. Open `/operator` and sign in with that secret. Configure a page name, Monitor name and HTTP(S) target. The secret stays in browser memory until sign-out or reload; it is never stored in browser storage or returned by the API. Use a dedicated secret and HTTPS outside local development.

Local cron dispatch can be triggered at `/__scheduled?cron=*+*+*+*+*`. Deployed cron runs every minute; missed dispatches are not replayed. New Monitors remain “Awaiting check” until observed. GET accepts every 2xx response and follows redirects; network errors, a ten-second deadline, and non-2xx responses are failures. Two consecutive failures open an Incident, and two consecutive successes close it. The public page refreshes every minute and displays Incident timestamps in UTC.

## Application interfaces

| Boundary | Behavior |
| --- | --- |
| `GET /` | Anonymous Status page; target URLs and credentials omitted |
| `GET /operator` | Accessible operator sign-in and configuration forms |
| `GET /api/status` | Anonymous page name, current Monitor, last Check result and Incidents |
| `GET /api/operator` | Same status plus target URL; installation Bearer secret required |
| `PUT /api/operator` | Save JSON `{ pageName, name, url }`; same authorization required |
| Worker `scheduled` | Dispatch one due attempt to the personal monitoring context |

`src/index.ts` owns the Worker handlers, validation, detection and `MonitoringContext` Durable Object. The `MONITORING` binding routes to `getByName('personal')`. SQLite-backed storage persists configuration, consecutive counts, due time, last result and Incidents. `src/ui.ts` owns the functional HTML and browser controls; visual design remains open for owner confirmation. `Status` and `Incident` are exported TypeScript types for subsequent application work, not yet versioned hosted contracts.

Configuration changes preserve Incident history and current availability; saving resets consecutive counts. A result from a target configuration replaced while its request is running is discarded. Request bodies are limited to 4 KiB. Target URLs may use HTTP or HTTPS but cannot embed username/password credentials. No target URL or installation secret is included in anonymous responses; all responses disable caching.

## Runtime verification

`test/monitoring.test.ts` exercises real Worker requests and scheduled handlers with a real SQLite-backed Durable Object in local `workerd`. It controls cron timestamps, substitutes external targets with MSW, evicts the object to verify persistence, and asserts only HTTP responses and target behavior. The timeout case substitutes outbound fetch and advances the configured deadline immediately using a narrow runtime timer substitution; broad Vitest fake timers with pending RPC requests crash the current local runtime. No test accesses storage tables or private methods.

The harness follows Cloudflare's [Vitest setup](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/), [request mocking](https://developers.cloudflare.com/workers/testing/vitest-integration/mock-outbound-requests/) and [test APIs](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/). `npm run check` regenerates binding/runtime types from `wrangler.jsonc` and checks TypeScript; generated declarations are ignored. `npm run build` bundles locally with `wrangler deploy --dry-run` and does not deploy.

The configuration declares the public application runtime only: one Worker, a one-minute cron, a SQLite Durable Object migration and the required `INSTALLATION_SECRET` name. Actual deployments, secret values and account infrastructure belong outside this repository. TCP, Heartbeat, timing controls, Maintenance, pause, publication controls, availability bars, webhooks, hosted adapters and a Deploy to Cloudflare flow remain later tickets. No real deployment or browser interaction automation has been performed.

## Repository boundary

The public application owns the monitoring engine and hosted extension interfaces. Private hosted consumers integrate versioned public releases rather than duplicate the engine.

Hosted consumers own account integration, organization roles, entitlements, subscription provisioning, monitor allowances, email delivery, custom hostnames and hosted deployment. The public application remains independently self-hostable. Infrastructure and secrets belong outside this repository.

## Engineering workflow

Track work in [GitHub Issues](https://github.com/Webriot/irisbeat/issues). Agent conventions are in [AGENTS.md](AGENTS.md).

## License

Copyright 2026 Webriot.

This project's own code is licensed under the [GNU Affero General Public License, version 3](LICENSE) (`AGPL-3.0-only`).

Third-party components retain their own licenses.
