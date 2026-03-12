## New Features to Add

## Feature 1: Team Identifier

The team uses a string as a unique identifier to enable output from different teams to be kept in isolation. This is currently being set as the session identifier. The format of this is not intuitive, meaning that it is hard to identify which folder belongs with which team.

A better solution would be to allow the team identifier to be set on team creation via a command line option, such as `--id=my-team-name`. If this option is supplied, then it should be used instead of the session identifier. If not, then the current mechanism will apply. 

As the identifier must be unique, it needs to be checked at team creation to ensure it is. If not, an error should be displayed and the user told to select a different name.



## Feature 2: Code → Review → Commit Flow and Related Tasks

Feature that defines the core task flow: **code → review → commit**.

### Task Types

A new `type` field should be added to `TeamTask` with the possible values `"code"`, `"review"`, and `"commit"`. When tasks are initially created for a feature, they are created as a linked triplet:
- A code task
- A review task (blocked by the code task)
- A commit task (blocked by the review task)

### Metadata Linking — Initial Creation

Relationships between tasks are captured via `metadata` properties on `TeamTask`:

- Code task: `"reviewTaskId": "<review-task-id>"`
- Review task: `"codeTaskId": "<code-task-id>"`, `"commitTaskId": "<commit-task-id>"`
- Commit task: `"reviewTaskId": "<review-task-id>"`

Example — tasks 16 (code), 17 (review), 18 (commit):
```json
{
  "id": "16",
  "type": "code",
  "blocks": ["17"],
  "metadata": {"source": "docs/plans/feature-X.md", "reviewTaskId": "17"}
}
```
```json
{
  "id": "17",
  "type": "review",
  "blockedBy": ["16"],
  "blocks": ["18"],
  "metadata": {"source": "docs/plans/feature-X.md", "codeTaskId": "16", "commitTaskId": "18"}
}
```
```json
{
  "id": "18",
  "type": "commit",
  "blockedBy": ["17"],
  "metadata": {"source": "docs/plans/feature-X.md", "reviewTaskId": "17"}
}
```

### Review Result Contract (Hybrid Approach)

When a review worker completes its task, it outputs a structured result describing the outcome. The **worker recommends, the leader executes**:

1. The review worker completes its task with a structured JSON result:
```json
{
  "reviewOutcome": "fail",
  "summary": "Missing error handling in 3 functions",
  "issues": [
    {"file": "src/api.ts", "line": 42, "description": "No null check on response"},
    {"file": "src/api.ts", "line": 87, "description": "Unhandled promise rejection"}
  ]
}
```
A passing review would be:
```json
{
  "reviewOutcome": "pass",
  "summary": "All checks passed"
}
```

2. The **leader** receives the task completion notification, inspects the review task's structured result (stored in `metadata.result`), and decides what to do:
   - If `"pass"`: the commit task is unblocked and proceeds normally.
   - If `"fail"`: the leader checks the cycle count. If under the limit (`PI_TEAMS_MAX_REVIEW_CYCLES`), it creates a new code + review task pair. If at the limit, it marks the current code task as `"failed"` (Feature 3).

This keeps workers simple (they only do work and report results) and centralises orchestration logic in the leader.

### Metadata Linking — On Review Failure

When a review fails and the leader creates new fix tasks, the following metadata updates are made:

- The **failed review task** gets a `"childCodeTaskId"` pointing to the new code task.
- The **new code task** gets a `"parentReviewTaskId"` pointing to the failed review.
- The **new review task** gets linked to the existing commit task via `"commitTaskId"`.
- The **existing commit task** is updated: its `blockedBy` is changed from the old review to the new review, and its `"reviewTaskId"` metadata is updated to point to the new review.

