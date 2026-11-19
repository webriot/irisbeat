# Irisbeat

Irisbeat is an open source uptime monitor and status page you run in your own Cloudflare account. Use it to check whether a website or service is reachable, or to find out when a scheduled job stops checking in.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Webriot/irisbeat)

## What you can monitor

| Monitor | What it checks |
| --- | --- |
| HTTP(S) | A website or API responds successfully. |
| TCP | A service accepts a connection on a host and port. |
| Heartbeat | A job or service checks in on time. |

Run checks at regular intervals or on a calendar schedule. Irisbeat opens and resolves incidents automatically, shows 90 days of availability history, and lets you schedule maintenance and send webhook or email alerts.

## Get started

1. Deploy Irisbeat to your Cloudflare account. The button uses the repository's default branch. The [installation guide](docs/install.md) also covers deploying a specific release.
2. Open `/operator` on your Worker URL and sign in with the installation secret you set during deployment.
3. Give your status page a name in **Settings**. Select **New Monitor**, choose a monitor type, and save. For a Heartbeat, open **Edit** after saving to find the check-in endpoint.
4. Open your Worker URL to see the public status page. Clear **Published** on any monitor you want to keep private. It will continue checking.

Use the installation guide to [set up availability history](docs/install.md#availability-history), [deploy the alert delivery Worker](docs/install.md#exact-source-cli-installation), or [enable email alerts](docs/install.md#optional-email-confirmation).

## Documentation

- [Quickstart and reference index](docs/README.md)
- [Local development and tests](docs/development.md)
- [Report a bug or suggest a feature](https://github.com/Webriot/irisbeat/issues)

The self-hosted app and the hosted integration use the same monitoring engine. Hosted services integrate through versioned releases and manage their own accounts, permissions, billing, and infrastructure. Keep deployment configuration and secrets outside this repository.

## License

Copyright 2026 Webriot.

Irisbeat's own code is open source under the [GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`). Third-party components retain their own licenses. See [NOTICE](NOTICE).
