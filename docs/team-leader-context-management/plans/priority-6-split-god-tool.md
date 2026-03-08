# Implementation Plan: Priority 6 — Split the God Tool (Strategy C)

**Status:** Implemented (2026-03-07)
**Effort:** Medium | **Impact:** Medium | **Tokens saved:** ~180 tokens per LLM request (static schema overhead)

---

## Problem

The `teams` tool is a single monolithic tool with 20 actions, a union-typed `action` parameter with 20 enum values, and 18 additional parameters — most of which are only relevant to a subset of actions. The full JSON schema for this tool (~370 tokens) is included in **every** LLM API request, regardless of which actions the leader actually needs.

Most leader turns only need 1–2 actions (e.g., `delegate` + `task_set_status`). The schema for `hooks_policy_set`, `model_policy_check`, `plan_reject`, etc. is dead weight in those turns.

---

## Scope

**Primary file:** `extensions/teams/leader-teams-tool.ts` → split into multiple files  
**Modified file:** `extensions/teams/leader.ts` → register multiple tools, add dynamic activation

---

## Design: Tool Decomposition

Split the single `teams` tool into 5 focused tools:

| Tool name | Actions | Parameters | Est. schema tokens |
|-----------|---------|------------|-------------------|
| `teams_delegate` | `delegate` | `tasks`, `teammates`, `maxTeammates`, `contextMode`, `workspaceMode`, `model`, `thinking` | ~90 |
| `teams_task` | `task_assign`, `task_unassign`, `task_set_status`, `task_dep_add`, `task_dep_rm`, `task_dep_ls` | `action`, `taskId`, `depId`, `assignee`, `status` | ~80 |
| `teams_message` | `message_dm`, `message_broadcast`, `message_steer` | `action`, `name`, `message` | ~50 |
| `teams_member` | `member_spawn`, `member_shutdown`, `member_kill`, `member_prune` | `action`, `name`, `all`, `reason`, `contextMode`, `workspaceMode`, `model`, `thinking`, `planRequired` | ~90 |
| `teams_policy` | `hooks_policy_get`, `hooks_policy_set`, `model_policy_get`, `model_policy_check`, `plan_approve`, `plan_reject` | `action`, `name`, `feedback`, `model`, `hookFailureAction`, `hookMaxReopensPerTask`, `hookFollowupOwner`, `hooksPolicyReset` | ~90 |

**Total if all active: ~400 tokens** (comparable to current).  
**Typical active set: ~220 tokens** (`teams_delegate` + `teams_task` + `teams_message`).

---

## Tasks

### Task 1: Create new tool registration files

Split `leader-teams-tool.ts` into:

- `leader-tool-delegate.ts` — `registerTeamsDelegateTool()`
- `leader-tool-task.ts` — `registerTeamsTaskTool()`
- `leader-tool-message.ts` — `registerTeamsMessageTool()`
- `leader-tool-member.ts` — `registerTeamsMemberTool()`
- `leader-tool-policy.ts` — `registerTeamsPolicyTool()`

Each file:
1. Defines its own Typebox parameter schema (only the parameters relevant to its actions).
2. Exports a `register*Tool(opts)` function with the same `opts` pattern as `registerTeamsTool`.
3. Contains the action handler logic extracted from the current monolith.

### Task 2: Trim parameter schemas per tool

