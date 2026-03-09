# Feature: Worktree Management

## Overview

Rework worktree management so that every code task flow (code → review → commit) operates on its own git worktree and branch, rather than the current model of one worktree per agent. The worktree is created when the code task is created, inherited by all related tasks in the flow chain (review, commit, fix cycles), and cleaned up when the chain reaches a terminal state (commit completed, or root code task failed).

On team creation a new option, `--worktreeDir`, specifies the directory under which worktrees are created. If omitted, the default is a `worktrees` directory within the current working directory. The branch name convention is `<team-name>-<task-id>`, where `<task-id>` is the root code task of the flow.

## Architecture Decisions

### Choice: Worktree per flow chain, not per agent

- **Rationale:** The current model (`worktree.ts`) creates one worktree per agent (`<worktreesDir>/<agentName>`). With the code → review → commit flow (Feature 3), related tasks must operate on the same code changes. If worktrees are per-agent, the reviewing agent has no access to the coding agent's worktree — unless tasks are forcibly sticky to one agent, which defeats the purpose of independent review.
- **Trade-off:** Agents are no longer permanently associated with a directory. Instead, each task carries its worktree path in metadata, and the agent switches working directory per task. This is natural with `--keepContext` off (Feature 4) since each task spawns a fresh process with the correct `cwd`. With `--keepContext` on, the task prompt must include the working directory.
- **Why not sticky agents?** Forcing all tasks in a chain to the same agent makes code review performative — the same agent reviews its own work with the same biases. It also creates bottlenecks: the agent is blocked from other work until the entire chain completes.

### Choice: Worktree lifecycle tied to flow chain terminal states

- **Rationale:** Each worktree is a full checkout of the repo, so disk usage scales linearly with concurrent flow chains. However, the number of concurrent worktrees is bounded by the number of agents (you can only have as many in-progress code tasks as you have agents). Cleanup happens automatically at two terminal points: (a) commit task completes successfully, and (b) root code task is marked as `failed`. In both cases the git branch is preserved for later inspection or merging — only the working copy is removed.
- **Trade-off:** Between commit-complete and worktree-removal there is a brief window where the worktree exists but is unused. This is negligible. The real safeguard is that concurrent worktrees are bounded by agent count, not task count — 100 feature tasks with 4 agents means at most ~4 active worktrees at any time, processed as a rolling wave.

### Choice: `--worktreeDir` as a team-level configuration option

- **Rationale:** The worktree base directory applies to all flow chains in a team. Storing it in `TeamConfig` (set once at team creation or via `/team create`) keeps it consistent and accessible to both the leader and workers. The spec says the path can be absolute or relative. Relative paths are resolved against the leader's `cwd` at team creation time and stored as absolute in the config.
- **Trade-off:** Changing the worktree directory after tasks have been created would orphan existing worktrees. The option is therefore immutable once set — similar to the `--humanReview` flag.

### Choice: Workers discover worktree path from task metadata, not env vars

- **Rationale:** The current model passes `cwd` to the worker process at spawn time. With flow-chain worktrees, different tasks may have different `cwd` values, but the worker process is long-lived (unless `--keepContext` is off). Storing `worktreePath` in task metadata and including it in the task prompt is the most flexible approach. With `--keepContext` off (Feature 4, kill-and-respawn), the leader can set the correct `cwd` on the fresh process. With `--keepContext` on, the worker reads the path from the task prompt.
- **Trade-off:** Workers with `--keepContext` on must honour the directory instruction in the prompt. This is less reliable than a process-level `cwd`, but `--keepContext` off is the default, where this is not an issue.

### Choice: Concurrent safety guaranteed by dependency chain

- **Rationale:** The flow chain's dependency structure (review blocked by code, commit blocked by review) ensures only one task in a chain is `in_progress` at any time. Two agents can never simultaneously work in the same flow worktree. Fix cycles extend the chain but maintain the same serial property.
- **Trade-off:** No additional locking mechanism is needed beyond the existing task dependency system.

## Implementation Tasks