Example — review task 17 fails, leader creates code task 23 and review task 24, commit task 18 is rewired:
```json
{
  "id": "16",
  "type": "code",
  "status": "completed",
  "metadata": {"source": "docs/plans/feature-X.md", "reviewTaskId": "17"}
}
```
```json
{
  "id": "17",
  "type": "review",
  "status": "completed",
  "metadata": {"source": "docs/plans/feature-X.md", "codeTaskId": "16", "commitTaskId": "18", "childCodeTaskId": "23"}
}
```
```json
{
  "id": "23",
  "type": "code",
  "blocks": ["24"],
  "metadata": {"source": "docs/plans/feature-X.md", "reviewTaskId": "24", "parentReviewTaskId": "17"}
}
```
```json
{
  "id": "24",
  "type": "review",
  "blockedBy": ["23"],
  "blocks": ["18"],
  "metadata": {"source": "docs/plans/feature-X.md", "codeTaskId": "23", "commitTaskId": "18"}
}
```
```json
{
  "id": "18",
  "type": "commit",
  "blockedBy": ["24"],
  "metadata": {"source": "docs/plans/feature-X.md", "reviewTaskId": "24"}
}
```

The key changes on failure:
- Failed review task 17 is updated to point to the child code task 23 it spawned.
- New code task 23 points back to the review 17 that created it.
- New review task 24 inherits the commit task link from the failed review.
- Commit task 18 is rewired to be blocked by the new review 24 (not the old review 17). We do not track where the commit task previously pointed — only the current link matters.

### Task Flow Command

A new command, `/team task flow <id>`, takes a task identifier and displays the complete task flow chain it belongs to. The command traverses metadata links across all task types (code, review, commit) to reconstruct the full chain.

For task 17 in the failure example above:
```
16 -> <17> -> 23 -> 24 -> 18
```

For task 18:
```
16 -> 17 -> 23 -> 24 -> <18>
```

The requested task is highlighted with angle brackets. The traversal follows all metadata link types (`reviewTaskId`, `codeTaskId`, `commitTaskId`, `parentReviewTaskId`, `childCodeTaskId`) to walk the full chain in both directions.

### Quality-Gate Hooks

The existing quality-gate hook mechanism (`on_task_completed`) can continue to run as an **additional validation layer** (e.g. running linting or tests) independent of the structured review result. However, the reopen/followup logic it currently drives is replaced by the structured flow described above. The hook's role becomes purely informational — reporting pass/fail — while the leader's flow logic handles task creation and cycle management.



## Feature 3: Add failed Task Status

Add support for a `"failed"` task status. A task is set to `"failed"` when it cannot be completed due to cyclic review failures.

### Cycle Detection

The cycle count is determined by counting how many review-type tasks in a task's flow chain have failed.

A cycle occurs when the code → review flow repeats due to review failure:
1. An agent implements a code task.
2. The review task fails.
3. The leader creates new code + review tasks to fix the issues.
4. The new review task fails again.

Each iteration creates new linked tasks (see Feature 2) rather than reopening the original. The cycle count is tracked by counting the number of failed review tasks in the flow chain.

This **replaces** the existing quality-gate reopen mechanism (`reopenedByQualityGateCount` / `PI_TEAMS_HOOKS_MAX_REOPENS_PER_TASK`) for code/review task pairs. The existing reopen logic should be removed in favour of this structured approach.

### Environment Variable

A new environment variable, e.g. `PI_TEAMS_MAX_REVIEW_CYCLES`, controls the maximum number of allowed review cycles. When the limit is reached, the current code task is marked as `"failed"` instead of creating another iteration.

### Rollback on Failure

Once a task is marked `"failed"`, the existing changes should be rolled back:
- Rollback changes: `git restore .`
- Remove untracked files: `git clean -f`

**Note:** This rollback operates on the entire working tree. It is only safe when used with Feature 7 (worktree isolation). Without worktrees, rollback could destroy other agents' uncommitted work. This feature should therefore be implemented alongside or after Feature 7.

### Terminal Status Semantics

Failed tasks are terminal:
- They cannot be picked up by auto-claim.
- They are not re-assignable without explicit intervention.
- A failed task does **not** unblock its dependents (unlike `"completed"`), since the work was never successfully done. Downstream tasks remain blocked.
- It should be possible to list all failed tasks via a filter, e.g. `/team task list --failed`.

### Implementation Touch-points

