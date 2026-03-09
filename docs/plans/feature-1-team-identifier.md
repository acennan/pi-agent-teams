# Feature: Team Identifier

## Overview

Allow users to supply a human-readable team identifier at team creation time via `--id=my-team-name`. When provided, this identifier replaces the opaque session ID as the team's unique key (used for the team directory name, task list namespace, environment variables, widget display, etc.). If omitted, the current session-ID-based mechanism applies unchanged.

Because the identifier maps 1-to-1 to a directory under `<teamsRoot>/`, it **must** be unique. Attempting to create a team with an already-existing identifier produces an error asking the user to choose a different name.

## Architecture Decisions

### Choice: New `/team create --id=<name>` subcommand

- **Rationale:** Currently teams are created implicitly during `session_start` (`leader.ts:631`) using the session ID. A `--id` flag doesn't fit on `/team spawn` because the team identity must be established *before* the first spawn — it determines the team directory, task list, config, and session directory. A dedicated `/team create` command makes this explicit and allows the user to set the ID before spawning any workers.
- **Trade-off:** Adds a new step to the workflow. Previously, `/team spawn` was all you needed. Now users who want a custom ID run `/team create --id=my-team` first. Users who don't care about the ID continue exactly as before (the team is still created implicitly on `session_start` with the session ID).
- **Why not an env var?** An env var like `PI_TEAMS_ID` is set per-process, meaning only one custom-ID team could run at a time. A command-line option on a subcommand allows multiple pi sessions to each create teams with different custom IDs concurrently.

### Choice: `/team create` re-initialises the current session's team identity

- **Rationale:** `session_start` already creates a team with the session ID. `/team create --id=my-team` will: (a) validate and check uniqueness, (b) update `currentTeamId` and `taskListId` to the custom ID, (c) create the new team directory and config. The old session-ID-based directory remains but is effectively abandoned. This avoids needing to delay `session_start` initialisation.
- **Trade-off:** A stale directory from the auto-created session-ID team is left behind. This is harmless — `/team cleanup` already handles stale team directories. Could optionally be cleaned up automatically.

### Choice: Validate with strict regex, reject invalid input

- **Rationale:** `sanitizeName()` (`names.ts:6`) silently strips bad characters, which could lead to surprising IDs (e.g. `my team!` → `my-team-`). For a user-chosen identifier, explicit rejection with an error message is more transparent. The ID must match `^[a-zA-Z0-9][a-zA-Z0-9_-]*$` (starts with alphanumeric, then alphanumeric/hyphens/underscores). Max length 64 characters to avoid filesystem issues.

### Choice: Uniqueness check via directory existence + attach claim

- **Rationale:** `getTeamDir(teamId)` (`paths.ts:20`) maps to `<teamsRoot>/<teamId>`. If the directory exists with a fresh attach claim from another session, the ID is in use — reject it. If the directory exists but the claim is stale or absent (from a previous session), allow re-use so a user can restart pi and reclaim their named team.

## Implementation Tasks

### Task 1: Add `/team create` subcommand with `--id` flag

- **File:** `extensions/teams/leader-team-command.ts:34` (existing — `TEAM_HELP_TEXT`) and `extensions/teams/leader-team-command.ts:136` (existing — `handlers` record)
- **Description:** Register a new `create` subcommand in the `handleTeamCommand` dispatcher. Parse the `--id=<name>` (or `--id <name>`) flag from the `rest` args.
- **Details:**
  1. Add `"  /team create --id=<name>"` to `TEAM_HELP_TEXT` (after the `/team id` line).
  2. Add a `create` entry to the `handlers` record in `handleTeamCommand` that calls a new `handleTeamCreateCommand` function.
  3. Pass through: `ctx`, `rest`, plus callbacks `setActiveTeamId`, `setTaskListId`, `refreshTasks`, `renderWidget`, and access to `getActiveTeamId` (to read the current ID).
- **Dependencies:** None
- **Reference:** Pattern for subcommand dispatch at `leader-team-command.ts:136-382`. Pattern for `--flag` parsing at `leader-spawn-command.ts:58-91`.

### Task 2: Implement `handleTeamCreateCommand`

