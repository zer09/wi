# Wi v0.1 vertical-slice release-candidate checklist

This checklist prepares the milestone marker. It does not authorize a tag by itself.

## Identity and scope

- [ ] Milestone 9 implementation commit and reviewed base/head SHAs are recorded.
- [ ] Diff contains only final acceptance, documentation, operational reference, and release preparation.
- [ ] No OpenAI, ChatGPT OAuth, `codex app-server`, remote hosting, real host tools, or plugin implementation entered the slice.
- [ ] No unresolved accepted-ADR contradiction exists.

## Documentation

- [ ] Root README setup, build, run, storage, test, security, and support links match current code.
- [ ] Architecture overview and diagrams match runtime ownership and package boundaries.
- [ ] Browser protocol examples match strict schemas.
- [ ] Event catalog matches `SESSION_EVENT_TYPES` and event data schemas.
- [ ] Catalog/session migration versions and retained-version behavior match source migrations.
- [ ] Failure/recovery matrix matches current process tests.
- [ ] Environment variables and fixed operational limits match source constants.
- [ ] Test/fuzz reproduction guidance matches scripts and workflow behavior.
- [ ] Security model and known limitations clearly distinguish implemented and deferred behavior.
- [ ] Troubleshooting avoids destructive repair advice.

## Automated acceptance

- [ ] `tests/e2e/milestone9-final-acceptance.spec.ts` passes from the working tree.
- [ ] It uses a real server, browser, SQLite workers, fake provider/tools, and real process restart.
- [ ] It proves backend work survives tab closure and exact replay.
- [ ] Pending approval survives restart and guarded tool execution occurs once.
- [ ] Duplicate command ID returns the original run with no new durable head.
- [ ] Incomplete provider tool call executes no tool.
- [ ] Production replay-backlog overflow closes with `4409 / slow consumer` and reconstructs exact final UI state.
- [ ] Session database files are distinct; catalog listing does not eagerly open an idle sentinel session.
- [ ] Event update/delete are rejected; the actual HttpOnly browser credential is absent from browser-visible storage, catalog/session exports, logs, and retained fixture artifacts.
- [ ] Temporary homes, browser contexts, child processes, and logs are removed.

## Local final matrix

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test:unit`
- [ ] `pnpm test:integration`
- [ ] `pnpm test:property`
- [ ] `pnpm test:process`
- [ ] `pnpm test:e2e`
- [ ] `pnpm build`
- [ ] `pnpm test:fuzz -- --duration=60s`
- [ ] `pnpm check`
- [ ] workflow YAML parses locally
- [ ] `git diff --check`

## Clean detached worktree

- [ ] Create a detached worktree at the proposed implementation commit outside the active tree.
- [ ] `pnpm install --frozen-lockfile`
- [ ] `pnpm check`
- [ ] focused Milestone 9 acceptance test
- [ ] cleanup confirms no worker/server/browser descendant remains
- [ ] remove the detached worktree

## Repository hygiene

- [ ] Tracked tree contains no `.artifacts`, temporary SQLite homes, WAL/SHM files, logs, browser profiles, Playwright reports, test results, or secrets.
- [ ] `prompts/` remains untracked and unstaged.
- [ ] Lockfile is unchanged unless a deliberate dependency change requires it.
- [ ] No contradictory TODO/skip/only marker was introduced.
- [ ] Bundled runtime dependencies remain covered by their package licenses; this private workspace adds no new dependency in Milestone 9.

## Remote review and CI

- [ ] Commit is pushed only after local review authorization.
- [ ] PR head equals the independently reviewed head.
- [ ] `CI / checks` succeeds.
- [ ] `CI / e2e` succeeds, including final acceptance.
- [ ] Stable required check `CI / required` succeeds.
- [ ] Active repository ruleset `protect-master` still applies to the default branch and strictly requires the GitHub Actions `required` context with no bypass actor.
- [ ] Independent remote review authorizes merge.
- [ ] Actual merge tree equals the approved implementation tree.
- [ ] Post-merge CI succeeds on the exact merge commit.

## Marker

Only after separate Milestone 9 review, merge identity verification, and post-merge CI pass:

```sh
git tag -a v0.1.0-vertical-slice -m "Wi v0.1.0 vertical slice"
```

Verify the tag target locally before any explicit push authorization:

```sh
git show --no-patch --decorate v0.1.0-vertical-slice
```

Do not push the tag as part of Milestone 9 implementation. Tag publication is a separate hosted write requiring explicit authorization.
