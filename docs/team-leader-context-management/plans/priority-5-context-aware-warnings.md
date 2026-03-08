# Implementation Plan: Priority 5 — Context-Aware Idle Detection (Strategy G)

**Effort:** Low | **Impact:** Medium | **Tokens saved:** Behavioral — reduces unnecessary tool calls at high context usage

---

## Problem

The leader LLM has no visibility into its own context usage. It will keep delegating, querying policies, and broadcasting messages even when context is 90% full. By the time pi's built-in compaction fires, the leader may have already lost important context or hit a hard limit.

Giving the leader explicit context-pressure signals lets it self-regulate: prioritize completing current tasks over spawning new ones, defer policy queries, and avoid redundant broadcasts.

---

## Scope

**Modified file:** `extensions/teams/leader-teams-tool.ts` — append context usage warnings to tool results  
**Modified file:** `extensions/teams/leader.ts` — pass `getContextUsage` to the tool registration

---

## Tasks

### Task 1: Thread `getContextUsage` into the tool

Add to the `registerTeamsTool` options:

```typescript
export function registerTeamsTool(opts: {
    pi: ExtensionAPI;
    teammates: Map<string, TeammateRpc>;
    // ... existing fields ...
    getContextUsage: () => { percent: number | null } | undefined; // NEW
}): void {
```

In `runLeader()`, pass it:

```typescript
registerTeamsTool({
    // ... existing fields ...
    getContextUsage: () => currentCtx?.getContextUsage(),
});
```

### Task 2: Append context warnings to tool results

At the **end** of the `execute` function, just before returning, check context usage and append a warning if needed:

```typescript
// Helper at module level
function appendContextWarning(
    result: AgentToolResult<unknown>,
    usage: { percent: number | null } | undefined,
): AgentToolResult<unknown> {
    if (!usage?.percent || usage.percent < 50) return result;
    
    let warning: string;
    if (usage.percent > 80) {
        warning = `⚠️ Context ${usage.percent.toFixed(0)}% full. Finish active tasks before delegating more. Avoid policy queries.`;
    } else if (usage.percent > 65) {
        warning = `Context at ${usage.percent.toFixed(0)}%. Consider wrapping up current delegation cycle.`;
    } else {
        return result; // 50–65%: no warning needed yet
    }
    
    return {
        ...result,
        content: [
            ...result.content,
            { type: "text", text: warning },
        ],
    };
}
```

Apply it in the execute function. Rather than wrapping every return site (there are 53), apply it once at the function's final return path. Refactor the execute function to use a single return point:

```typescript
async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    const result = await executeTeamsAction(params, signal, ctx); // extracted inner function
    return appendContextWarning(result, getContextUsage());
}
```

### Task 3: Extract `executeTeamsAction` inner function

This is a mechanical refactor: move the body of `execute` into a separate `async function executeTeamsAction(...)` declared inside `registerTeamsTool`, and have `execute` call it then apply the warning.

This avoids modifying all 53 return sites.

### Task 4: Escalation — trigger compaction at critical levels

In the warning helper, if usage exceeds 85%, also trigger proactive compaction (if Strategy B is implemented):

```typescript
if (usage.percent > 85 && triggerCompaction) {
    triggerCompaction(); // callback passed from runLeader
}
```

This provides a second safety net: even if the refresh-loop compaction (Strategy B) misses a spike, the tool itself will trigger it.

---

## Warning Thresholds

| Context % | Action | Warning text |
|-----------|--------|-------------|
| < 50% | None | — |
| 50–65% | None | — |
| 65–80% | Soft warning | `"Context at X%. Consider wrapping up current delegation cycle."` |
| 80–85% | Hard warning | `"⚠️ Context X% full. Finish active tasks before delegating more. Avoid policy queries."` |
| > 85% | Hard warning + trigger compaction | Same as above + `ctx.compact()` |

---

## Design Decisions

1. **Warning in content, not a separate message:** The warning must be in the tool result's `content` array so the LLM sees it in context. A `ui.notify` would be invisible to the LLM.
2. **Single return point refactor:** Avoids touching 53 return sites. The inner function returns the result, the outer wrapper appends the warning.
3. **No warning on policy reads:** The warning itself says "avoid policy queries" at high levels, so the LLM learns not to call them.
4. **Token cost of warnings:** Each warning is ~15 words (~20 tokens). At high context, this cost is negligible compared to the savings from the LLM self-regulating.

---

## Testing

1. Mock `getContextUsage` returning 40% → verify no warning appended.
2. Mock returning 70% → verify soft warning appended.
3. Mock returning 85% → verify hard warning appended and compaction triggered.
4. Verify the warning appears as a second `content` block (not replacing the result).
5. Run a real session to ~70% context and verify the leader adjusts behavior (fewer new delegations).

---

## Files Changed

| File | Change |
|------|--------|
| `extensions/teams/leader-teams-tool.ts` | Add `getContextUsage` param, `appendContextWarning` helper, refactor to single return point |
| `extensions/teams/leader.ts` | Pass `getContextUsage` callback to `registerTeamsTool` |
