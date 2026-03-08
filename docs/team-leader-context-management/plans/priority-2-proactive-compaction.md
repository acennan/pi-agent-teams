# Implementation Plan: Priority 2 — Proactive Context Compaction (Strategy B)

**Effort:** Medium | **Impact:** High | **Tokens saved:** Prevents context exhaustion entirely

---

## Problem

The teams extension does not interact with pi's compaction system at all. There is:
- No monitoring of `ctx.getContextUsage()`
- No automatic `ctx.compact()` trigger
- No `session_before_compact` handler to inject team-aware summarization instructions
- No `session_compact` handler to restore team state after compaction

When the leader's context fills up from accumulated tool results and conversation history, pi's built-in compaction will eventually fire, but it won't know what team state is critical to preserve.

---

## Scope

**Primary file:** `extensions/teams/leader.ts` (new event handlers + monitoring logic)  
**New file:** `extensions/teams/leader-compaction.ts` (compaction prompt builder + state snapshot)

---

## Tasks

### Task 1: Add context usage monitoring to the refresh loop

In `runLeader()`, the existing `refreshTimer` (1-second interval) already calls `refreshTasks()` and `renderWidget()`. Add context monitoring:

```typescript
// In the refreshTimer callback (leader.ts, inside session_start handler)
refreshTimer = setInterval(async () => {
    if (isStopping) return;
    if (refreshInFlight) return;
    refreshInFlight = true;
    try {
        await heartbeatActiveAttachClaim(ctx);
        await refreshTasks();
        renderWidget();
        
        // NEW: Check context usage and trigger compaction if needed
        const usage = ctx.getContextUsage();
        if (usage?.percent !== null && usage.percent > 75 && !compactionInFlight) {
            compactionInFlight = true;
            ctx.compact({
                customInstructions: buildTeamCompactionInstructions(tasks, teammates, teamConfig, style),
                onComplete: () => { compactionInFlight = false; },
                onError: () => { compactionInFlight = false; },
            });
        }
    } finally {
        refreshInFlight = false;
    }
}, 1000);
```

New state variable in `runLeader()`:
```typescript
let compactionInFlight = false;
```

### Task 2: Create `leader-compaction.ts` with the compaction prompt builder

```typescript
// extensions/teams/leader-compaction.ts

export function buildTeamCompactionInstructions(
    tasks: TeamTask[],
    teammates: Map<string, TeammateRpc>,
    teamConfig: TeamConfig | null,
    style: TeamsStyle,
): string {
    const lines: string[] = [];
    lines.push("IMPORTANT: This is a team leader session. Preserve the following team state in the summary:");
    lines.push("");
    
    // Active teammates
    const online = teamConfig?.members.filter(m => m.status === "online") ?? [];
    if (online.length > 0) {
        lines.push(`Active teammates: ${online.map(m => m.name).join(", ")}`);
    }
    
    // Current task state (compact)
    const pending = tasks.filter(t => t.status === "pending");
    const inProgress = tasks.filter(t => t.status === "in_progress");
    const completed = tasks.filter(t => t.status === "completed");
    
    if (inProgress.length > 0) {
        lines.push(`In-progress tasks: ${inProgress.map(t => `#${t.id} ${t.subject} (${t.owner ?? "unassigned"})`).join("; ")}`);
    }
    if (pending.length > 0) {
        lines.push(`Pending tasks: ${pending.map(t => `#${t.id} ${t.subject}`).join("; ")}`);
    }
    if (completed.length > 0) {
        lines.push(`Completed: ${completed.length} task(s) (#${completed.map(t => t.id).join(", #")})`);
    }
    
    lines.push("");
    lines.push("Discard individual tool call/result details from past delegation cycles.");
    lines.push("Preserve: current team roster, all task IDs and their current status/owner, any pending decisions or approvals, and the user's original goal.");
    
    return lines.join("\n");
}
```

### Task 3: Register a `session_before_compact` handler

This lets us inject team state even when compaction is triggered by pi's built-in threshold (not our monitoring):

```typescript
// In runLeader()
pi.on("session_before_compact", (event, ctx) => {
    // Don't cancel — let compaction proceed, but enrich it
    const instructions = buildTeamCompactionInstructions(tasks, teammates, teamConfig, style);
    
    // If there are already custom instructions, append ours
    if (event.customInstructions) {
        return { customInstructions: `${event.customInstructions}\n\n${instructions}` };
    }
    return { customInstructions: instructions };
});
```

Wait — checking the `SessionBeforeCompactResult` type, it doesn't have `customInstructions`. Let me re-check:

The `SessionBeforeCompactResult` has `{ cancel?: boolean; compaction?: CompactionResult }`. We can't inject custom instructions via the result. However, the `SessionBeforeCompactEvent` has `customInstructions` as a mutable field. An alternative approach: use the `context` event or rely solely on proactive `ctx.compact()` calls with `customInstructions`.

**Revised approach:** Rely on the proactive monitoring in Task 1 to always call `ctx.compact()` with team-aware instructions *before* pi's built-in compaction triggers. Set the threshold at 70% so we fire before pi's default (typically ~85%).

### Task 4: Register a `session_compact` handler to log/notify

```typescript
pi.on("session_compact", (event, _ctx) => {
    // Log for debugging
    if (currentCtx) {
        currentCtx.ui.notify("Context compacted — team state preserved in summary", "info");
    }
});
```

### Task 5: Duplicate monitoring into the `session_switch` handler

The `session_switch` handler also sets up a `refreshTimer`. Apply the same context monitoring logic there (or extract the timer setup into a shared function).

---

## Design Decisions

1. **Threshold: 70%** — fire before pi's default compaction to ensure our custom instructions are used.
2. **Debounce:** Use the `compactionInFlight` boolean to prevent overlapping compaction requests.
3. **No cancel:** We never cancel pi-initiated compaction — we only proactively trigger our own.
4. **Idempotent state snapshot:** `buildTeamCompactionInstructions` reads from `tasks` and `teamConfig` which are already refreshed every second.

---

## Testing

1. Run a long session with 20+ tool calls. Verify compaction fires automatically at ~70%.
2. Verify post-compaction summary contains team roster and task state.
3. Verify the leader can still correctly reference active tasks after compaction.
4. Verify compaction doesn't fire repeatedly (debounce works).
5. Test session switch: verify monitoring restarts for the new session.

---

## Files Changed

| File | Change |
|------|--------|
| `extensions/teams/leader-compaction.ts` | **New** — `buildTeamCompactionInstructions()` |
| `extensions/teams/leader.ts` | Add `compactionInFlight` state, context monitoring in refresh loop, `session_compact` handler |