### Task 1: Add `worktreeDir` to `TeamConfig`

- **File:** `extensions/teams/team-config.ts` (existing — `TeamConfig` interface ~line 36)
- **Description:** Add an optional `worktreeDir` field to the `TeamConfig` interface and update the config read/write logic to persist it.
- **Details:**
  1. Add `worktreeDir?: string;` to the `TeamConfig` interface (after the `hooks` field).
  2. Update `coerceConfig()` (~line 133) to read `worktreeDir` from the JSON: `worktreeDir: typeof obj.worktreeDir === "string" ? obj.worktreeDir : undefined`.
  3. Update `ensureTeamConfig()` (~line 153) to accept `worktreeDir` in the `init` parameter and store it in the initial config if provided.
  4. The field is immutable after creation — `ensureTeamConfig` only writes on first creation, so subsequent calls won't overwrite it.
- **Dependencies:** None
- **Reference:** `TeamConfig` interface at `team-config.ts:36`. `coerceConfig` at `team-config.ts:133`. `ensureTeamConfig` at `team-config.ts:153`.

### Task 2: Add `--worktreeDir` flag to `/team create`

- **File:** `extensions/teams/leader-team-command.ts:34` (existing — `TEAM_HELP_TEXT`) and the `/team create` handler (added by Feature 1)
- **Description:** Parse a `--worktreeDir=<path>` flag on `/team create` and pass it through to `ensureTeamConfig`.
- **Details:**
  1. Add `--worktreeDir=<path>` to the `/team create` help text.
  2. In the `/team create` handler, parse `--worktreeDir=<value>` or `--worktreeDir <value>` from the args.
  3. If the path is relative, resolve it against `ctx.cwd` using `path.resolve(ctx.cwd, value)`.
  4. Validate the resolved path: it must be a plausible directory path (no null bytes, not empty). It does not need to exist yet — it will be created on first worktree creation.
  5. Pass `worktreeDir` to `ensureTeamConfig()`.
  6. If `--worktreeDir` is not supplied, the default is `path.resolve(ctx.cwd, "worktrees")` — store this resolved absolute path in the config so workers don't need to know the leader's original `cwd`.
- **Dependencies:** Task 1, Feature 1 (team identifier — `/team create` command)
- **Reference:** Flag parsing pattern at `leader-spawn-command.ts:58-91`. `ensureTeamConfig` call at `leader.ts:640-645`.

### Task 3: Update `session_start` and `session_switch` to persist `worktreeDir`

- **File:** `extensions/teams/leader.ts:631` (existing — `session_start`) and `leader.ts:683` (existing — `session_switch`)
- **Description:** When a team is created implicitly (no `/team create`), ensure a default `worktreeDir` is still written to the config.
- **Details:**
  1. In `session_start` and `session_switch`, the call to `ensureTeamConfig()` already exists (~line 640, ~line 695). Add `worktreeDir: path.resolve(ctx.cwd, "worktrees")` to the `init` object so that teams created implicitly also have a worktree directory configured.
  2. Since `ensureTeamConfig` only writes on first creation, this won't overwrite a `worktreeDir` set by a prior `/team create`.
- **Dependencies:** Task 1
- **Reference:** `session_start` at `leader.ts:631-670`. `session_switch` at `leader.ts:683-730`.

### Task 4: Rewrite `ensureWorktreeCwd` → `ensureFlowWorktree`

