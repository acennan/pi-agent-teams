# Leader Context Growth Analysis

## Executive Summary

In a long-running leader session the LLM context window fills up from three main sources: **(1) tool result accumulation** from repeated `teams` tool calls, **(2) `sendUserMessage` injections** that add full user-turn entries, and **(3) the static per-request overhead** of the tool definition schema and skill prompt. The extension currently does **nothing** to manage context lifecycle — there is no compaction hook, no result summarization, and no pruning of stale detail objects. Below is a source-by-source breakdown followed by concrete mitigation strategies.

---

## 1. Context Growth Sources (ranked by impact)

### 1.1 Tool Result Accumulation (HIGH — primary growth driver)

Every `teams` tool call returns **both** a `content` text block **and** a `details` JSON object. Both are persisted as assistant-side tool-result entries and remain in context for the life of the session (or until compaction).

| Action | Typical `content` size | Typical `details` size | Notes |
|--------|----------------------|----------------------|-------|
| `delegate` (8 tasks) | ~126 words | ~112 words | Lists every spawned name + every `{taskId, assignee, subject}` |
| `task_dep_ls` | Variable | Small | Enumerates all blockedBy/blocks with subjects — unbounded |
| `model_policy_get` | ~32 words | ~60 words | Includes deprecation policy, leader model, default selection |
| `hooks_policy_set` | ~30 words | ~50 words | Configured + effective values, both before and after |
| `message_broadcast` | ~20 words | ~30 words | Lists all recipient names |
| Simple mutations (`task_set_status`, `task_assign`, etc.) | ~10 words | ~20 words | Low per-call, but high frequency |

**Key problem:** The `details` object duplicates information already present in `content`. For example, a delegate result has the assignment list in the readable text *and* again as structured JSON in `details`. The LLM does not need the structured `details` — it's diagnostic metadata that bloats every tool-result entry.

**Estimated growth rate:** A typical orchestration cycle (delegate 8 tasks → monitor → reassign 2 → complete 3 → delegate 4 more) produces ~15–25 tool calls totaling **~3,000–5,000 tokens** of tool results. After 5–10 such cycles, tool results alone consume **15,000–50,000 tokens**.

### 1.2 `sendUserMessage` Injections (MEDIUM)

Two places inject full user messages into context:

| Location | Trigger | Content |
|----------|---------|---------|
| `leader.ts:878` | `/swarm` with no args | `"Use your /team commands to spawn a team of agents..."` (~30 words) |
| `leader.ts:881` | `/swarm <task>` | Full task text prepended with coordination instructions |

These become permanent user-turn entries. The `/swarm <task>` variant is especially concerning because the user's task description can be arbitrarily long and is injected verbatim.

### 1.3 Static Per-Request Overhead (LOW but constant)

Sent with **every** LLM API call:

| Component | Estimated tokens | Notes |
|-----------|-----------------|-------|
| `teams` tool definition (description) | ~133 | 6-line description paragraph |
| `teams` tool parameter schema | ~236 | 20 enum values + 18 parameter descriptions |
| SKILL.md (when activated) | ~1,600 | Full skill file loaded into system prompt |
| AGENTS.md | ~140 | Project-level agent instructions |
| **Total static overhead** | **~2,100** | Paid on every request regardless of session length |

The `teams` tool schema is a single monolithic tool with 20 actions, each with different required/optional fields. This "god tool" pattern means the full schema for all 20 actions is included even when the leader only needs `delegate` and `task_set_status`.

### 1.4 Background Processes (ZERO — well designed)

The inbox polling (`pollLeaderInbox`), hook chain execution (`enqueueHook`), and widget rendering all use `ctx.ui.notify()` which is **UI-only** and does not enter the LLM context. This is correct and well-designed. The activity tracker, transcript tracker, and team config refresh are also context-free.

---

## 2. What's Missing

### 2.1 No Compaction Integration

The pi SDK exposes:
- `ctx.compact(options?)` — trigger context compaction
- `session_before_compact` event — customize/cancel compaction
- `session_compact` event — post-compaction hook
- `ctx.getContextUsage()` — read current token usage

The teams extension **does not use any of these**. There is:
- No monitoring of context usage
- No automatic compaction trigger when usage gets high
- No custom compaction instructions to preserve team state
- No `session_before_compact` handler to inject team-aware summarization

### 2.2 No Result Summarization

Tool results are never trimmed or summarized. Old delegation results from 20 cycles ago remain in context at full fidelity even though the tasks they reference may have been completed, reassigned, or cleared.

### 2.3 No Deduplication of State

Each `delegate` call result contains the full list of spawned names and assignments. After 10 delegations, the context contains 10 copies of overlapping teammate rosters and task lists. There is no mechanism to consolidate these into a single "current team state" representation.

---

## 3. Mitigation Strategies

### Strategy A: Slim Tool Results (Low effort, high impact)

**Remove or minimize `details` objects.** The `details` field duplicates `content` and is consumed by the LLM but serves no LLM purpose — it's diagnostic metadata.

Options:
1. **Remove `details` entirely** from all tool results. The `content` text already contains everything the LLM needs.
2. **Move `details` to a non-context location** (e.g., `appendEntry()` which is persisted but not sent to the LLM, or log to the team dir).
3. **Minimal `details`** — keep only `{ action, ok: true }` for the LLM, log full details elsewhere.

**Estimated savings:** 30–50% reduction in per-tool-call context cost.

### Strategy B: Proactive Context Compaction (Medium effort, high impact)

Hook into pi's compaction system:

