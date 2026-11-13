# Issue tracker: GitHub

Issues and specs live in https://github.com/Webriot/irisbeat/issues. Use the `gh` CLI for all operations, targeting `--repo Webriot/irisbeat` explicitly when outside this clone.

## Conventions

- Create: `gh issue create --title "..." --body-file <file>`.
- Read: `gh issue view <number> --json number,title,body,labels,comments`.
- List: `gh issue list --state open --json number,title,body,labels,comments`; add label and state filters as needed. Use `--limit` or paginated API calls when the complete set is needed.
- Comment: `gh issue comment <number> --body-file <file>`.
- Apply or remove labels: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close: `gh issue close <number> --comment "..."`.
- Link a child: `gh issue create --parent <parent> ...`, or `gh issue edit <parent> --add-sub-issue <child>` (`gh` 2.94+). On older versions, use `gh api --method POST repos/Webriot/irisbeat/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>`. If sub-issues are unavailable, add the child to the parent's task list and put `Part of #<parent>` at the top of the child body.

Write multiline issue bodies and comments to a temporary file and pass `--body-file`.
Use the vocabulary in `triage-labels.md` for triage state.

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub shares issue and PR numbers. Resolve ambiguous references before acting: try `gh pr view <number>`, then `gh issue view <number>`.

## Skill operations

When a skill says "publish to the issue tracker", create a GitHub issue.
When it says "fetch the relevant ticket", read the referenced GitHub issue.

## Wayfinding operations

- Map: one issue labelled `wayfinder:map`, containing Notes, Decisions-so-far, and Fog.
- Child ticket: link it to the map using a sub-issue or the fallback above. Apply `wayfinder:<type>` (`research`, `prototype`, `grilling`, or `task`). Create missing wayfinder labels when that workflow is first used.
- Blocking: use native dependencies: `gh api --method POST repos/Webriot/irisbeat/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`. Get the database ID with `gh api repos/Webriot/irisbeat/issues/<blocker> --jq .id`; it is not the issue number or node ID. If unavailable, put `Blocked by: #<n>, #<n>` at the top of the child body.
- Frontier: read the map's open children in map order. Skip assigned tickets and tickets with open blockers (`issue_dependencies_summary.blocked_by > 0`, or any open issue in the fallback line). Select the first remaining ticket.
- Claim: `gh issue edit <number> --add-assignee @me` as the session's first write.
- Resolve: comment with the answer, close the child, then append a context pointer (gist and link) to the map's Decisions-so-far.
