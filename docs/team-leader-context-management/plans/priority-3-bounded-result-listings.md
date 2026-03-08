# Implementation Plan: Priority 3 — Bounded Task Listing in Results (Strategy F)

**Effort:** Low | **Impact:** Medium | **Tokens saved:** ~40% per delegation result

---

## Problem

Several `teams` tool actions produce unbounded list output in their `content` text:

1. **`delegate`** — lists every individual `#taskId → assignee: subject` line (grows linearly with task count).
2. **`message_broadcast`** — lists every recipient name.
3. **`member_prune`** — lists every pruned member name.
4. **`member_shutdown`** — lists every shutdown target name.
5. **`task_dep_ls`** — lists every blockedBy/blocks dependency with full subjects.

For a delegation of 16 tasks to 4 teammates, the content alone is 18+ lines (~200 words). This is context the leader LLM rarely needs to re-read verbatim — it just needs to know the delegation succeeded and the IDs exist.

---

## Scope

**File:** `extensions/teams/leader-teams-tool.ts` — the `delegate`, `message_broadcast`, `member_prune`, `member_shutdown`, and `task_dep_ls` action handlers.

---

## Design: Threshold-based truncation

Use a consistent threshold: **if a list has > 4 items, summarize it**. For ≤ 4 items, keep the full list (it's small enough to be useful context).

---

## Tasks

### Task 1: Create a `summarizeList` helper

```typescript
// At top of leader-teams-tool.ts or in a shared utils file

const LIST_THRESHOLD = 4;

function summarizeNameList(
    names: string[],
    style: TeamsStyle,
    noun: string,
): string {
    if (names.length <= LIST_THRESHOLD) {
        return names.map(n => formatMemberDisplayName(style, n)).join(", ");
    }
    const shown = names.slice(0, 3).map(n => formatMemberDisplayName(style, n)).join(", ");
    return `${shown}, +${names.length - 3} more ${noun}(s)`;
}

function summarizeTaskAssignments(
    assignments: Array<{ taskId: string; assignee: string; subject: string }>,
    style: TeamsStyle,
): string[] {
    const lines: string[] = [];
    if (assignments.length <= LIST_THRESHOLD) {
        for (const a of assignments) {
            lines.push(`#${a.taskId} → ${formatMemberDisplayName(style, a.assignee)}: ${a.subject}`);
        }
    } else {
        // Group by assignee
        const byAssignee = new Map<string, string[]>();
        for (const a of assignments) {
            const ids = byAssignee.get(a.assignee) ?? [];
            ids.push(`#${a.taskId}`);
            byAssignee.set(a.assignee, ids);
        }
        for (const [assignee, ids] of byAssignee) {
            lines.push(`${formatMemberDisplayName(style, assignee)}: ${ids.join(", ")}`);
        }
    }
    return lines;
}
```

### Task 2: Apply to `delegate` action (line ~1040)

**Before:**
```typescript
lines.push(`Delegated ${assignments.length} task(s):`);
for (const a of assignments) {
    lines.push(`- #${a.taskId} → ${formatMemberDisplayName(style, a.assignee)}: ${a.subject}`);
}
```

**After:**
```typescript
lines.push(`Delegated ${assignments.length} task(s):`);
lines.push(...summarizeTaskAssignments(assignments, style));
```

### Task 3: Apply to `message_broadcast` action (line ~431)

**Before:**
```typescript
`Broadcast queued for ${names.length} ${noun}(s): ${names.map(n => formatMemberDisplayName(style, n)).join(", ")}`
```

**After:**
```typescript
`Broadcast queued for ${names.length} ${noun}(s): ${summarizeNameList(names, style, noun)}`
```

### Task 4: Apply to `member_shutdown` action (line ~591)

**Before:**
```typescript
`Shutdown requested for ${names.length} ${noun}(s): ${names.map(n => formatMemberDisplayName(style, n)).join(", ")}`
```

**After:**
```typescript
`Shutdown requested for ${names.length} ${noun}(s): ${summarizeNameList(names, style, noun)}`
```

### Task 5: Apply to `member_prune` action (line ~637)

Same pattern as shutdown — use `summarizeNameList`.

### Task 6: Bound `task_dep_ls` output (line ~338)

The dependency listing enumerates every `blockedBy` and `blocks` entry with full subjects. For tasks with many dependencies, this is unbounded.

**After:**
```typescript
// For blockedBy/blocks sections, limit to 6 entries
const MAX_DEPS = 6;
const depsToShow = task.blockedBy.slice(0, MAX_DEPS);
for (const id of depsToShow) {
    const dep = byId.get(id) ?? (await getTask(teamDir, effectiveTlId, id));
    lines.push(dep ? `  - #${id} ${dep.status} ${dep.subject}` : `  - #${id} (missing)`);
}
if (task.blockedBy.length > MAX_DEPS) {
    lines.push(`  ... +${task.blockedBy.length - MAX_DEPS} more`);
}
```

---

## Testing

1. Delegate 2 tasks — verify full listing preserved.
2. Delegate 8 tasks — verify grouped summary by assignee.
3. Delegate 16 tasks — verify grouped summary stays compact.
4. Broadcast to 6 teammates — verify `name1, name2, name3, +3 more` format.
5. Run `task_dep_ls` on a task with 10 dependencies — verify truncated output.
6. Verify `details` objects are unchanged (still contain full lists for debugging).

---

## Estimated Savings

| Scenario | Before (words) | After (words) | Savings |
|----------|---------------|--------------|---------|
| delegate 8 tasks | ~126 | ~40 | 68% |
| delegate 16 tasks | ~240 | ~50 | 79% |
| broadcast 8 recipients | ~20 | ~10 | 50% |
| task_dep_ls 10 deps | ~60 | ~40 | 33% |

---

## Files Changed

| File | Change |
|------|--------|
| `extensions/teams/leader-teams-tool.ts` | Add `summarizeNameList`, `summarizeTaskAssignments` helpers; modify 5 action handlers |