- **File:** `extensions/teams/leader-lifecycle-commands.ts` (existing — add new export) or new file `extensions/teams/leader-create-command.ts`
- **Description:** Core logic for `/team create --id=<name>`: validate, check uniqueness, set team identity.
- **Details:**
  1. Parse `--id=<value>` or `--id <value>` from `rest` args. If `--id` is missing, show usage and return.
  2. **Validate format:** must match `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`. On failure, notify: `"Invalid team ID '<value>': must start with a letter or digit, contain only alphanumeric characters, hyphens, and underscores, and be at most 64 characters."`.
  3. **Check uniqueness:** call `getTeamDir(id)` and check if directory exists.
     - If it exists, read the attach claim via `readTeamAttachClaim(teamDir)`.
     - If a fresh claim exists from a *different* session → error: `"Team ID '<value>' is already in use by another session. Choose a different name."`.
     - If no claim or stale claim → allow (re-attach scenario).
  4. **Set identity:** call `setActiveTeamId(id)` and `setTaskListId(id)` (these update `currentTeamId` and `taskListId` in `runLeader`).
  5. **Create team directory and config:** call `ensureTeamConfig(getTeamDir(id), { teamId: id, taskListId: id, leadName: "team-lead", style })`.
  6. **Acquire attach claim:** call `acquireTeamAttachClaim(teamDir, sessionId)`.
  7. **Refresh and notify:** call `refreshTasks()`, `renderWidget()`, then notify: `"Team created with ID: <value>"`.
  8. **Guard against post-spawn use:** if teammates already exist (workers already spawned), reject with `"Cannot change team ID after workers have been spawned. Use /team create before /team spawn."`.
- **Dependencies:** Task 1
- **Reference:** `ensureTeamConfig` at `team-config.ts:153`. `acquireTeamAttachClaim` at `team-attach-claim.ts:97`. `handleTeamAttachCommand` at `leader-attach-commands.ts:22` (similar pattern of switching the active team ID).

### Task 3: Update `session_start` and `session_switch` to preserve custom ID

- **File:** `extensions/teams/leader.ts:631` (existing — `session_start` handler) and `leader.ts:683` (`session_switch` handler)
- **Description:** Currently, `session_start` unconditionally sets `currentTeamId = ctx.sessionManager.getSessionId()`. This would overwrite a custom ID if the session restarts. Store a flag indicating a custom ID was set, and honour it on session events.
- **Details:**
  1. Add a new variable `let customTeamId: string | null = null;` alongside `currentTeamId` in `runLeader` (~line 117).
  2. In the `setActiveTeamId` callback (passed to `handleTeamCommand`, line ~905), also set `customTeamId = teamId` when called from `/team create`. Add a companion `setCustomTeamId` callback or a boolean flag to distinguish a `/team create` call from a `/team attach` call.
  3. In `session_start`: change `currentTeamId = currentCtx.sessionManager.getSessionId()` to `currentTeamId = customTeamId ?? currentCtx.sessionManager.getSessionId()`. Same for `taskListId`.
  4. In `session_switch`: same override — `currentTeamId = customTeamId ?? currentCtx.sessionManager.getSessionId()`.
  5. Ensure `ensureTeamConfig` is called with the correct (potentially custom) `teamId`.
- **Dependencies:** Task 2
- **Reference:** Current `session_start` handler at `leader.ts:628-673`. Current `session_switch` handler at `leader.ts:675-730`.

### Task 4: Update `shortTeamId` for human-readable IDs

- **File:** `extensions/teams/teams-widget.ts:44` (existing) and `extensions/teams/teams-panel.ts:45` (existing)
- **Description:** `shortTeamId` truncates at 12 chars, which mangles human-readable names like `my-feature-team` into `my-featu…`. Increase the threshold for non-UUID-style IDs.
- **Details:**
  1. Detect whether the ID looks like a machine-generated UUID/session ID (32+ hex chars and hyphens). If so, keep the current truncation.
  2. For shorter, human-readable IDs (≤ 24 chars), display in full.
  3. For human-readable IDs > 24 chars, truncate at 21 chars with `…`.
  4. Apply the same logic in both `teams-widget.ts` and `teams-panel.ts` (extract to a shared utility in `teams-ui-shared.ts` if not already shared).
- **Dependencies:** None (can be done in parallel with Tasks 1-3)
- **Reference:** Current implementation at `teams-widget.ts:44-46` and `teams-panel.ts:45`.

### Task 5: Update help text and `/team id` command output

- **File:** `extensions/teams/leader-team-command.ts:34` (existing — `TEAM_HELP_TEXT`) and `extensions/teams/leader-info-commands.ts:50` (existing — `handleTeamIdCommand`)
- **Description:** Document the new `/team create` command. Update `/team id` to show whether the active ID is custom or session-derived.
- **Details:**
  1. `TEAM_HELP_TEXT`: add `/team create --id=<name>` line (done as part of Task 1).
  2. `handleTeamIdCommand` (`leader-info-commands.ts:63-74`): add a line `source: custom (my-team-name)` vs `source: session`. This requires passing a flag or the `customTeamId` value into `handleTeamIdCommand`.
  3. Update the `handleTeamIdCommand` opts type to include `customTeamId: string | null`.