- **File:** `extensions/teams/worktree.ts` (existing — rewrite `ensureWorktreeCwd`)
- **Description:** Replace the per-agent worktree function with a per-flow-chain function. The new function creates a worktree for a specific root task ID.
- **Details:**
  1. Rename and rewrite `ensureWorktreeCwd` to `ensureFlowWorktree` with the signature:
     ```ts
     ensureFlowWorktree(opts: {
       leaderCwd: string;
       worktreeDir: string;
       teamId: string;
       rootTaskId: string;
     }): Promise<FlowWorktreeResult>
     ```
  2. `FlowWorktreeResult` extends the existing `WorktreeResult` with `branch: string`:
     ```ts
     type FlowWorktreeResult = {
       cwd: string;
       branch: string;
       warnings: string[];
       mode: "worktree" | "shared";
     };
     ```
  3. Branch name: `<teamId>-<rootTaskId>` (sanitised via `sanitizeName`).
  4. Worktree path: `<worktreeDir>/<teamId>-<rootTaskId>`.
  5. Retain the existing fallback logic: if not in a git repo, return `mode: "shared"` with a warning. If the worktree already exists, reuse it.
  6. Retain the dirty-working-directory warning.
  7. Keep `execGit` as an internal helper (unchanged).
  8. **Deprecate but keep** the old `ensureWorktreeCwd` function with a `@deprecated` JSDoc tag, so existing per-agent worktree spawn paths continue to work until fully migrated.
- **Dependencies:** None (can be done in parallel with Tasks 1-3)
- **Reference:** Current `ensureWorktreeCwd` at `worktree.ts:44-100`.

### Task 5: Add `removeFlowWorktree` function

- **File:** `extensions/teams/worktree.ts` (existing — add new export)
- **Description:** Add a function to clean up a flow worktree when the chain reaches a terminal state.
- **Details:**
  1. Signature:
     ```ts
     removeFlowWorktree(opts: {
       leaderCwd: string;
       worktreePath: string;
     }): Promise<{ removed: boolean; warnings: string[] }>
     ```
  2. Resolve the git repo root from `leaderCwd` (same as `ensureFlowWorktree`).
  3. Run `git worktree remove <worktreePath> --force`. The `--force` flag handles cases where the worktree has untracked files.
  4. If the worktree path doesn't exist or isn't a valid worktree, return `{ removed: false }` with a warning — don't throw.
  5. **Do not delete the branch.** The branch (`<teamId>-<rootTaskId>`) remains in git for inspection/merging.
  6. On failure (e.g. git unavailable), return `{ removed: false }` with a warning.
- **Dependencies:** None
- **Reference:** `execGit` helper at `worktree.ts:7-29`.

### Task 6: Add `listFlowWorktrees` function

- **File:** `extensions/teams/worktree.ts` (existing — add new export)
- **Description:** List active flow worktrees for observability and the `/team worktree` commands.
- **Details:**
  1. Signature:
     ```ts
     listFlowWorktrees(opts: {
       leaderCwd: string;
       worktreeDir: string;
     }): Promise<{ worktrees: Array<{ path: string; branch: string }>; warnings: string[] }>
     ```
  2. Run `git worktree list --porcelain` from the repo root.
  3. Parse output and filter to worktrees whose path starts with the `worktreeDir` prefix.
  4. Return the path and branch for each matching worktree.
- **Dependencies:** None
- **Reference:** `execGit` helper at `worktree.ts:7-29`.

### Task 7: Store `worktreePath` in task metadata during flow chain creation

- **File:** Leader flow-chain creation logic (Feature 3 — the leader code that creates code/review/commit task triplets)
- **Description:** When the leader creates a code task as part of a flow chain, create the worktree and store the path in the code task's metadata. Propagate the path to the linked review and commit tasks.
- **Details:**
  1. When creating a code task, call `ensureFlowWorktree({ leaderCwd: ctx.cwd, worktreeDir: teamConfig.worktreeDir, teamId, rootTaskId: codeTask.id })`.
  2. Store `metadata.worktreePath` and `metadata.worktreeBranch` on the code task.
  3. Copy `metadata.worktreePath` and `metadata.worktreeBranch` to the linked review and commit tasks.
  4. On fix cycles (review fails → new code + review tasks), copy the same `worktreePath` from the failed review task to the new tasks. The worktree is reused — the fix is committed to the same branch.
  5. If `ensureFlowWorktree` returns `mode: "shared"` (not a git repo), set `metadata.worktreePath` to the leader's `cwd` and `metadata.worktreeBranch` to `null`. Tasks proceed in shared mode.
