# Throwaway owner design options

For spec [#1](https://github.com/Webriot/irisbeat/issues/1) and foundation [#2](https://github.com/Webriot/irisbeat/issues/2). DO NOT MERGE. This branch is a design artifact, not application foundation code. Open source under AGPL-3.0-only, matching the repository LICENSE.

Design question: Which information hierarchy best connects an anonymous Status page with a personal operator configuring a Monitor, without hiding outage, Maintenance, or missing observations?

## Open

Double-click `prototype.html`. It is the only runnable entry, with all CSS, JavaScript and fake data inline. No server, installation, assets, storage or network calls. A parent can read the complete file and pass its HTML directly to `html_preview`, then `html_render`.

- `prototype.html?variant=A`: Status ledger — full-width creation-order Monitor rows, 90-day bars and Incident history; operator table followed by configuration and installation settings.
- `prototype.html?variant=B`: Incident desk — Incident history dominates, with a narrower creation-order service ledger; operator keeps operational history alongside a configuration column.
- `prototype.html?variant=C`: Service inspector — creation-order Monitor navigation beside one selected Monitor's availability and Incidents; operator uses the same navigation for configuration.

The floating bottom arrows and left/right keys cycle options and update `?variant=`. Editing controls retain their arrow keys. Option changes retain in-memory edits. Refresh resets everything. This standalone artifact has no production bundle; the switcher belongs only to this throwaway file.

Use Status page / Operator and the Example selector. Enter prototype opens simulated administration: its prefilled value is a dummy, and it does not authenticate against anything. The code is readable and contains no real credentials. Page naming, Monitor configuration, publication, Maintenance replacement/early end, deletion and webhook saves operate only in memory. No check engine, alert delivery or authorization is implemented.

## Recommendation for discussion

Start owner evaluation with A. It exposes each published Monitor's current state, 90-day series and percentage together, scales down to foundation #2's single HTTP Monitor, and makes comparison easiest. B prioritizes the outage response; C prioritizes detailed inspection and editing. C requires a selection to inspect each Monitor's bars and is therefore a tradeoff against the spec's at-a-glance public history. This is a provisional design recommendation, not a selected winner or permission to implement. The parent will present all three and obtain owner confirmation.

## State coverage

- Website unavailable with an automatic open Incident; API in Maintenance; Backups awaiting its first receipt. Mixed Maintenance does not label the entire page Maintenance.
- Recovered, all-in-Maintenance, nothing-published, history-query failure and paused-context examples. Pause is a contract example from #1, not a personal subscription control.
- 90 UTC-day bars with up, down, degraded, Maintenance and empty states. Percentages derive from synthetic counted successes/failures; Maintenance/empty are excluded. No denominator displays Unavailable. Each bar exposes a UTC date/state on hover and to assistive technology.
- Series failure retains current state and Incidents. Current Incident times are UTC; public history is newest first within the displayed range. Operator history includes older private and deleted-Monitor Incidents.
- Publication changes do not delete operator data. Deletion removes public visibility and retains operator Incidents. Maintenance does not close the existing Incident. Monitor configuration is not a simulated detection engine.
- Public rendering omits private Monitor names, target URLs, webhook destinations and secrets; Prototype state reflects the visible Monitors. All source data is intentionally fake.

## Unresolved owner choices

1. Public hierarchy: simultaneous service comparison (A), Incident priority (B), or selection-driven detail (C).
2. Operator editing: below a Monitor table (A), beside the operational view (B), or through a persistent selector (C).
3. Whether public Incident history should always follow all Monitors or dominate the page during an outage.
4. Which elements to combine after owner evaluation. No decision is validated yet.

The shared typography/colors deliberately stay consistent so the choice is structural. Renderer theme variables have fallbacks; there is no html/body background, viewport-height layout, or enclosing outer card. Mobile CSS stacks columns without changing creation order.

## Verification

An ephemeral Node VM/DOM-stub check exercised all 36 combinations of three variants, six examples and two authenticated surfaces. It verified 90 bars per public Monitor, public exclusion of private Monitor names, empty publication, history failure retaining Incidents, arrow wraparound, deletion to an empty operator view and absence of external assets. Inline JavaScript parses. Browser layout, keyboard focus and inline renderer behavior still require owner/parent visual review; no browser render was requested in this child task.
