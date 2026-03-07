import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@mariozechner/pi-ai";
import type { TeamTask } from "./task-store.js";
import type { TeamConfig } from "./team-config.js";
import type { TeammateRpc } from "./teammate-rpc.js";
import type { TeamsStyle } from "./teams-style.js";
import { formatMemberDisplayName } from "./teams-style.js";

// ---------------------------------------------------------------------------
// Stale-action classification
// ---------------------------------------------------------------------------

/** Actions whose tool results become stale once newer teams results exist. */
const STALE_ACTIONS = new Set([
	"delegate",
	"task_assign",
	"task_unassign",
	"task_set_status",
	"task_dep_add",
	"task_dep_rm",
	"message_dm",
	"message_broadcast",
	"message_steer",
	"member_spawn",
	"member_shutdown",
	"member_kill",
	"member_prune",
]);

/** Always keep the last N teams tool results regardless of staleness. */
const KEEP_RECENT_TOOL_RESULTS = 6;

// ---------------------------------------------------------------------------
// State snapshot
// ---------------------------------------------------------------------------

/**
 * Build a compact snapshot of the current team state suitable for replacing stale
 * tool results in context. This is re-generated on every LLM call, so it
 * always reflects the latest reality.
 */
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
	const online = teamConfig?.members.filter((m) => m.status === "online") ?? [];
	const rpcNames = Array.from(teammates.keys());
	const allActive = new Set([...online.map((m) => m.name), ...rpcNames]);
	if (allActive.size > 0) {
		const formatted = Array.from(allActive)
			.sort()
			.map((n) => formatMemberDisplayName(style, n));
		lines.push(`Teammates online: ${formatted.join(", ")}`);
	} else {
		lines.push("No teammates online.");
	}

	// Tasks by status
	const pending = tasks.filter((t) => t.status === "pending");
	const inProgress = tasks.filter((t) => t.status === "in_progress");
	const completed = tasks.filter((t) => t.status === "completed");

	if (inProgress.length > 0) {
		lines.push(`In-progress (${inProgress.length}): ${inProgress.map((t) => `#${t.id}→${t.owner ?? "?"}`).join(", ")}`);
	}
	if (pending.length > 0) {
		lines.push(`Pending (${pending.length}): ${pending.map((t) => `#${t.id}`).join(", ")}`);
	}
	if (completed.length > 0) {
		lines.push(`Completed (${completed.length}): ${completed.map((t) => `#${t.id}`).join(", ")}`);
	}

	// Pending approvals
	if (pendingApprovals.size > 0) {
		const names = Array.from(pendingApprovals.values()).map((a) => a.name);
		lines.push(`Pending plan approvals: ${names.join(", ")}`);
	}

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Context filter
// ---------------------------------------------------------------------------

/**
 * Build a mapping from toolCallId → action by scanning assistant messages
 * for tool calls targeting the "teams" tool.
 */
function buildToolCallActionMap(messages: AgentMessage[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const msg of messages) {
		if ((msg as AssistantMessage).role !== "assistant") continue;
		const assistant = msg as AssistantMessage;
		for (const block of assistant.content) {
			if (block.type !== "toolCall") continue;
			if (block.name !== "teams") continue;
			const action = block.arguments?.action;
			if (typeof action === "string") {
				map.set(block.id, action);
			}
		}
	}
	return map;
}

/**
 * Replace stale `teams` tool-result messages with a single compact state
 * snapshot. Messages are only modified at LLM-call time (via the `context`
 * event) — the persisted session is untouched.
 *
 * Returns the original `messages` array (same reference) if nothing needs
 * to be filtered, allowing the caller to skip the result.
 */
export function filterStaleTeamsResults(
	messages: AgentMessage[],
	stateSnapshot: string,
): AgentMessage[] {
	// 1. Find all teams tool-result indices whose action is stale-eligible.
	const actionMap = buildToolCallActionMap(messages);
	const staleEligibleIndices: number[] = [];

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i] as ToolResultMessage;
		if (msg.role !== "toolResult") continue;
		if (msg.toolName !== "teams") continue;
		const action = actionMap.get(msg.toolCallId);
		if (action && STALE_ACTIONS.has(action)) {
			staleEligibleIndices.push(i);
		}
	}

	// Nothing to trim — keep the last KEEP_RECENT_TOOL_RESULTS regardless.
	if (staleEligibleIndices.length <= KEEP_RECENT_TOOL_RESULTS) {
		return messages;
	}

	// 2. Mark all but the last KEEP_RECENT_TOOL_RESULTS as stale.
	const staleIndices = new Set(staleEligibleIndices.slice(0, -KEEP_RECENT_TOOL_RESULTS));

	// 3. Build filtered array: replace the first stale result with the
	//    snapshot (preserving the toolCallId so the tool-call/result pairing
	//    remains valid for the LLM provider) and drop the rest.
	let snapshotInjected = false;
	const filtered: AgentMessage[] = [];

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (!msg) continue;

		if (staleIndices.has(i)) {
			if (!snapshotInjected) {
				// Replace content but keep the message shell (role, toolCallId,
				// toolName, timestamp) so the provider pairing is intact.
				const original = msg as ToolResultMessage;
				filtered.push({
					...original,
					content: [{ type: "text", text: stateSnapshot }],
					details: undefined,
					isError: false,
				} as AgentMessage);
				snapshotInjected = true;
			}
			// Skip remaining stale results — they're collapsed into the snapshot.
			continue;
		}

		filtered.push(msg);
	}

	return filtered;
}
