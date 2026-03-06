# Implementation Plan: Deliver Leader Inbox Messages to LLM Conversation Context

**Problem:** Teammate DMs sent to the leader are routed through `ctx.ui.notify()` in `pollLeaderInbox()`, which only displays them in the TUI notification area. The leader LLM never sees message content in its conversation, so it silently ignores actionable requests — for example, a director teammate sending spawn requests that the leader skill (suss-research) expects to relay.

**Root cause:** In `leader-inbox.ts`, every inbox message branch terminates with `ctx.ui.notify(...)` and `continue`. Unlike the worker, which uses `pi.sendUserMessage()` to inject mailbox content into its agent conversation, the leader has no equivalent injection path. The worker's `pendingDmTexts` pattern (accumulate → `sendUserMessage` → triggers LLM turn) demonstrates the correct approach, but the leader never adopted it.

**Parity gap:** Claude Code's native team feature delivers teammate DMs directly into the leader agent's conversation context so the LLM can reason about and act on them. This extension only displays them as ephemeral TUI notifications.

---

## Design Principles

1. **Selective injection** — Not every inbox message should trigger an LLM turn. Structured protocol acks (shutdown_approved, shutdown_rejected, set_session_name) are operational bookkeeping and should remain notification-only. Actionable content (plain DMs, plan approval requests, peer DM summaries, idle-with-completed-task notifications) should be delivered to the LLM.
2. **Batched delivery** — Messages should accumulate during a poll cycle and be delivered in a single `pi.sendUserMessage()` call to avoid spamming the LLM with rapid-fire turns.
3. **Non-disruptive when streaming** — If the leader LLM is actively streaming, queued messages should use `deliverAs: "nextTurn"` (via `pi.sendMessage`) or be held until the current turn ends, to avoid interrupting tool execution mid-flow.
4. **TUI notifications preserved** — `ctx.ui.notify()` calls remain for observability in the TUI panel. The change adds LLM delivery alongside, not replacing, notification display.
5. **Backward compatible** — Existing structured message handlers (idle, shutdown, plan approval) keep their current side-effects (status updates, hook triggers, member tracking). The LLM injection is additive.

---

## Gap analysis (updated 2026-03-06)

The original plan covers the inbox-side problem comprehensively. Two additional gaps were identified during review:

### Gap A: Task completion messages lack task context

The plan's implementation sketch for idle-with-completed-task only emits the task **ID** (e.g., `"completed task #7"`). The leader LLM cannot make informed follow-up decisions (assign next work, re-prioritise) without knowing **what** the task was. The `getTask()` call is already performed in the same handler for hook invocations — we should reuse it to enrich the LLM message with the task subject and (if failed) the failure reason.

### Gap B: Hook / quality-gate results never reach the leader LLM

The `enqueueHook` closure in `leader.ts` suffers from the **same notify-only problem**. After a quality-gate hook runs, outcomes (pass, fail, task reopened, follow-up created) are reported exclusively via `ctx.ui.notify()`. The leader LLM is never told whether a completed task passed or failed its quality gate, so it cannot reason about remediation strategy, reassignment, or pipeline progression.

This is the same class of bug as the inbox issue and should be addressed in the same implementation pass. Change §6 below covers the fix.

---

## Changes

### 1. Add `pi` (ExtensionAPI) reference to the leader inbox poll flow

**File:** `extensions/teams/leader-inbox.ts`

**What:** The `pollLeaderInbox` function currently receives `ctx: ExtensionContext` but has no access to `pi: ExtensionAPI` (which owns `sendUserMessage`). Add `pi` to the options parameter.

**Why:** `ctx.ui.notify()` is a TUI-only display method. `pi.sendUserMessage()` is the mechanism that injects content into the agent's conversation and triggers a turn — this is the same mechanism the worker uses.

```typescript
// Current signature
export async function pollLeaderInbox(opts: {
    ctx: ExtensionContext;
    teamId: string;
    // ...
}): Promise<void>

// New signature — add pi
export async function pollLeaderInbox(opts: {
    ctx: ExtensionContext;
    pi: ExtensionAPI;           // ← NEW
    teamId: string;
    // ...
}): Promise<void>
```

