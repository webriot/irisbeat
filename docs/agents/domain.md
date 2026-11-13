# Domain docs

## Before exploring

Read root `GLOSSARY.md` and the ADRs in `docs/adr/` relevant to the work.

If these files do not exist, proceed silently. Do not flag their absence or propose creating them upfront. The `domain-modeling` skill creates them lazily as terms or decisions are resolved.

## Layout

This repository uses a single context:

- `GLOSSARY.md`: shared domain vocabulary.
- `docs/adr/NNNN-<decision>.md`: architecture decisions.

A separate hosted consumer does not make this repository a monorepo.

## Vocabulary

Use glossary terms in issue titles, proposals, hypotheses, code, and tests. If a concept is missing, reconsider the wording or note the gap for `domain-modeling`.

## ADR conflicts

Explicitly identify any proposal that contradicts an existing ADR and explain why the decision should be reopened.
