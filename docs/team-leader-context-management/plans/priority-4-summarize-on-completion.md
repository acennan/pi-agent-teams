# Implementation Plan: Priority 4 — Summarize-on-Completion Pattern (Strategy D)

**Effort:** Medium | **Impact:** High | **Tokens saved:** 80%+ of completed-cycle history

---

## Problem

As delegation cycles accumulate, the leader's context retains every individual tool call and result from every past cycle — delegations, status updates, reassignments, broadcast messages — even after all the tasks they reference are completed. A typical cycle produces 15–25 tool results. After 5+ cycles, thousands of tokens of stale operational detail sit in context, consuming capacity but providing no value to the leader's current decision-making.

---

## Approach

Use pi's **`context` event** (fired before each LLM call, allows message replacement) to dynamically replace stale `teams` tool-result messages with a single compact state snapshot. This happens at LLM-call time without modifying the persisted session, so the full history remains available for debugging, resumption, and export.

---

## Scope

**New file:** `extensions/teams/leader-context-filter.ts`  
**Modified file:** `extensions/teams/leader.ts` (register `context` event handler)

---

## Tasks

### Task 1: Define "stale" vs "current" tool results

A `teams` tool result is **stale** when:
- It is a `toolResult` message where `toolName === "teams"`
- **AND** the corresponding assistant tool call's `action` parameter is one of: `delegate`, `task_assign`, `task_unassign`, `task_set_status`, `task_dep_add`, `task_dep_rm`, `message_dm`, `message_broadcast`, `message_steer`, `member_spawn`, `member_shutdown`, `member_kill`, `member_prune`
- **AND** there are newer `teams` tool results after it (i.e., it's not the most recent batch)

A tool result is **current** when it is part of the most recent assistant turn or the most recent N tool calls.

Policy reads (`model_policy_get`, `hooks_policy_get`, `plan_approve`, `plan_reject`) are always kept because they represent decisions, not transient operations.

### Task 2: Build the state snapshot

```typescript
// extensions/teams/leader-context-filter.ts

export function buildTeamStateSnapshot(
    tasks: TeamTask[],
    teammates: Map<string, TeammateRpc>,
    teamConfig: TeamConfig | null,
    style: TeamsStyle,
    pendingApprovals: Map<string, { requestId: string; name: string; taskId?: string }>,
): string {
    const lines: string[] = [];
    lines.push("[Team State Snapshot]");
    
    // Roster
    const online = teamConfig?.members.filter(m => m.status === "online") ?? [];
    const rpcNames = Array.from(teammates.keys());
    const allActive = new Set([...online.map(m => m.name), ...rpcNames]);
    if (allActive.size > 0) {
        lines.push(`Teammates online: ${Array.from(allActive).sort().join(", ")}`);
    } else {
        lines.push("No teammates online.");
    }
    
    // Tasks by status
    const pending = tasks.filter(t => t.status === "pending");
    const inProgress = tasks.filter(t => t.status === "in_progress");
    const completed = tasks.filter(t => t.status === "completed");
    
    if (inProgress.length > 0) {
        lines.push(`In-progress (${inProgress.length}): ${inProgress.map(t => `#${t.id}→${t.owner ?? "?"}`).join(", ")}`);
    }
    if (pending.length > 0) {
        lines.push(`Pending (${pending.length}): ${pending.map(t => `#${t.id}`).join(", ")}`);
    }
    if (completed.length > 0) {
        lines.push(`Completed (${completed.length}): ${completed.map(t => `#${t.id}`).join(", ")}`);
    }
    
    // Pending approvals
    if (pendingApprovals.size > 0) {
        const names = Array.from(pendingApprovals.values()).map(a => a.name);
        lines.push(`Pending plan approvals: ${names.join(", ")}`);
    }
    
    return lines.join("\n");
}
```

### Task 3: Implement the `context` event handler

The `context` event fires before each LLM call with the full message array. We can return a modified `messages` array.

```typescript
// extensions/teams/leader-context-filter.ts

import type { AgentMessage } from "@mariozechner/pi-agent-core";

const STALE_ACTIONS = new Set([
    "delegate", "task_assign", "task_unassign", "task_set_status",
    "task_dep_add", "task_dep_rm", "message_dm", "message_broadcast",
    "message_steer", "member_spawn", "member_shutdown", "member_kill", "member_prune",
]);

const KEEP_RECENT_TOOL_RESULTS = 6; // Always keep the last N teams tool results

export function filterStaleTeamsResults(
    messages: AgentMessage[],
    stateSnapshot: string,
): AgentMessage[] {
    // Find all teams tool result indices
    const teamsResultIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.role === "toolResult" && msg.toolName === "teams") {
            teamsResultIndices.push(i);
        }
    }
    
    if (teamsResultIndices.length <= KEEP_RECENT_TOOL_RESULTS) {
        return messages; // Nothing to trim
    }
    
    // Indices to replace (all but the last N)
    const staleIndices = new Set(
        teamsResultIndices.slice(0, -KEEP_RECENT_TOOL_RESULTS)
    );
    
    // Also find the corresponding assistant tool_call messages and check their action
    // We need to match toolCallIds between assistant messages and tool results
    const staleToolCallIds = new Set<string>();
    for (const idx of staleIndices) {
        const msg = messages[idx] as any;
        staleToolCallIds.add(msg.toolCallId);
    }
    
    // Filter: replace stale tool results with a single snapshot (injected once)
    let snapshotInjected = false;
    const filtered: AgentMessage[] = [];
    
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        
        if (staleIndices.has(i)) {
            // Replace the first stale result with the snapshot
            if (!snapshotInjected) {
                filtered.push({
                    ...msg,
                    content: [{ type: "text", text: stateSnapshot }],
                } as any);
                snapshotInjected = true;
            }
            // Skip remaining stale results (they're collapsed into the snapshot)
            continue;
        }
        
        filtered.push(msg);
    }
    
    return filtered;
}
```

### Task 4: Register the handler in `runLeader()`

```typescript
// In runLeader(), after registerTeamsTool(...)

pi.on("context", (event, _ctx) => {
    if (!currentTeamId) return;
    
    const snapshot = buildTeamStateSnapshot(
        tasks,
        teammates,
        teamConfig,
        style,
        pendingPlanApprovals,
    );
    
    const filtered = filterStaleTeamsResults(event.messages, snapshot);
    if (filtered !== event.messages) {
        return { messages: filtered };
    }
});
```

### Task 5: Handle edge cases

1. **Tool call / tool result pairing:** When we remove a stale tool result, the corresponding assistant `toolCall` block still exists. The LLM provider expects tool results to follow tool calls. The snapshot must keep the same `toolCallId` so the pairing is maintained. Our approach (replacing content but keeping the message shell) handles this.

2. **Non-teams tool results:** Never touch `bash`, `read`, `edit`, `write`, etc. results — only filter `teams` tool results.

3. **Empty sessions:** If there are no stale results, return early without modifying messages.

---

## Design Decisions

1. **`context` event, not session mutation:** We modify messages at LLM-call time only. The persisted session retains full history for debugging and `/resume`.
2. **Keep last 6:** The most recent tool results are always kept verbatim so the leader has immediate context for its current turn.
3. **Single snapshot replacement:** All stale results are collapsed into one snapshot message, keeping the message count low.
4. **Snapshot is live:** Built from current `tasks`/`teammates`/`teamConfig` state, so it always reflects the latest reality — even if the underlying data changed since the original tool call.

---

## Testing

1. Make 20+ teams tool calls. Verify that before the 7th+ call, earlier results are replaced with a snapshot.
2. Verify the leader can still reference current task IDs and teammate names correctly.
3. Verify non-teams tool results (bash, read, etc.) are never modified.
4. Verify the persisted session file still contains all original tool results.
5. Resume a compacted session and verify full history is available.

---

## Estimated Savings

| Session state | Tool results in context | After filtering |
|--------------|------------------------|-----------------|
| 10 teams calls | 10 | 7 (6 recent + 1 snapshot) |
| 30 teams calls | 30 | 7 |
| 50 teams calls | 50 | 7 |

The snapshot itself is ~100 words. Each replaced tool result was ~30–130 words. Net savings for a 30-call session: **~2,000–4,000 tokens**.

---

## Files Changed

| File | Change |
|------|--------|
| `extensions/teams/leader-context-filter.ts` | **New** — `buildTeamStateSnapshot()`, `filterStaleTeamsResults()` |
| `extensions/teams/leader.ts` | Register `context` event handler |