**Callsite update** in `leader.ts`: The `pollLeaderInbox` wrapper already has `pi` in scope (it's the parameter of `runLeader`), so threading it through is trivial:

```typescript
// leader.ts — pollLeaderInbox wrapper
const pollLeaderInbox = async () => {
    if (!currentCtx || !currentTeamId) return;
    // ...
    await pollLeaderInboxImpl({
        ctx: currentCtx,
        pi,                     // ← NEW
        teamId: currentTeamId,
        // ... rest unchanged
    });
};
```

---

### 2. Accumulate LLM-bound messages during the poll loop

**File:** `extensions/teams/leader-inbox.ts`

**What:** Introduce a local `pendingContextMessages: string[]` array at the top of `pollLeaderInbox`. As messages are processed, append formatted context strings for messages that should reach the LLM. After the `for` loop, if the array is non-empty, batch them into a single `pi.sendUserMessage()` call.

**Message categorization:**

| Message type | Current behavior | LLM delivery? | Rationale |
|---|---|---|---|
| `shutdown_approved` | notify + status update | **No** | Operational ack; leader doesn't need to reason about it. |
| `shutdown_rejected` | notify + status update | **Yes** | Leader may need to decide on forced kill or retry. |
| `plan_approval_request` | notify + add to `pendingPlanApprovals` | **Yes** | Leader LLM must review the plan and approve/reject. |
| `peer_dm_sent` | notify | **Yes** (summary) | Leader should be aware of inter-teammate coordination. |
| `idle_notification` (with completed task) | notify + hooks + status update | **Yes** | Leader may need to assign next work or react to failure. |
| `idle_notification` (simple idle) | notify + status update | **Yes** (brief) | Leader should know a teammate is available. |
| `idle_notification` (failure/offline) | notify + status update | **Yes** | Leader needs to know a teammate went down. |
| Plain DM (catch-all) | notify | **Yes** | This is the primary bug — actionable requests from teammates. |

**Implementation sketch:**

```typescript
const pendingContextMessages: string[] = [];

for (const m of msgs) {
    // ... existing handlers with ctx.ui.notify() preserved ...

    const approved = isShutdownApproved(m.text);
    if (approved) {
        // ... existing logic unchanged ...
        // No LLM injection — operational ack only
        continue;
    }

    const rejected = isShutdownRejected(m.text);
    if (rejected) {
        // ... existing logic unchanged ...
        pendingContextMessages.push(
            `[Team] ${formatMemberDisplayName(style, name)} refused shutdown: ${rejected.reason}`
        );
        continue;
    }

    const planReq = isPlanApprovalRequest(m.text);
    if (planReq) {
        // ... existing logic unchanged ...
        pendingContextMessages.push(
            `[Team] ${formatMemberDisplayName(style, name)} requests plan approval for task #${planReq.taskId ?? "unknown"}:\n${planReq.plan}`
        );
        continue;
    }

    const peerDm = isPeerDmSent(m.text);
    if (peerDm) {
        // ... existing logic unchanged ...
        pendingContextMessages.push(
            `[Team] Peer message: ${peerDm.from} → ${peerDm.to}: ${peerDm.summary}`
        );
        continue;
    }

    const idle = isIdleNotification(m.text);
    if (idle) {
        // ... existing hook/status logic unchanged ...

        // Enrich with task subject when available (getTask is already called for hooks).
        let taskSubject: string | undefined;
        if (idle.completedTaskId) {
            const task = await getTask(teamDir, taskListId, idle.completedTaskId);
            taskSubject = task?.subject;
        }
        const taskRef = taskSubject
            ? `task #${idle.completedTaskId} ("${taskSubject}")`
            : `task #${idle.completedTaskId}`;
        
        if (idle.failureReason) {
            pendingContextMessages.push(
                `[Team] ${name} went offline: ${idle.failureReason}`
            );
        } else if (idle.completedTaskId && idle.completedStatus === "failed") {
            pendingContextMessages.push(
                `[Team] ${name} aborted ${taskRef} and is now idle.`
            );
        } else if (idle.completedTaskId) {
            pendingContextMessages.push(
                `[Team] ${name} completed ${taskRef} and is now idle. Consider reviewing their work or assigning new tasks.`
            );
        } else {
            pendingContextMessages.push(
                `[Team] ${name} is idle (no active task).`
            );
        }
        continue;
    }

    // Catch-all: plain DMs — the primary bug fix
    pendingContextMessages.push(
        `[Team] Message from ${m.from}: ${m.text}`
    );
}

