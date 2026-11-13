# Irisbeat

Irisbeat is being built as a complete, self-hostable Cloudflare monitoring application. Its planned scope includes HTTP, TCP and heartbeat checks, incidents, maintenance, status pages, webhook alerts and an operator UI.

This repository currently contains repository initialization and engineering workflow documentation. The monitoring application is not implemented yet.

## Repository boundary

The public application owns the monitoring engine and hosted extension interfaces. Private hosted consumers integrate versioned public releases rather than duplicate the engine.

Hosted consumers own account integration, organization roles, entitlements, subscription provisioning, monitor allowances, email delivery, custom hostnames and hosted deployment. The public application remains independently self-hostable. Infrastructure and secrets belong outside this repository.

## Engineering workflow

Track work in [GitHub Issues](https://github.com/Webriot/irisbeat/issues). Agent conventions are in [AGENTS.md](AGENTS.md).

## License

This project's own code is source-available under the [Functional Source License 1.1, Apache-2.0 future license](LICENSE) (`FSL-1.1-ALv2`). Each version becomes additionally available under Apache-2.0 on the second anniversary of the date it is made available. FSL restricts competing commercial uses; see the full license for its terms.

Third-party components retain their own licenses.
