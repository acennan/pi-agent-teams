# Agent Teams — Full Reference

> This file is not loaded into your system prompt. It is available for on-demand reading when you need detailed command syntax, examples, or protocol information.

## UI style (terminology + naming)

Built-in styles:
- `normal` (default): Team leader + Teammate <name>
- `soviet`: Chairman + Comrade <name>
- `pirate`: Captain + Matey <name>

Configure via `PI_TEAMS_STYLE=<name>` or `/team style <name>` (see `/team style list`).

Custom styles can be added via JSON files under `~/.pi/agent/teams/_styles/<style>.json` or bootstrapped with:

- `/team style init <name> [extends <base>]`

## Tool reference

The teams extension provides 5 focused LLM-callable tools:

### `teams_delegate` — Delegate tasks

| Field | Required | Notes |
| --- | --- | --- |
| `tasks` | yes | Array of `{ text, assignee? }`. Spawns teammates as needed, assigns round-robin. |
| `teammates` | no | Explicit teammate names to use/spawn. |
| `maxTeammates` | no | Max auto-spawned teammates (default 4). |
| `contextMode` | no | `fresh` (default) or `branch`. |
| `workspaceMode` | no | `shared` (default) or `worktree`. |
| `model` | no | `<provider>/<modelId>` override. |
| `thinking` | no | off/minimal/low/medium/high/xhigh. |

### `teams_task` — Task mutations

| Action | Required fields | Notes |
| --- | --- | --- |
| `assign` | `taskId`, `assignee` | Assign/reassign owner. |
| `unassign` | `taskId` | Clear owner. |
| `set_status` | `taskId`, `status` | `pending` \| `in_progress` \| `completed`. |
| `dep_add` / `dep_rm` | `taskId`, `depId` | Dependency graph edits. |
| `dep_ls` | `taskId` | Dependency/block inspection. |

### `teams_message` — Communication

| Action | Required fields | Notes |
| --- | --- | --- |
| `dm` | `name`, `message` | Mailbox DM. |
| `broadcast` | `message` | Mailbox broadcast. |
| `steer` | `name`, `message` | RPC steer for running teammate. |

### `teams_member` — Lifecycle

| Action | Required fields | Notes |
| --- | --- | --- |
| `spawn` | `name` | Supports context/workspace/model/thinking/plan options. |
| `shutdown` | `name` or `all=true` | Graceful mailbox shutdown request. |
| `kill` | `name` | Force-stop RPC teammate. |
| `prune` | _(none)_ | Mark stale workers offline (`all=true` to force). |

### `teams_policy` — Governance & policy

| Action | Required fields | Notes |
| --- | --- | --- |
| `plan_approve` / `plan_reject` | `name` | Resolve pending plan approvals (`feedback` optional for reject). |
| `hooks_get` | _(none)_ | Read team hooks policy (configured + effective). |
| `hooks_set` | one or more: `hookFailureAction`, `hookMaxReopensPerTask`, `hookFollowupOwner` | Update hooks policy (`hooksPolicyReset=true` clears overrides first). |
| `model_get` | _(none)_ | Inspect teammate model policy. |
| `model_check` | optional `model` | Validate a model override before spawn. |

### Tool examples

```
teams_delegate({ tasks: [{ text: "Implement auth", assignee: "alice" }] })
teams_task({ action: "assign", taskId: "12", assignee: "alice" })
teams_task({ action: "dep_add", taskId: "12", depId: "7" })
teams_message({ action: "broadcast", message: "Sync: finishing this milestone" })
teams_member({ action: "kill", name: "alice" })
teams_policy({ action: "plan_reject", name: "alice", feedback: "Include rollback strategy" })
teams_policy({ action: "hooks_get" })
teams_policy({ action: "hooks_set", hookFailureAction: "reopen_followup", hookMaxReopensPerTask: 2, hookFollowupOwner: "member" })
teams_policy({ action: "model_get" })
teams_policy({ action: "model_check", model: "openai-codex/gpt-5.1-codex-mini" })
```