- `task-store.ts`: Add `"failed"` to `TaskStatus`, update `isStatus()`, add `failTask()` function, update `claimNextAvailableTask`/`claimTask`/`unassignTask` to treat `"failed"` as terminal, update `isTaskBlocked` so a failed blocker keeps dependents blocked.
- `leader.ts`: Replace the existing reopen/followup logic with structured cycle detection and new task chain creation (see Feature 4).
- `worker.ts`: No task creation responsibility — workers report results, the leader acts on them.
- `formatTaskLine` / UI: Display `"failed"` status, add filtering support.
- `protocol.ts`: Already supports `completedStatus: "failed"` — no change needed.

### Dependencies

This feature depends on Feature 2.



## Feature 4: Worker Context Management

When a worker finishes a task its `onAgentEnd` handler immediately looks for more work (`maybeStartNextWork`). Every successive task prompt, tool call, and response is appended to the same conversation. The only safety net is pi's generic auto-compaction, which is lossy and uncontrolled. Over several tasks the worker's context fills with irrelevant history, increasing the chance of hallucination, degraded instruction-following, and eventual context-window overflow.

A new `--keepContext` flag should be introduced so that the default behaviour becomes kill-and-respawn after every completed task. This will give each task a fresh context window. Passing `--keepContext` preserves the current behaviour.



## Feature 5: Worktree Management

Every code → review → commit flow chain should work on its own branch via a git worktree. The worktree is scoped to the **flow chain**, not the individual agent — all tasks in a chain (code, review, commit, and any fix cycles) share the same worktree. This allows different agents to work on related tasks (e.g. one agent codes, another reviews) while operating on the same branch and code changes.

```shell
git worktree add <path>
```
The `<path>` is the location of the worktree directory, whose name is the final component.

### Worktree Directory

On team creation a new option, `--worktreeDir`, should be introduced to specify the path of the directory where worktrees should be created.
- Absolute paths should be used as-is.
- Relative paths should be relative to the team's working directory.
 
 If no values is supplied, then the default is to create a new relative directory called `./worktrees`. Regardless of the directory type, the value should be stored as absolute in the team config. This value is immutable once set.

### Branch and Path Convention

The branch name convention is `<team-name>-<task-id>`, where `<task-id>` is the root code task of the flow. This is appended to the worktree directory to form the full path. The path can be absolute,
```shell
git worktree add /home/user/project/worktrees/team-name-23
```
or relative,
```shell
git worktree add ./worktrees/team-name-23
```

### Worktree Lifecycle

1. **Creation:** When a code task is created as part of a flow chain (Feature 3), the leader creates the worktree and stores the path in the code task's `metadata.worktreePath`. The linked review and commit tasks inherit this path.
2. **Fix cycles:** When a review fails and new code + review tasks are created, they inherit the same `worktreePath` — fixes are committed to the same branch.
3. **Cleanup:** The worktree is automatically removed when the chain reaches a terminal state:
   - Commit task completes successfully, or
   - Root code task is marked as `"failed"` (Feature 2).
   
   The git **branch is preserved** after cleanup for later inspection or merging — only the working copy is removed.

### Concurrent Worktree Limits

The number of concurrent worktrees is bounded by the number of agents, not the number of tasks. With 4 agents and 100 feature tasks, at most ~4 worktrees exist at any time, processed as a rolling wave with cleanup occurring as chains complete.

### Discovery

Workers discover their working directory from `metadata.worktreePath` on the task they pick up. With `--keepContext` off (Feature 4, the default), the leader sets the correct `cwd` on the fresh worker process. With `--keepContext` on, the task prompt instructs the worker to change to the worktree directory.

### Observability

Two new commands support manual oversight:
- `/team worktree list` — shows active worktrees with their associated task and status.
- `/team worktree clean [--force]` — removes worktrees whose flow chains have reached a terminal state (or force-removes all).

### Deprecation

The existing per-agent `worktree` option on `/team spawn` is deprecated. Worktrees are now created per flow chain, not per agent.

### Dependencies

This feature depends on Feature 2.