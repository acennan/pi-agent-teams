---
name: plan-to-tasks
description: "Convert an implementation plan (.md) into a JSONL file of TeamTask objects for an agent team. Use when the user asks to generate tasks from a plan, convert a plan to tasks, create a task list from an implementation plan, populate a task store — even if they don't say 'TeamTask' explicitly."
---

# Plan to Tasks

Parse an implementation plan document and produce a set of JSON files containing a `TeamTask` object that an agent team can work from directly.

## When to use

Trigger this skill whenever the user wants to convert a structured implementation plan (typically a markdown document with numbered tasks, dependencies, and file references) into machine-readable team tasks. The input plan will usually follow the format produced by the `feature-planning` skill, but any markdown with identifiable tasks and dependencies is fair game.

## Inputs

The user will provide:

1. **Plan file path** — the `.md` implementation plan to parse.
2. **Output file path** (optional) — where to write the JSON files. Defaults to a directory with the name of the plan file (less the extension) + `-tasks` in the current working directory.

For example, if the user provides `@docs/plans/feature-1-team-identifier.md` as the plan file path, the output file path defaults to `feature-1-team-identifier-tasks`.

If the user hasn't provided the plan file, ask before proceeding.

## Output format

Write one file per JSON object. The file name will be `<id>.json`. Each JSON object is a `TeamTask` conforming to the interface in `extensions/teams/task-store.ts`:

```typescript
interface TeamTask {
  id: string;            // sequential stringified integer: "1", "2", ...
  subject: string;       // short one-line summary
  description: string;   // condensed implementation details (see below)
  owner?: string;        // leave undefined — the team will auto-claim
  status: "pending";     // always "pending" for new tasks
  blocks: string[];      // IDs of tasks this task blocks
  blockedBy: string[];   // IDs of tasks this task depends on
  metadata?: Record<string, unknown>;
  createdAt: string;     // ISO 8601 timestamp (generation time)
  updatedAt: string;     // same as createdAt
}
```

## Workflow

### 1. Read and understand the plan

Read the plan file. Identify:

- **Overview / context** — the high-level goal. Keep this in mind when writing descriptions so each task is self-contained enough that an agent picking it up understands *why*.
- **Architecture decisions** — note any decisions that constrain implementation. Reference these in task descriptions where relevant rather than repeating them in full.
- **Implementation tasks** — the numbered tasks with their files, details, dependencies, and references.
- **Testing strategy** — if the plan includes one, it will inform test-related tasks.

### 2. Break down into team tasks

Map each plan task to one or more `TeamTask` objects. The goal is tasks that are **straightforward for a single agent to pick up and complete without needing to context-switch**.

**When to split a plan task:**

- The task touches multiple unrelated files or modules (e.g., "update the command dispatcher AND implement the handler AND write tests" → split into separate tasks).
- The task has a mix of code changes and verification/testing steps.
- The details section contains multiple numbered steps that are independently meaningful.

**When NOT to split:**

- The steps are tightly coupled and only make sense together (e.g., "add the field to the type AND update the single function that uses it").
- Splitting would create tasks so small they'd be confusing to pick up in isolation.

Use your judgement. Prefer slightly more granular over slightly too coarse — agents work better with focused, well-scoped work items.

### 3. Generate review tasks

Every code-change task must have a corresponding review task. This creates a quality gate: work is not considered complete until it has been reviewed.

**Code-change tasks** are tasks that create or modify source files (application code, config, types, etc.).

**Non-code tasks** do not get review tasks. These include:
- Verification-only tasks (e.g., "confirm env var propagates")
- Documentation-only updates
- Test-writing tasks (tests are themselves a form of verification)

**For each code-change task, generate a review companion:**

- **Subject:** `"Review: <original subject>"`
- **Description:** What to review — which files changed, what acceptance criteria to check against, what patterns should have been followed, what edge cases to verify. Draw this from the plan's details and constraints for the corresponding code task.
- **`blockedBy`:** the code task's ID (can't review what hasn't been written).
- **Metadata cross-references:**
  - On the code task: `"reviewTaskId": "<review-task-id>"`
  - On the review task: `"codeTaskId": "<code-task-id>"`

Place the review task immediately after its code task in the task directory so related work is grouped together.

### 4. Write condensed descriptions

Each `TeamTask.description` should contain only what an agent needs to implement (or review) the task:

- **What to change** — specific file paths and line numbers from the plan.
- **How to change it** — the concrete steps, condensed from the plan's "Details" section.
- **Key constraints** — validation rules, naming conventions, error handling requirements.
- **Reference patterns** — file paths the agent should look at for existing patterns to follow.

