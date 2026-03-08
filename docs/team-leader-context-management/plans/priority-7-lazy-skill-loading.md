# Implementation Plan: Priority 7 — Lazy Skill Loading (Strategy E)

**Effort:** Low | **Impact:** Low | **Tokens saved:** ~800 tokens per LLM request

---

## Problem

The skill file `skills/agent-teams/SKILL.md` is ~1,191 words (~1,600 tokens) and is loaded into the system prompt when the skill is activated. This content is sent with **every** LLM API request for the entire session lifetime.

Much of the SKILL.md content is reference material — full action tables, example code blocks, message protocol tables — that the leader only needs occasionally, not on every turn. The leader's first few turns benefit from the full reference, but after it has delegated and is in a monitoring loop, the detailed command reference is dead weight.

---

## Scope

**Modified file:** `skills/agent-teams/SKILL.md` → split into cheatsheet + reference  
**New file:** `skills/agent-teams/REFERENCE.md` → full reference (read on demand)

---

## Tasks

### Task 1: Identify essential vs reference content in SKILL.md

Current SKILL.md sections and their classification:

| Section | Words (approx.) | Classification |
|---------|-----------------|----------------|
| Header + Core concepts | ~80 | **Essential** |
| UI style | ~60 | Reference |
| Spawning teammates (tool action table) | ~300 | **Essential** (trimmed) |
| Tool examples | ~120 | Reference |
| `/team spawn` examples | ~50 | Reference |
| Task management commands | ~100 | Reference |
| Communication commands | ~40 | Reference |
| Governance modes | ~80 | Reference |
| Lifecycle commands | ~80 | Reference |
| Other commands | ~20 | Reference |
| Shared task list | ~60 | Reference |
| Message protocol table | ~100 | Reference |

**Essential content (~380 words, ~500 tokens):** Core concepts + trimmed action table.  
**Reference content (~810 words, ~1,100 tokens):** Everything else.

### Task 2: Create the trimmed SKILL.md (cheatsheet)

```markdown
---
name: agent-teams
description: "Coordinate multi-agent teamwork..."
---

# Agent Teams (Quick Reference)

You are the **leader** agent. Use the `teams` tool to delegate, manage tasks, message teammates, and handle lifecycle/policy.

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
```

This is ~150 words (~200 tokens) — an **87% reduction** from the original.

### Task 3: Create REFERENCE.md with the full content

Move all the detailed sections (examples, protocol table, governance modes, etc.) into `skills/agent-teams/REFERENCE.md`. This file is not loaded into the system prompt — the leader can read it on demand using the `read` tool if it needs detailed command syntax or protocol information.

### Task 4: Add a note to REFERENCE.md header

```markdown
# Agent Teams — Full Reference

> This file is not loaded into your system prompt. It is available for on-demand reading when you need detailed command syntax, examples, or protocol information.

[... full content from current SKILL.md ...]
```

---

## Design Decisions

1. **Keep the action table in the cheatsheet:** The action names and their one-word purposes are the most-referenced content. The leader needs to know what actions exist to use the tool correctly.
2. **Remove examples from cheatsheet:** The tool schema itself serves as the primary reference for parameter names and types. Examples are helpful on first use but redundant after.
3. **Remove protocol table from cheatsheet:** The leader doesn't construct protocol messages — the tool does. The protocol table is only useful for debugging.
4. **`read` tool for reference:** The leader already has access to the `read` tool. If it needs to look up `/team spawn` syntax or the message protocol, it can read the reference file. This is a one-time context cost when needed, vs. a permanent cost on every request.

---

## Alternative: Progressive loading

Instead of a static split, use the `before_agent_start` event to inject different system prompt content based on context usage:

```typescript
pi.on("before_agent_start", (event, ctx) => {
    const usage = ctx.getContextUsage();
    if (usage?.percent && usage.percent > 50) {
        // Replace full skill prompt with cheatsheet
        return { systemPrompt: event.systemPrompt.replace(FULL_SKILL, CHEATSHEET) };
    }
});
```

This is more complex but allows the full reference to be present during early turns when context is plentiful. **Recommended as a follow-up optimization**, not the initial implementation.

---

## Testing

1. Start a new session with the trimmed SKILL.md. Verify the leader can still correctly use the `teams` tool for delegation.
2. Verify the leader can `read` the REFERENCE.md when it needs detailed information.
3. Compare API request sizes before/after to confirm ~800 token reduction.
4. Run a full delegation cycle to ensure no degradation in leader behavior.

---

## Estimated Savings

| Metric | Before | After | Savings |
|--------|--------|-------|---------|
| SKILL.md in system prompt | ~1,600 tokens | ~200 tokens | ~1,400 tokens |
| Per-request overhead | ~2,100 tokens | ~700 tokens | ~1,400 tokens (67%) |
| 100-request session total | ~210,000 tokens | ~70,000 tokens | ~140,000 tokens |

Note: The per-request savings compound significantly in long sessions. For a 200-request session, this saves ~280,000 tokens of system prompt alone.

---

## Files Changed

| File | Change |
|------|--------|
| `skills/agent-teams/SKILL.md` | Replace with trimmed cheatsheet (~150 words) |
| `skills/agent-teams/REFERENCE.md` | **New** — full reference content moved here |