// After loop: batch-deliver to LLM
if (pendingContextMessages.length > 0) {
    const combined = pendingContextMessages.join("\n\n---\n\n");
    pi.sendUserMessage(
        `You have received the following team messages. Review and take action as needed:\n\n${combined}`
    );
}
```

---

### 3. Handle streaming-leader edge case

**File:** `extensions/teams/leader-inbox.ts` (or `leader.ts` at the callsite)

**What:** If the leader LLM is currently streaming (mid-turn), a `sendUserMessage` call will queue as a follow-up. The default `deliverAs` behavior for `sendUserMessage` is fine for most cases, but for non-urgent notifications (idle, peer DM summaries), we may want to use `pi.sendMessage` with `deliverAs: "nextTurn"` to avoid interrupting the leader's current reasoning.

**Approach:** Separate messages into two tiers:
- **Urgent** (plain DMs, plan approval requests, shutdown rejections, failure/offline notifications): Use `pi.sendUserMessage()` (triggers a turn immediately or queues as follow-up).
- **Informational** (simple idle notifications, peer DM summaries): Use `pi.sendMessage()` with `triggerTurn: true, deliverAs: "nextTurn"` so they arrive in context at the start of the next natural turn rather than interrupting.

**Implementation detail:** Add a second accumulation array `pendingInfoMessages` alongside `pendingContextMessages`. Deliver them separately at the end of the loop.

```typescript
// Urgent → pi.sendUserMessage() (triggers turn / follows up)
if (pendingContextMessages.length > 0) {
    const combined = pendingContextMessages.join("\n\n---\n\n");
    pi.sendUserMessage(
        `You have received the following team messages. Review and take action as needed:\n\n${combined}`
    );
}

// Informational → pi.sendMessage() (nextTurn, non-interrupting)
if (pendingInfoMessages.length > 0) {
    const combined = pendingInfoMessages.join("\n\n---\n\n");
    pi.sendMessage(
        {
            customType: "team-inbox-info",
            content: combined,
            display: `[Team status updates: ${pendingInfoMessages.length} message(s)]`,
        },
        { triggerTurn: true, deliverAs: "nextTurn" }
    );
}
```

---

### 4. Opt-out escape hatch

**File:** `extensions/teams/leader.ts` (env parsing)

**What:** Add an environment variable `PI_TEAMS_LEADER_INBOX_DELIVERY` that controls delivery behavior. Values:
- `context` (default) — deliver to LLM context (new behavior).
- `notify` — TUI notification only (legacy behavior).

**Why:** Allows users/skills that deliberately don't want LLM turns triggered by inbox messages to opt out. Also useful for debugging.

```typescript
const inboxDelivery = process.env.PI_TEAMS_LEADER_INBOX_DELIVERY ?? "context";
```

Pass `inboxDelivery` to `pollLeaderInbox` opts; when set to `"notify"`, skip the `sendUserMessage` / `sendMessage` calls entirely (retaining only `ctx.ui.notify()` as today).

---

### 5. Deduplication guard

**File:** `extensions/teams/leader-inbox.ts`

**What:** The inbox poll runs on a 700ms interval. While `popUnreadMessages` marks messages as read atomically (so they won't be re-read), there's a timing window where the LLM could still be processing a previous batch when a new poll fires. Add a simple guard:

```typescript
let contextDeliveryInFlight = false;

