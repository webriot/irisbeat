# Global instructions

- Cut taglines, helper text and secondary labels. If a screen needs them to make sense, fix the layout.
- Make the best decision that will elevate all three: the user experience (UX), developer experience (DX), and agent experience (AX) always, without breaking anything.

# Project boundaries

Read `README.md` before planning product changes; it defines the public application and hosted integration boundary.
Keep infrastructure and secrets out of this public repository. Preserve third-party license notices.
Describe this project's own code as open source under AGPL-3.0-only; see `LICENSE`.

## Agent skills

### Issue tracker

Track issues and specs in Webriot/irisbeat GitHub Issues using `gh`. Before reading, creating, or updating tickets, read `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default triage labels. Before assigning triage state, read `docs/agents/triage-labels.md`.

### Domain docs

Use a single-context layout: root `GLOSSARY.md` and `docs/adr/`. Before exploring the codebase, read `docs/agents/domain.md`.