- **Dependencies:** Task 2
- **Reference:** `leader-info-commands.ts:50-75`.

### Task 6: Propagate custom team ID to spawned workers (verification)

- **File:** `extensions/teams/leader.ts:442` (existing — `spawnTeammate` method)
- **Description:** Verify the custom team ID flows to child workers. This is a **verification-only** task — no code changes expected.
- **Details:**
  1. In `spawnTeammate`, `teamId` is derived from `currentTeamId ?? ctx.sessionManager.getSessionId()` (line ~474). Since `/team create` updates `currentTeamId`, this naturally propagates the custom ID.
  2. `PI_TEAMS_TEAM_ID` and `PI_TEAMS_TASK_LIST_ID` env vars (line ~560-561) are set from `teamId` / `taskListId`.
  3. **Verify manually:** run `/team create --id=test-team`, then `/team spawn agent-1`. Check the worker's env to confirm `PI_TEAMS_TEAM_ID=test-team`.
- **Dependencies:** Tasks 2, 3

### Task 7: Integration tests

- **File:** New file, e.g. `extensions/teams/__tests__/team-identifier.test.ts`
- **Description:** Automated tests for the custom team ID feature.
- **Details:**
  - **Test 1:** `/team create --id=alpha-team` creates directory `<teamsRoot>/alpha-team` with correct `teamConfig.teamId`.
  - **Test 2:** `/team create --id=alpha-team` when that directory has a fresh attach claim from another session → error message.
  - **Test 3:** `/team create --id=alpha-team` when directory exists but claim is stale → succeeds (re-attach).
  - **Test 4:** `/team create --id=bad name!` → validation error.
  - **Test 5:** `/team create --id=` (empty) → usage error.
  - **Test 6:** `/team create` (no `--id` flag) → usage error.
  - **Test 7:** `/team create --id=foo` after workers are already spawned → error.
  - **Test 8:** Omitting `/team create` entirely → session ID used as before (existing behaviour preserved).
  - **Test 9:** `shortTeamId("alpha-team")` returns `"alpha-team"` (not truncated).
  - **Test 10:** `shortTeamId` with a 36-char UUID still truncates.
- **Dependencies:** Tasks 1-5

## Testing Strategy

**Unit Tests:**
- ID validation regex: `my-team` ✓, `team_1` ✓, `abc123` ✓, `my team` ✗, `bad/name` ✗, empty string ✗, 65-char string ✗, starts-with-hyphen ✗.
- `shortTeamId` — thresholds for human-readable names vs UUIDs.
- Flag parsing in `handleTeamCreateCommand` — `--id=val`, `--id val`, missing `--id`, extra args.

**Integration Tests:**
- Full `/team create --id=foo` → directory + config created, `currentTeamId` updated.
- Spawn worker after `/team create` → worker env has custom ID.
- Uniqueness enforcement → active claim blocks, stale claim allows.
- `/team id` output reflects custom vs session source.

**Edge Cases:**
- `/team create --id=foo` then `/team create --id=bar` (change ID before spawning) → should work, second call wins.
- Very long custom ID (64 chars) → accepted. 65 chars → rejected.
- `/team create --id=foo` in two concurrent pi sessions → first wins, second gets uniqueness error.

## Integration Points

**Existing systems affected:**
- `leader.ts` — new `customTeamId` variable; `session_start` / `session_switch` handlers updated to honour it.
- `leader-team-command.ts` — new `create` subcommand in dispatcher and help text.
- `teams-widget.ts` / `teams-panel.ts` — `shortTeamId` display logic.
- `leader-info-commands.ts` — `/team id` output enhanced.

**No changes required to:**
- `paths.ts` — `getTeamDir()` already takes any string.
- `team-config.ts` — `ensureTeamConfig()` stores whatever `teamId` is passed.
- `task-store.ts` — tasks use `taskListId`, which follows `currentTeamId`.
- `worker.ts` — workers read `PI_TEAMS_TEAM_ID` from env, set by the leader.
- `team-discovery.ts` — `listDiscoveredTeams()` iterates directories; custom-named directories are discovered automatically.
- `leader-spawn-command.ts` — no changes; spawn reads `currentTeamId` which is already set.