// In pollLeaderInbox:
if (pendingContextMessages.length > 0 && !contextDeliveryInFlight) {
    contextDeliveryInFlight = true;
    // ... sendUserMessage ...
    // Reset on next agent_end or after a timeout
}
```

Actually, this is better handled at the `leader.ts` level via the existing `inboxInFlight` flag, which already serializes polls. Since `popUnreadMessages` is atomic, there's no duplication risk. The main concern is flooding: if 10 teammates all go idle at once, we'd send 10 idle messages in one batch — this is acceptable because they're batched into a single `sendUserMessage` call.

**Verdict:** No extra deduplication needed beyond existing `inboxInFlight` + atomic `popUnreadMessages`. But add a message-count cap (e.g., 50 messages per batch) with overflow indication to prevent pathologically large injections.

---

### 6. Deliver hook / quality-gate outcomes to the leader LLM

**File:** `extensions/teams/leader.ts` (inside the `enqueueHook` closure)

**What:** After a quality-gate hook runs, inject a context message into the leader's conversation summarising the outcome. This uses the same `pi.sendUserMessage()` / `pi.sendMessage()` mechanism as inbox delivery.

**Why:** Hook outcomes (pass/fail, task reopened, follow-up created) are currently only shown via `ctx.ui.notify()`. The leader LLM never learns whether a teammate's completed work passed quality gates, so it cannot reason about remediation, reassignment, or pipeline progression — the same class of bug as the inbox problem.

**Categorization:**
- **Hook passed** → informational (`pi.sendMessage` with `deliverAs: "nextTurn"`). The leader should know, but doesn't need to act urgently.
- **Hook failed** (with or without reopen/followup) → urgent (`pi.sendUserMessage`). The leader may need to reassign, escalate, or adjust strategy.

**Implementation sketch** (at the end of the `enqueueHook` closure, after existing `ctx.ui.notify()` calls):

```typescript
// After existing notify calls — inject into LLM context.
if (ok) {
    const taskRef = task?.id ? ` for task #${task.id}` : "";
    const taskSubject = task?.subject ? ` ("${task.subject}")` : "";
    pi.sendMessage(
        {
            customType: "team-hook-result",
            content: `[Team] Quality gate ${hookName} passed${taskRef}${taskSubject} (${res.durationMs}ms).`,
            display: `[Hook passed: ${hookName}${taskRef}]`,
        },
        { triggerTurn: true, deliverAs: "nextTurn" }
    );
} else {
    const parts: string[] = [];
    parts.push(`[Team] Quality gate ${hookName} FAILED${task?.id ? ` for task #${task.id}` : ""}${task?.subject ? ` ("${task.subject}")` : ""}.`);
    parts.push(`Failure: ${failureSummary}`);
    if (taskReopened && task?.id) parts.push(`Task #${task.id} was auto-reopened to pending.`);
    if (taskReopenSuppressed && task?.id) parts.push(`Auto-reopen suppressed for task #${task.id} (limit ${maxReopens}).`);
    if (followupTask?.id) parts.push(`Follow-up task #${followupTask.id} was created.`);
    parts.push("Review the situation and decide on next steps.");

    pi.sendUserMessage(parts.join("\n"));
}
```

**Note:** The `pi` reference is already in scope inside `runLeader()` — no signature changes needed for this change.

---

## Files Changed (Summary)

| File | Change |
|---|---|
| `extensions/teams/leader-inbox.ts` | Add `pi` param; accumulate `pendingContextMessages` / `pendingInfoMessages`; enrich idle messages with task subject via `getTask()`; batch-deliver via `sendUserMessage` / `sendMessage` after loop; respect `inboxDelivery` opt-out. |
| `extensions/teams/leader.ts` | Thread `pi` into `pollLeaderInboxImpl` call; parse `PI_TEAMS_LEADER_INBOX_DELIVERY` env var; inject hook/quality-gate outcomes into LLM context (§6). |
| `docs/claude-parity.md` | Update parity matrix: leader inbox delivery → ✅. |
| `README.md` | Document `PI_TEAMS_LEADER_INBOX_DELIVERY` env var in config table. |
| `skills/agent-teams/SKILL.md` | Mention that teammate messages are now delivered to the leader's conversation context. |

---

## Testing

1. **Unit-level:** Update/add smoke tests in `scripts/smoke-test.mts` to verify that `pollLeaderInbox` with a mock `pi` object calls `sendUserMessage` for plain DMs and `sendMessage` for informational idle notifications.

2. **E2E:** Extend `scripts/e2e-rpc-test.mjs`:
   - Teammate writes a plain-text DM to the leader's mailbox.
   - Verify the leader's session transcript contains the DM content (not just a TUI notification).
   - Verify the leader LLM triggers a turn in response.

3. **Manual:** With `PI_TEAMS_STYLE=soviet`, spawn a comrade, have it send a DM with an actionable request (e.g., "please spawn two more comrades for the auth module"), verify the leader LLM sees and acts on it.

4. **Opt-out:** Set `PI_TEAMS_LEADER_INBOX_DELIVERY=notify`, repeat the DM test, verify the leader LLM does NOT receive the message (only TUI notification).

5. **Task subject in completion messages:** Create a task with a descriptive subject, have a teammate complete it, verify the leader LLM's injected message includes the task subject string (not just the numeric ID).

6. **Hook result delivery:** Configure a quality-gate hook (e.g., a linter that fails), have a teammate complete a task, verify:
   - Hook failure message appears in the leader LLM's conversation (not just TUI).
   - If the task is auto-reopened, the LLM message mentions the reopen.
   - Hook pass messages arrive as `nextTurn` (non-interrupting).

---

## Risk Assessment

| Risk | Mitigation |
|---|---|
| LLM turn storm — many idle notifications trigger rapid turns | Batching into single `sendUserMessage`; informational messages use `nextTurn` delivery; 700ms poll interval naturally throttles. |
| Large plan text inflating context | Already truncated to 500 chars in `ctx.ui.notify()`; for LLM delivery, send full plan (the LLM needs it to review). Add a hard cap (e.g., 8KB) with truncation + "see task store" pointer. |
| Breaking change for users who rely on leader not auto-acting on DMs | `PI_TEAMS_LEADER_INBOX_DELIVERY=notify` opt-out preserves legacy behavior. |
| `sendUserMessage` called when no `currentCtx` | Already guarded by the `if (!currentCtx || !currentTeamId) return;` at the top of `pollLeaderInbox`. |
| Double-delivery: hook result + inbox idle arrive as two separate LLM turns | Hooks run asynchronously after inbox poll; the two paths are independent. This is acceptable — the idle message says "completed task X", the hook message says "quality gate passed/failed for task X". They convey different information. |
| `getTask()` called twice for same task (inbox + hooks) | Negligible cost — file-system read, already cached by OS. Not worth adding a shared cache for. |