- **Dependencies:** Tasks 4, Feature 3 (code → review → commit flow)
- **Reference:** Feature 3 plan for flow-chain task creation. `createTask` at `task-store.ts:163-185`.

### Task 8: Update worker to use task worktree path

- **File:** `extensions/teams/worker.ts` (existing — `buildTaskPrompt` ~line 99 and `maybeStartNextWork` ~line 350)
- **Description:** When a worker picks up a task, use the task's `metadata.worktreePath` as the working directory.
- **Details:**
  1. Update `buildTaskPrompt()` (~line 99): if the task has `metadata.worktreePath`, append a line to the prompt: `"Working directory: <path>\nYou MUST work in this directory. Run \`cd <path>\` before making any changes."`.
  2. In `maybeStartNextWork()`, after loading the task, read `metadata.worktreePath`. If present and the worker was spawned with `--keepContext` off (Feature 4 — fresh process per task), the leader should have already set the correct `cwd` for this task (see Task 9). With `--keepContext` on, the prompt instruction is the fallback.
  3. Update `sendIdleNotification()` (~line 420) to include the completed task's `worktreePath` in the payload so the leader can use it for cleanup decisions.
- **Dependencies:** Task 7
- **Reference:** `buildTaskPrompt` at `worker.ts:99-116`. `maybeStartNextWork` at `worker.ts:350-405`.

### Task 9: Update leader spawn/respawn to set `cwd` from task metadata

- **File:** `extensions/teams/leader.ts:534` (existing — worktree `cwd` selection in `spawnTeammate`)
- **Description:** When the leader spawns (or respawns, per Feature 4) a worker for a specific task, set the worker's `cwd` to the task's `metadata.worktreePath` instead of the per-agent worktree.
- **Details:**
  1. Currently (~line 534), the leader checks `if (workspaceMode === "worktree")` and calls `ensureWorktreeCwd` with the agent name. Replace this with logic that reads `worktreePath` from the task the worker is about to execute (if known at spawn time).
  2. With Feature 4 (kill-and-respawn per task), the leader knows the next task before spawning the fresh process. Pass the task's `metadata.worktreePath` as the `cwd`.
  3. For the initial spawn (no task yet — the worker will auto-claim), fall back to the leader's `cwd`. The worker will switch to the correct directory when it claims a task (via the prompt instruction from Task 8).
  4. Remove the per-agent worktree creation from the spawn path. The `workspaceMode` option on `/team spawn` is no longer needed — worktrees are created per flow chain, not per agent. Deprecate the `shared | worktree` spawn flag.
- **Dependencies:** Tasks 4, 8, Feature 4 (worker context management)
- **Reference:** Current worktree spawn logic at `leader.ts:534-538`. `spawnTeammate` function at `leader.ts:442-600`.

### Task 10: Implement worktree cleanup on chain completion

- **File:** `extensions/teams/leader.ts` (existing — leader inbox/idle-notification handler)
- **Description:** When the leader receives notification that a commit task has completed or a root code task has been marked as failed, clean up the associated worktree.
- **Details:**
  1. In the leader's idle-notification handler (or the hook chain that runs on task completion), detect when a completed task is a commit task (by `task.type === "commit"` from Feature 3).
  2. Read `metadata.worktreePath` from the completed commit task.
  3. Call `removeFlowWorktree({ leaderCwd: ctx.cwd, worktreePath })`.
  4. Update the commit task's metadata: `metadata.worktreeCleanedUp = true`, `metadata.worktreeCleanedUpAt = <ISO timestamp>`.
  5. Similarly, when a root code task is marked as `"failed"` (Feature 2), read its `metadata.worktreePath` and clean up.
  6. Log warnings from `removeFlowWorktree` to `ctx.ui.notify` at the `"warning"` level.
  7. If cleanup fails, the worktree is orphaned but harmless — the `/team worktree clean` command (Task 12) can handle it manually.
- **Dependencies:** Tasks 5, 7, Feature 2 (failed task status), Feature 3 (task types)
- **Reference:** Leader idle-notification handling. Hook chain at `leader.ts:200-400`.