**`teams_delegate`** — no `action` enum at all (it's always delegate). Parameters:
```typescript
const DelegateParamsSchema = Type.Object({
    tasks: Type.Array(TeamsDelegateTaskSchema),
    teammates: Type.Optional(Type.Array(Type.String())),
    maxTeammates: Type.Optional(Type.Integer({ default: 4, minimum: 1, maximum: 16 })),
    contextMode: Type.Optional(TeamsContextModeSchema),
    workspaceMode: Type.Optional(TeamsWorkspaceModeSchema),
    model: Type.Optional(Type.String()),
    thinking: Type.Optional(TeamsThinkingLevelSchema),
});
```

**`teams_task`** — action enum is only 6 values:
```typescript
const TaskActionSchema = StringEnum([
    "assign", "unassign", "set_status", "dep_add", "dep_rm", "dep_ls"
] as const);
```

This removes 14 irrelevant enum values from the schema.

### Task 3: Dynamic tool activation

Use `pi.setActiveTools()` to only activate the tools needed for the current session phase:

```typescript
// In runLeader(), after registration
const allTeamsTools = ["teams_delegate", "teams_task", "teams_message", "teams_member", "teams_policy"];
const coreTeamsTools = ["teams_delegate", "teams_task", "teams_message"];

// Default: core tools only
function updateActiveTeamsTools(phase: "core" | "all") {
    const current = new Set(pi.getActiveTools());
    // Remove all teams tools first
    for (const t of allTeamsTools) current.delete(t);
    // Add the appropriate set
    const toAdd = phase === "all" ? allTeamsTools : coreTeamsTools;
    for (const t of toAdd) current.add(t);
    pi.setActiveTools(Array.from(current));
}

// Activate "all" when there are pending approvals or when explicitly requested
// Activate "core" by default
```

### Task 4: Update `runLeader()` to register all 5 tools

Replace the single `registerTeamsTool(...)` call with 5 registration calls. Each receives the shared opts (teammates map, spawnTeammate, etc.) — only the fields it needs.

### Task 5: Backward compatibility

The old `teams` tool name is used in existing sessions. If a session is resumed that contains `teams` tool calls, the LLM might try to call it. Options:

1. **Keep a thin `teams` shim** that parses the `action` field and delegates to the appropriate new tool's handler. Register it with a deprecation note in the description.
2. **Accept the break** for resumed sessions (the LLM will quickly learn the new tool names from the schema).

Recommended: Option 1 for a transition period.

### Task 6: Update tool descriptions

Each tool gets a focused, shorter description:

```typescript
// teams_delegate
description: "Delegate tasks to teammate agents. Spawns teammates as needed and assigns tasks round-robin."

// teams_task  
description: "Manage team task list: assign, unassign, set status, add/remove/list dependencies."

// teams_message
description: "Send messages to teammates: DM, broadcast, or steer (RPC redirect)."

// teams_member
description: "Teammate lifecycle: spawn, shutdown, kill, prune stale members."

// teams_policy
description: "Read/set hooks policy, model policy, and approve/reject teammate plans."
```

---

## Testing

1. Verify each tool works independently (delegate, task ops, messaging, lifecycle, policy).
2. Verify dynamic activation: only `teams_delegate` + `teams_task` + `teams_message` active by default.
3. Verify the shim `teams` tool routes to correct handlers for backward compatibility.
4. Count tool schema tokens in API request logs to confirm reduction.
5. Test session resume with old `teams` tool calls in history.

---

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Leader LLM confusion with 5 tools vs 1 | Clear, focused descriptions + the LLM adapts quickly to named tools |
| Backward compatibility on resume | Thin shim tool for transition period |
| Increased code surface | Each tool file is smaller and more focused than the monolith |
| Dynamic activation complexity | Start with all tools active; optimize activation later |

---

## Files Changed

| File | Change |
|------|--------|
| `extensions/teams/leader-tool-delegate.ts` | **New** — delegate tool |
| `extensions/teams/leader-tool-task.ts` | **New** — task management tool |
| `extensions/teams/leader-tool-message.ts` | **New** — messaging tool |
| `extensions/teams/leader-tool-member.ts` | **New** — lifecycle tool |
| `extensions/teams/leader-tool-policy.ts` | **New** — policy + plan approval tool |
| `extensions/teams/leader-teams-tool.ts` | Gutted to thin backward-compat shim |
| `extensions/teams/leader.ts` | Register 5 tools + shim, add `updateActiveTeamsTools()` |
