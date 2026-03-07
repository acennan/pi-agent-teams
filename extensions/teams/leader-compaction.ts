import type { TeamTask } from "./task-store.js";
import type { TeamConfig } from "./team-config.js";
import type { TeammateRpc } from "./teammate-rpc.js";
import type { TeamsStyle } from "./teams-style.js";
import { getTeamsStrings, formatMemberDisplayName } from "./teams-style.js";

/**
 * Build custom compaction instructions that preserve critical team state
 * in the compacted summary. Called when proactively triggering ctx.compact()
 * so the leader retains awareness of the team roster, task statuses, and
 * overall goal after context compaction.
 */
export function buildTeamCompactionInstructions(
	tasks: TeamTask[],
	teammates: Map<string, TeammateRpc>,
	teamConfig: TeamConfig | null,
	style: TeamsStyle,
): string {
	const strings = getTeamsStrings(style);
	const lines: string[] = [];
	lines.push(
		`IMPORTANT: This is a ${strings.leaderTitle.toLowerCase()} session. Preserve the following ${strings.teamNoun} state in the summary:`,
	);
	lines.push("");

	// Active teammates
	const online = teamConfig?.members.filter((m) => m.status === "online") ?? [];
	if (online.length > 0) {
		lines.push(
			`Active ${strings.memberTitle.toLowerCase()}s: ${online.map((m) => formatMemberDisplayName(style, m.name)).join(", ")}`,
		);
	}

	// Current task state (compact)
	const pending = tasks.filter((t) => t.status === "pending");
	const inProgress = tasks.filter((t) => t.status === "in_progress");
	const completed = tasks.filter((t) => t.status === "completed");

	if (inProgress.length > 0) {
		lines.push(
			`In-progress tasks: ${inProgress.map((t) => `#${t.id} ${t.subject} (${t.owner ?? "unassigned"})`).join("; ")}`,
		);
	}
	if (pending.length > 0) {
		lines.push(`Pending tasks: ${pending.map((t) => `#${t.id} ${t.subject}`).join("; ")}`);
	}
	if (completed.length > 0) {
		lines.push(`Completed: ${completed.length} task(s) (#${completed.map((t) => t.id).join(", #")})`);
	}

	lines.push("");
	lines.push("Discard individual tool call/result details from past delegation cycles.");
	lines.push(
		`Preserve: current ${strings.teamNoun} roster, all task IDs and their current status/owner, any pending decisions or approvals, and the user's original goal.`,
	);

	return lines.join("\n");
}