### Task 11: Add `/team worktree list` command

- **File:** `extensions/teams/leader-team-command.ts` (existing — add new subcommand) and new file `extensions/teams/leader-worktree-commands.ts`
- **Description:** Add a command to list active flow worktrees for observability.
- **Details:**
  1. Register a `worktree` subcommand in `handleTeamCommand` that dispatches to subcommands `list` and `clean`.
  2. `/team worktree list`: call `listFlowWorktrees()`, display each worktree's path, branch, and (if determinable) the associated root task ID.
  3. Cross-reference with the task list to show the task's status (e.g. `in_progress`, `completed`, `failed`).
  4. If no worktrees are found, display `"No active worktrees"`.
  5. Add to `TEAM_HELP_TEXT`: `"  /team worktree list"` and `"  /team worktree clean [--force]"`.
- **Dependencies:** Task 6
- **Reference:** Subcommand dispatch pattern at `leader-team-command.ts:136-382`.

### Task 12: Add `/team worktree clean` command

- **File:** `extensions/teams/leader-worktree-commands.ts` (new file from Task 11)
- **Description:** Manually clean up worktrees whose flow chains have reached a terminal state (or force-clean all).
- **Details:**
  1. `/team worktree clean`: find worktrees whose associated flow chain is complete (commit task completed) or failed (root code task failed) but whose worktree was not automatically cleaned up. Call `removeFlowWorktree` for each.
  2. `/team worktree clean --force`: remove **all** flow worktrees, including those with in-progress chains. Require confirmation unless `--force` is combined with a non-interactive mode.
  3. Report the number of worktrees removed and any warnings.
  4. Cross-reference by parsing the branch name (`<teamId>-<taskId>`) to find the associated task and check its status.
- **Dependencies:** Tasks 5, 6, 11
- **Reference:** Confirmation pattern at `leader-task-commands.ts:352-368` (`/team task clear` uses the same `ctx.ui.confirm` approach).

### Task 13: Update leader teams tool schema for worktree deprecation

- **File:** `extensions/teams/leader-teams-tool.ts:84` (existing — `TeamsWorkspaceModeSchema`)
- **Description:** Deprecate the `workspaceMode` parameter on `delegate` and `member_spawn` actions, since worktrees are now flow-chain-scoped rather than agent-scoped.
- **Details:**
  1. Update the `TeamsWorkspaceModeSchema` description to note deprecation: `"Deprecated. Worktrees are now created per task flow chain, not per agent. This option is ignored."`.
  2. In the `member_spawn` handler (~line 479) and `delegate` handler (~line 942), ignore the `workspaceMode` parameter. Workers always start in the leader's `cwd` and switch to the flow worktree when picking up a task.
  3. Update the tool's main description (~line 169-171) to remove references to `workspaceMode=worktree`.
  4. In the `/team spawn` command handler (`leader-spawn-command.ts:49`), still accept `shared | worktree` to avoid breaking existing usage, but emit a deprecation warning: `"The 'worktree' spawn option is deprecated. Worktrees are now created per task flow chain."`.
- **Dependencies:** Task 9
- **Reference:** `TeamsWorkspaceModeSchema` at `leader-teams-tool.ts:84`. Spawn command at `leader-spawn-command.ts:49`.

### Task 14: Integration tests