```typescript
// Monitor context usage on each refresh cycle
const usage = ctx.getContextUsage();
if (usage?.percent !== null && usage.percent > 70) {
    ctx.compact({
        customInstructions: buildTeamCompactionPrompt(tasks, teammates, teamConfig),
        onComplete: (result) => { /* log */ },
    });
}
```

Additionally, register a `session_before_compact` handler that injects a compact representation of current team state (active tasks, live teammates, pending approvals) so the compaction summary preserves operational context.

**Estimated impact:** Prevents context exhaustion entirely by summarizing old history while preserving current team state.

### Strategy C: Split the God Tool (Medium effort, medium impact)

Replace the single `teams` tool (20 actions, ~370 tokens of schema per request) with focused tools:

| Tool | Actions | Schema tokens (est.) |
|------|---------|---------------------|
| `teams_delegate` | delegate | ~80 |
| `teams_task` | task_assign, task_unassign, task_set_status, task_dep_* | ~100 |
| `teams_message` | message_dm, message_broadcast, message_steer | ~60 |
| `teams_member` | member_spawn, member_shutdown, member_kill, member_prune | ~80 |
| `teams_policy` | hooks_policy_*, model_policy_*, plan_approve/reject | ~80 |

Then only register the tools actually needed for the current session phase. During pure delegation, only `teams_delegate` + `teams_task` need to be active.

**Estimated savings:** ~50% reduction in static per-request tool schema overhead.

### Strategy D: Summarize-on-Completion Pattern (Medium effort, high impact)

When a delegation cycle completes (all tasks reach `completed`), automatically inject a **single summary** into the context and mark the detailed per-task tool results as "consumed." This could be done via:

1. A `session_before_compact` handler that replaces old delegation tool-call/result pairs with a compact summary entry.
2. Periodically calling `sendUserMessage` with a current-state snapshot and then triggering compaction to collapse the history.

Example compact state (~200 tokens total, replacing potentially 5,000+):
```
Team state: 4 teammates (alpha, bravo, charlie, delta) all online.
Completed: #1 auth, #2 DB, #3 API, #4 WebSocket (all passed quality gates).
Active: #5 tests (alpha, in_progress), #6 CI (bravo, in_progress).
Pending: #7 rate-limiting, #8 docs.
No pending plan approvals. Hooks policy: warn.
```

### Strategy E: Lazy Skill Loading (Low effort, low impact)

The SKILL.md (~1,600 tokens) is loaded into the system prompt when the skill is activated. Consider:
- Trimming it to essentials (the tool action table alone is ~400 words)
- Making it a "reference" that the leader can read on demand rather than always-present context
- Splitting into a brief "cheatsheet" (always loaded) and a "full reference" (read tool on demand)

### Strategy F: Bounded Task Listing in Results (Low effort, medium impact)

The `delegate` action result lists every individual task assignment. For large delegations (8+ tasks), summarize instead:

**Before (current):**
```
Delegated 8 task(s):
- #1 → alpha: Implement user authentication...
- #2 → bravo: Set up database migrations...
[... 6 more lines ...]
```

**After (bounded):**
```
Delegated 8 task(s) to 4 teammates (alpha ×2, bravo ×2, charlie ×2, delta ×2).
Task IDs: #1–#8. Use task_dep_ls or the task list for details.
```

Apply similar truncation to `message_broadcast` recipient lists, `member_prune` results, etc.

### Strategy G: Context-Aware Idle Detection (Low effort, medium impact)

After each tool call, check context usage and warn the LLM:

```typescript
const usage = ctx.getContextUsage();
if (usage?.percent && usage.percent > 60) {
    // Append a note to the tool result
    content.push({
        type: "text",
        text: `⚠️ Context usage: ${usage.percent.toFixed(0)}%. Consider completing current tasks before delegating more.`
    });
}
if (usage?.percent && usage.percent > 80) {
    ctx.compact({ customInstructions: buildTeamCompactionPrompt(...) });
}
```

---

## 4. Recommended Priority Order

| Priority | Strategy | Effort | Impact | Tokens saved per session |
|----------|----------|--------|--------|-------------------------|
| 1 | **A: Slim tool results** | Low | High | 30–50% of accumulated results |
| 2 | **B: Proactive compaction** | Medium | High | Prevents exhaustion entirely |
| 3 | **F: Bounded result listings** | Low | Medium | ~40% per delegation result |
| 4 | **D: Summarize-on-completion** | Medium | High | 80%+ of completed-cycle history |
| 5 | **G: Context-aware warnings** | Low | Medium | Behavioral — reduces unnecessary calls |
| 6 | **C: Split god tool** | Medium | Medium | ~180 tokens per request |
| 7 | **E: Lazy skill loading** | Low | Low | ~800 tokens per request |

Strategies A + B alone would address the majority of context pressure. Adding F + D would make the leader viable for sessions spanning dozens of delegation cycles without context exhaustion.

---

## 5. Appendix: File Reference

| File | Role in context growth |
|------|----------------------|
| `leader-teams-tool.ts` | **Primary** — all 53 tool result return points with `content` + `details` |
| `leader.ts:878–881` | `sendUserMessage` injections from `/swarm` command |
| `leader-inbox.ts` | Safe — uses `ui.notify` only (no context impact) |
| `leader.ts` (hook chain) | Safe — uses `ui.notify` only |
| `skills/agent-teams/SKILL.md` | ~1,600 tokens static system prompt when active |
| `AGENTS.md` | ~140 tokens static system prompt |
