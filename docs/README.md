# Irisbeat documentation

## Contents

- [Quickstart](#quickstart)
- [Install and operate](#install-and-operate)
- [API and integration references](#api-and-integration-references)
- [Contribute and release](#contribute-and-release)

## Quickstart

1. Deploy the monitoring Worker to your Cloudflare account using the [Deploy button](install.md#deploy-to-cloudflare) or the [CLI](install.md#exact-source-cli-installation). Set a unique `INSTALLATION_SECRET` during deployment and complete [availability history setup](install.md#availability-history) to see the 90-day history.
2. Open `/operator` on your Worker URL. Sign in with the installation secret and give your status page a name in **Settings**.
3. Select **New Monitor**. For HTTP(S), enter a health URL. For TCP, enter a host and port. For Heartbeat, save the Monitor and reopen **Edit** to find its check-in path. Configure your job to [send a receipt](heartbeat-api.md#send-a-receipt).
4. Leave **Published** selected to show the Monitor on the public page at `/`. Clear it to keep the Monitor private while checks continue. Public changes can take up to a minute with the default settings.
5. To receive alerts, [deploy the delivery Worker and queues](install.md#exact-source-cli-installation). Add a destination in **Settings**, then select it on each Monitor that should send alerts.

To try Irisbeat on your computer, follow the [local setup](development.md).

## Install and operate

- [Installation and upgrades](install.md)
- [Check frequency](install.md#outbound-check-floor)
- [Availability history configuration](install.md#availability-history)
- [Email alerts](install.md#optional-email-confirmation)

## API and integration references

- [Versioned automation API and API keys](api-v1.md)
- [Versioned Monitor configuration API](monitor-api-v1.md)
- [Notification destination API](destination-api.md)
- [Monitor API and scheduling](monitor-api.md)
- [TCP Monitor setup](tcp-monitoring.md)
- [Heartbeat configuration and receipts](heartbeat-api.md)
- [Maintenance windows and notifications](maintenance-api.md)
- [Availability history responses](history-api.md)
- [Hosted engine contract](hosted-contract.md)

## Contribute and release

- [Local development and tests](development.md)
- [Release checks and publication](install.md#prepare-and-verify-a-release-no-publication)
- [Glossary](../GLOSSARY.md)
- Agent conventions for [issues](agents/issue-tracker.md), [triage](agents/triage-labels.md), and [domain docs](agents/domain.md)
