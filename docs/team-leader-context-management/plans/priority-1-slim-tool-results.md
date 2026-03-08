# Implementation Plan: Priority 1 — Slim Tool Results (Strategy A)

**Effort:** Low | **Impact:** High | **Tokens saved:** 30–50% of accumulated tool result content

---

## Problem

Every `teams` tool call returns a `content` text block that goes to the LLM context. There are 53 return points in `leader-teams-tool.ts`, many of which produce verbose, multi-line content strings containing information the leader LLM does not need to retain long-term (e.g., full lists of spawned names, per-task assignment lines, UUID-based team IDs, mailbox namespace identifiers).

> **Correction from analysis:** The `details` field is **not** sent to the LLM. Providers (Anthropic, OpenAI) only extract `content` blocks. The `details` field is stored in the session file for debugging/persistence only. Therefore this strategy focuses on slimming `content`, not removing `details`.

---

## Scope

**File:** `extensions/teams/leader-teams-tool.ts` — all 53 `return { content, details }` sites.

---

## Tasks

### Task 1: Audit all content strings for verbosity

Go through each return point and classify:

| Category | Current pattern | Proposed |
|----------|----------------|----------|
| **Success confirmations** | `"Updated task #12: status=completed"` | Keep as-is (already terse) |
| **Delegation results** | Multi-line listing of every assignment | Summarize (see Task 2) |
| **Policy reads** | Multi-line model/hooks policy dump | Shorten to one-liner (see Task 3) |
| **Broadcast/shutdown** | Lists every recipient name | Summarize count + names only if ≤3 |
| **Error messages** | `"task_assign requires taskId and assignee"` | Keep as-is |

### Task 2: Compact the `delegate` action content

**Current** (~126 words for 8 tasks):
```
Spawned: Comrade alpha, Comrade bravo, Comrade charlie, Comrade delta
Delegated 8 task(s):
- #1 → Comrade alpha: Implement user authentication with JWT tokens...
- #2 → Comrade bravo: Set up database migrations...
[...6 more lines...]
```

**Proposed** (~30 words):
```
Delegated 8 tasks to 4 teammates. Spawned: alpha, bravo, charlie, delta. Task IDs: #1–#8. All assigned round-robin.
```

If there are warnings, append them on a single line.

**Implementation:**

In the `delegate` action handler (around line 1040–1075), replace the `lines` array construction:

```typescript
// Before
const lines: string[] = [];
if (spawned.length) {
    lines.push(`Spawned: ${spawned.map(n => formatMemberDisplayName(style, n)).join(", ")}`);
}
lines.push(`Delegated ${assignments.length} task(s):`);
for (const a of assignments) {
    lines.push(`- #${a.taskId} → ${formatMemberDisplayName(style, a.assignee)}: ${a.subject}`);
}

// After
const lines: string[] = [];
const taskIds = assignments.map(a => `#${a.taskId}`);
const assigneeCounts = new Map<string, number>();
for (const a of assignments) assigneeCounts.set(a.assignee, (assigneeCounts.get(a.assignee) ?? 0) + 1);
const assigneeSummary = Array.from(assigneeCounts.entries()).map(([n, c]) => `${n}×${c}`).join(", ");

lines.push(`Delegated ${assignments.length} task(s) to ${assigneeCounts.size} teammate(s) (${assigneeSummary}).`);
lines.push(`Task IDs: ${taskIds.join(", ")}.`);
if (spawned.length) lines.push(`Spawned: ${spawned.join(", ")}.`);
```

### Task 3: Compact policy read results

**`model_policy_get`** — replace 6-line output with:
```
Model policy: leader=anthropic/claude-sonnet-4-20250514, teammate default=inherit leader. Override: '<provider>/<modelId>'.
```

**`hooks_policy_get`** — replace 3-line output with:
```
Hooks: failureAction=warn, maxReopens=2, followupOwner=member (all env defaults).
```

**`hooks_policy_set`** — same format as get, prefixed with "Updated: ".

### Task 4: Compact broadcast/shutdown/prune recipient lists

When recipient count > 3, summarize:
```
// Before
"Broadcast queued for 8 comrade(s): alpha, bravo, charlie, delta, echo, foxtrot, golf, hotel"

// After  
"Broadcast queued for 8 teammate(s)."
```

When ≤ 3, keep names inline (they're useful context).

### Task 5: Extract a `compactContent` helper

Create a utility function to enforce a consistent pattern:

```typescript
function compactResult(text: string, details: unknown): AgentToolResult<unknown> {
    return {
        content: [{ type: "text", text }],
        details,
    };
}
```

This makes it easy to audit and ensures no accidental multi-block content arrays.

---

## Testing

1. Run a delegation of 8+ tasks and verify the content string is ≤ 2 lines.
2. Run `model_policy_get` and `hooks_policy_get` and verify single-line output.
3. Run `message_broadcast` with 5+ recipients and verify summarized output.
4. Verify `details` objects are unchanged (they're still useful for debugging/persistence).
5. Verify the leader LLM can still correctly reference task IDs and teammate names from the slimmer results.

---

## Estimated token savings

| Action | Before (words) | After (words) | Savings |
|--------|---------------|--------------|---------|
| delegate (8 tasks) | ~126 | ~30 | 76% |
| model_policy_get | ~32 | ~15 | 53% |
| hooks_policy_get | ~13 | ~10 | 23% |
| broadcast (8 recipients) | ~20 | ~8 | 60% |
| **Weighted average across session** | | | **~40%** |
