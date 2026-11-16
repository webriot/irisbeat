# Status ledger refinement

Design decisions and shared understanding confirmed by the owner.
The prototype will simulate live updates before production transport integration.

## Accepted decisions

- Preserve the selected Status ledger foundation. Refine the existing layout and
  styling rather than explore service cards or a split-pane replacement.
- Keep Monitors and Incidents in the operator's main workspace. Move page name
  and webhook configuration into Settings.
- Place New Monitor before Settings beside the heading. Put Edit first in the
  Monitor ellipsis menu alongside Maintenance, publication, and Delete actions;
  remove the separate Edit button. Confirm deletion.
- Offer System, Light, and Dark themes. Default to System and follow system
  changes until an override is selected. Remember explicit theme selection
  locally in the finished application.
- Explore the refinement as a throwaway UI prototype before production changes.
- Use smaller headings, tighter spacing, subtle borders, neutral surfaces, and
  color primarily for status. Give both themes deliberate palettes. Inline editor
  panels share the parent container’s 12px corner radius.
- Present Settings as a separate view within `/operator`, with a clear return
  to Monitors. Keep Monitor editing inline near the ledger.
- Retain 90-day availability bars. Use No observations for an empty percentage,
  one keyboard entry point per strip with arrow-key navigation, and day details
  on focus or tap.
- Update live data without hard page refreshes, preferring WebSockets. Patch
  only changed data and preserve unsaved fields, focus, and open menus. Keep
  manual Refresh available. Apply this to both public and operator views,
  removing the public timed document reload.
- Use scoped WebSocket change notifications followed by the existing authorized
  JSON reads. Fetch snapshots but patch only changed UI elements; wire-level
  field deltas are not required. Keep writes on HTTP.
- Reconnect automatically with backoff and synchronize immediately after
  reconnecting. While disconnected, poll JSON every 60 seconds while visible.
  Retain last-known data and show a compact stale-state indicator when fresh
  data cannot be fetched. Preserve the selected history day as updates arrive.

- Format Incident timestamps and selected history intervals with the browser
  locale and timezone. Maintenance input uses local time and names the browser
  timezone. Daily history remains aggregated by UTC calendar day: keep the
  90 UTC days label and format bucket dates in the browser locale without
  shifting their calendar dates. Store instants as full ISO timestamps.

## Constraints

Preserve creation order, status precedence, publication semantics, hosted
permissions, and authenticated target secrecy. Credentials remain in memory.
Current Monitor state, counted availability, and missing history remain distinct.
Do not add taglines, explanatory filler, or redundant secondary labels.

## Next step

The throwaway refinement is in `src/ui.prototype.html`, served locally by
`npm run prototype` on the existing `/` and `/operator` paths. Open
`http://localhost:4173/?variant=ledger` or
`http://localhost:4173/operator?variant=ledger`. It can also be opened as a
standalone HTML file. All mutations and scenario events are in memory; no
credentials, real monitoring targets, or production transport are used.

Use the bottom Prototype controls to simulate an Incident, Maintenance, unknown
state, pause, connection loss, or reconnect. Open State to inspect the fixture
and unsaved form values. Theme selection is in memory in this prototype.
The Monitor form is abbreviated for layout evaluation; production must retain
all existing kind-specific fields and validation.

The owner approved the design, including action ordering, locale/timezone
display, the consolidated actions menu, and matching editor corner radii.
The owner approved the six-ticket implementation breakdown. Archive the
approved prototype on a throwaway branch and link it from the implementation
issues before removing prototype code from the production branch.
The owner's instruction to preserve the selected foundation supersedes the
prototype skill's default of radically different layout variants.

The accepted visual choices are reversible UI decisions. The transport trade-off
is recorded in [ADR 0001](adr/0001-live-change-notifications.md).

## Prototype verification

Rendered at desktop width in light mode and mobile width in dark mode. Browser
assertions passed for unsaved Monitor and Settings drafts, focused input retention,
stable row nodes, open menus, history arrow-key navigation and a single tab entry,
delete cancellation, private Monitor visibility, and reconnect indication.
The JavaScript and local runner passed syntax checks. Production transport and
the production test suite were not exercised; this prototype is isolated.

After the owner's refinements, assertions passed for New Monitor preceding
Settings, Edit as the first ellipsis action, menu dismissal and editor focus,
draft preservation, and localized Incident/history display. Date helpers were
checked with en-US/America/Los_Angeles, de-DE/Europe/Berlin, and
en-GB/Asia/Kolkata, including midnight rollover and spring daylight-saving
transitions. UTC bucket labels retain their original calendar dates.