- **File:** New file `extensions/teams/__tests__/worktree-flow.test.ts`
- **Description:** Automated tests for the flow-chain worktree lifecycle.
- **Details:**
  - **Test 1:** `ensureFlowWorktree()` creates a worktree at `<worktreeDir>/<teamId>-<taskId>` with the correct branch name.
  - **Test 2:** `ensureFlowWorktree()` reuses an existing worktree (idempotent).
  - **Test 3:** `ensureFlowWorktree()` falls back to shared mode when not in a git repo.
  - **Test 4:** `removeFlowWorktree()` removes the worktree directory but preserves the branch.
  - **Test 5:** `removeFlowWorktree()` returns `removed: false` with a warning for a non-existent path.
  - **Test 6:** `listFlowWorktrees()` returns only worktrees under the configured `worktreeDir`.
  - **Test 7:** `TeamConfig` round-trips `worktreeDir` correctly through `ensureTeamConfig` / `loadTeamConfig`.
  - **Test 8:** Relative `--worktreeDir` is resolved to absolute before storage.
  - **Test 9:** Default `worktreeDir` is `<cwd>/worktrees` when not specified.
  - **Test 10:** Flow-chain worktree cleanup on commit task completion — worktree removed, branch preserved.
  - **Test 11:** Flow-chain worktree cleanup on root code task failure — worktree removed.
  - **Test 12:** Fix cycle reuses the same worktree (new code + review tasks inherit `worktreePath`).
- **Dependencies:** Tasks 1-7

## Testing Strategy

**Unit Tests:**
- `ensureFlowWorktree`: creation, reuse, fallback, branch naming.
- `removeFlowWorktree`: removal, non-existent path, git unavailable.
- `listFlowWorktrees`: filtering by `worktreeDir` prefix.
- `TeamConfig` serialisation with `worktreeDir`.
- `--worktreeDir` flag parsing: absolute, relative, missing.

**Integration Tests:**
- Full lifecycle: code task created → worktree created → review inherits path → commit inherits path → commit completes → worktree removed → branch preserved.
- Failure lifecycle: code task → review fails → fix cycle reuses worktree → max cycles → code task failed → worktree removed.
- `/team worktree list` shows correct active worktrees with task status.
- `/team worktree clean` removes only terminal-state worktrees.

**Edge Cases:**
- Not in a git repo → graceful fallback to shared mode, no worktree created.
- Dirty working directory → worktree created from HEAD with warning.
- `worktreeDir` doesn't exist yet → created on first `ensureFlowWorktree` call.
- Worktree removal fails (e.g. permission error) → warning logged, task metadata notes failure.
- Concurrent flow chains with 4 agents → at most 4 active worktrees at a time.
- `/team worktree clean --force` while a chain is in progress → confirmation required.

## Integration Points

**Existing systems affected:**
- `worktree.ts` — `ensureWorktreeCwd` deprecated, replaced by `ensureFlowWorktree`, `removeFlowWorktree`, and `listFlowWorktrees`.
- `team-config.ts` — `TeamConfig` extended with `worktreeDir`.
- `leader.ts` — `session_start`/`session_switch` pass `worktreeDir` to `ensureTeamConfig`. Spawn path updated to use task metadata `cwd` instead of per-agent worktree. Cleanup logic added to idle-notification/hook-chain handler.
- `leader-team-command.ts` — New `worktree` subcommand registered in dispatcher and help text. `/team create` accepts `--worktreeDir`.
- `leader-spawn-command.ts` — `worktree` spawn flag deprecated with warning.
- `leader-teams-tool.ts` — `TeamsWorkspaceModeSchema` deprecated, `workspaceMode` parameter ignored.
- `worker.ts` — `buildTaskPrompt` includes worktree path. Idle notification includes `worktreePath`.

**Depends on (from other features):**
- Feature 1 (team identifier) — `/team create` command where `--worktreeDir` is parsed.
- Feature 2 (failed task status) — cleanup triggered when root code task is marked `"failed"`.
- Feature 3 (code → review → commit flow) — flow-chain task creation where `worktreePath` metadata is set and propagated.
- Feature 4 (worker context management) — kill-and-respawn model where the leader sets `cwd` per task.

**No changes required to:**
- `task-store.ts` — `metadata` is already `Record<string, unknown>`, no schema change needed.
- `paths.ts` — `getTeamDir()` unchanged; `worktreeDir` is a separate config field.
- `mailbox.ts` / `protocol.ts` — message format unchanged (idle notification already accepts arbitrary fields).
- `cleanup.ts` — team directory cleanup is orthogonal to worktree cleanup (worktrees live outside the team directory).
- `team-attach-claim.ts` — attach logic unaffected.
