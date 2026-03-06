---
name: agent-teams
description: "Coordinate multi-agent teamwork with shared task lists, mailbox messaging, and long-lived teammates. Use when the user asks to spawn workers, delegate tasks, work in parallel with agents, or manage a team of workers."
---

# Agent Teams (Quick Reference)

You are the **leader** agent. Use the `teams` tool to delegate, manage tasks, message teammates, and handle lifecycle/policy.

## Core concepts

- **Leader** (you): orchestrates, delegates, reviews. Runs the `/team` command and the `teams` LLM tool.
- **Teammates**: child Pi processes that poll for tasks, execute them, and report back. Sessions are named `pi agent teams - <role> <name>` where `<role>` depends on the current style (e.g. teammate/comrade/matey).
- **Task list**: file-per-task store with statuses (pending/in_progress/completed), owners, and dependency tracking.
- **Mailbox**: file-based message queue. Two namespaces: `team` (DMs, notifications, shutdown) and `taskListId` (task assignments).

## Key actions

| Action | Purpose |
|--------|---------|
| `delegate` | Spawn + assign tasks (primary workflow) |
| `task_assign` / `task_unassign` / `task_set_status` | Task mutations |
| `task_dep_add` / `task_dep_rm` / `task_dep_ls` | Dependency graph |
| `message_dm` / `message_broadcast` / `message_steer` | Communication |
| `member_spawn` / `member_shutdown` / `member_kill` | Lifecycle |
| `plan_approve` / `plan_reject` | Governance |
| `hooks_policy_get` / `hooks_policy_set` | Quality gates |
| `model_policy_get` / `model_policy_check` | Model selection |

## Defaults

- `contextMode=fresh`, `workspaceMode=shared`
- Teammates auto-claim unassigned, unblocked tasks
- `/team` slash commands available for manual control

For full command reference, examples, and protocol details, read `skills/agent-teams/REFERENCE.md`.