Omit rationale, trade-off discussions, and architecture decision context unless they directly affect *how* the code should be written. The agent doesn't need to know *why* a regex was chosen over sanitization — it needs to know *which* regex to use.

For review tasks, the description should focus on what to check: expected behaviour, constraints that must hold, patterns that should have been followed, and specific edge cases from the plan.

### 5. Map dependencies

The plan's "Dependencies" field lists plan task numbers (e.g., "Dependencies: Task 1, Task 2"). Convert these to `TeamTask` ID references.

**The core rule: downstream code tasks are blocked by the *review* tasks of their dependencies, not the code tasks.** This ensures nothing downstream starts until upstream work is both written and reviewed.

Because a single plan task can become multiple team tasks, track the mapping carefully:

- Keep a mapping of `planTask → { codeTaskIds: [...], reviewTaskIds: [...] }`.
- When plan Task B depends on plan Task A, every code task derived from plan Task B should list the *review* task IDs from plan Task A in its `blockedBy`. This enforces the quality gate.
- Within a plan task that was split into multiple code tasks, chain them sequentially if they have an internal order — later code tasks in the group are `blockedBy` earlier ones in the same group.
- Populate `blocks` as the inverse of every `blockedBy` entry.

**Dependency summary:**

| Relationship | `blockedBy` points to |
|---|---|
| Code task → its own review | Review is `blockedBy` the code task |
| Code task → upstream plan dependency | Code task is `blockedBy` the upstream *review* tasks |
| Code tasks within same split group | Later code task is `blockedBy` earlier code task |

### 6. Set metadata

Each `TeamTask.metadata` should include:

```json
{
  "source": "docs/plans/feature-1-team-identifier.md",
  "planTask": "Task 2"
}
```

- `source` — the plan file path as provided by the user.
- `planTask` — the plan task this team task was derived from (e.g., `"Task 2"`). If a plan task was split, each resulting team task references the same plan task.

Additionally, for code/review pairs:
- Code task metadata includes `"reviewTaskId": "<id>"`.
- Review task metadata includes `"codeTaskId": "<id>"`.

### 7. Write the JSON files

- Assign IDs sequentially starting from `"1"`.
- Set `status` to `"pending"` for all tasks.
- Leave `owner` undefined.
- Set `createdAt` and `updatedAt` to the current ISO 8601 timestamp.
- Write one JSON object per file (no trailing comma).
- Confirm the output path and number of tasks generated to the user.

## Example

Given two plan tasks where Task 2 depends on Task 1:

```markdown
### Task 1: Add `/team create` subcommand with `--id` flag
- **File:** `extensions/teams/leader-team-command.ts:34` (existing)
- **Description:** Register a new `create` subcommand in the dispatcher.
- **Details:**
  1. Add help text entry.
  2. Add `create` handler that calls `handleTeamCreateCommand`.
  3. Pass through ctx, rest, and callbacks.
- **Dependencies:** None

### Task 2: Implement `handleTeamCreateCommand`
- **File:** `extensions/teams/leader-create-command.ts` (new)
- **Description:** Core logic for `/team create --id=<name>`
- **Details:**
  1. Parse `--id=<value>` or `--id <value>` from rest args.
  2. Validate format: `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`.
  3. Check uniqueness via directory existence + attach claim.
  4. Set identity, create config, acquire claim.
- **Dependencies:** Task 1
```

This produces:

```
ID  Subject                                              blockedBy  blocks   metadata
──  ───────                                              ─────────  ──────   ────────
1   Add /team create subcommand with --id flag           []         [2,3]    planTask:"Task 1", reviewTaskId:"2"
2   Review: Add /team create subcommand with --id flag   [1]        [3]      planTask:"Task 1", codeTaskId:"1"
3   Implement handleTeamCreateCommand                    [2]        [4]      planTask:"Task 2", reviewTaskId:"4"
4   Review: Implement handleTeamCreateCommand            [3]        []       planTask:"Task 2", codeTaskId:"3"
```

Note how task 3 (code for plan Task 2) is `blockedBy` task 2 (the *review* of plan Task 1), not task 1 (the code). This ensures plan Task 1 is fully reviewed before dependent work begins.

## Edge cases

- **Verification-only tasks** (e.g., "no code change expected, just verify manually") — create a team task but no review companion. Set the description to explain what to verify and how.
- **Test-writing tasks** — create a team task but no review companion. Tests are themselves verification.
- **Tasks with no dependencies** — `blockedBy` and `blocks` are empty arrays, not omitted.
- **Plan tasks that are pure documentation** — no review companion. Documentation tasks are non-code.
- **A plan task that splits into a mix of code and non-code** — only the code sub-tasks get review companions.
