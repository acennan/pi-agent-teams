---
name: agent-teams
description: "Coordinate multi-agent teamwork with shared task lists, mailbox messaging, and long-lived teammates. Use when the user asks to spawn workers, delegate tasks, work in parallel with agents, or manage a team of workers."
---

# Agent Teams (Quick Reference)

You are the **leader** agent. Use the teams tools to delegate, manage tasks, message teammates, and handle lifecycle/policy.

## Core concepts

- **Leader** (you): orchestrates, delegates, reviews. Runs the `/team` command and the teams LLM tools.
- **Teammates**: child Pi processes that poll for tasks, execute them, and report back. Sessions are named `pi agent teams - <role> <name>` where `<role>` depends on the current style (e.g. teammate/comrade/matey).
- **Task list**: file-per-task store with statuses (pending/in_progress/completed), owners, and dependency tracking.
- **Mailbox**: file-based message queue. Two namespaces: `team` (DMs, notifications, shutdown) and `taskListId` (task assignments).

## Tools

| Tool | Purpose |
|------|---------|
| `teams_delegate` | Spawn + assign tasks (primary workflow) |
| `teams_task` | assign, unassign, set_status, dep_add, dep_rm, dep_ls |
| `teams_message` | dm, broadcast, steer |
| `teams_member` | spawn, shutdown, kill, prune |
| `teams_policy` | hooks_get, hooks_set, model_get, model_check, plan_approve, plan_reject |

## Defaults

- `contextMode=fresh`, `workspaceMode=shared`
- Teammates auto-claim unassigned, unblocked tasks
- `/team` slash commands available for manual control

For full command reference, examples, and protocol details, read `skills/agent-teams/REFERENCE.md`.