This covers most day-to-day orchestration without slash commands. For nuanced/manual control, use `/team ...` commands directly.

### `/team spawn` examples

For more control, use `/team spawn`:

```
/team spawn alice              # default: fresh context, shared workspace
/team spawn bob branch shared  # clone leader session context
/team spawn carol fresh worktree  # git worktree isolation
/team spawn dave plan          # plan-required mode (read-only until approved)
```

## Task management

```
/team task add <text...>                # create a task
/team task add alice: review the API    # create + assign (prefix with name:)
/team task assign <id> <agent>          # assign existing task
/team task unassign <id>                # unassign
/team task list                         # show all tasks with status + deps
/team task show <id>                    # full task details + result
/team task dep add <id> <depId>         # task depends on depId
/team task dep rm <id> <depId>          # remove dependency
/team task dep ls <id>                  # show dependency graph
/team task clear [completed|all]        # delete tasks
/team task use <taskListId>             # switch to a different task list
```

Teammates auto-claim unassigned, unblocked tasks by default.

## Communication

```
/team dm <name> <msg...>       # direct message to one teammate
/team broadcast <msg...>       # message all teammates
/team send <name> <msg...>     # RPC-based (immediate, for spawned teammates)
```

Teammates can also message each other directly via the `team_message` tool, with the leader CC'd.

## Governance modes

### Delegate mode

Restricts the leader to coordination-only (blocks bash/edit/write tools). Use when you want to force all implementation through teammates.

```
/team delegate on    # enable
/team delegate off   # disable
```

### Plan approval

Spawning with `plan` restricts the teammate to read-only tools. After producing a plan, the teammate submits it for leader approval before proceeding.

```
/team spawn alice plan         # spawn in plan-required mode
/team plan approve alice       # approve plan, teammate gets full tools
/team plan reject alice <feedback...>  # reject, teammate revises
```

## Lifecycle

```
/team panel                    # interactive overlay with teammate details
/team list                     # show teammates and their state
/team attach list              # discover existing teams under <teamsRoot>
/team attach <teamId> [--claim] # attach this session to an existing team workspace (force takeover with --claim)
/team detach                   # return to this session's own team workspace
/team shutdown                 # stop all teammates (RPC + best-effort manual) (leader session remains active)
/team shutdown <name>          # graceful shutdown (teammate can reject if busy)
/team prune [--all]            # hide stale manual teammates (mark offline in config)
/team kill <name>              # force-terminate one RPC teammate
/team cleanup [--force]        # delete team directory after all teammates stopped
```

Teammates reject shutdown requests when they have an active task. Use `/team kill <name>` to force.

## Other commands

```
/team id       # show team ID, task list ID, paths
/team env <n>  # print env vars for manually spawning a teammate named <n>
```

## Shared task list across sessions

`PI_TEAMS_TASK_LIST_ID` is primarily **worker-side** (use it when you start a teammate manually).

The leader switches task lists via:

```
/team task use my-persistent-list
```

The chosen task list ID is persisted in `config.json`. Teammates spawned after the switch inherit the new task list ID; existing teammates need a restart to pick up changes.

## Message protocol

Teammates and the leader communicate via JSON messages with a `type` field:

| Type | Direction | Purpose |
|---|---|---|
| `task_assignment` | leader -> teammate | Notify of assigned task |
| `idle_notification` | teammate -> leader | Teammate finished, no more work |
| `shutdown_request` | leader -> teammate | Ask to shut down |
| `shutdown_approved` | teammate -> leader | Will shut down |
| `shutdown_rejected` | teammate -> leader | Busy, can't shut down now |
| `plan_approval_request` | teammate -> leader | Plan ready for review |
| `plan_approved` | leader -> teammate | Proceed with implementation |
| `plan_rejected` | leader -> teammate | Revise plan (includes feedback) |
| `peer_dm_sent` | teammate -> leader | CC notification of peer message |
