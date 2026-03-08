import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ContextUsage } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { TeamConfig } from "./team-config.js";
import type { TeammateRpc } from "./teammate-rpc.js";
import type { SpawnTeammateFn } from "./spawn-types.js";
import type { TeamsStyle } from "./teams-style.js";
import { getTeamsStyleFromEnv, getTeamsStrings, formatMemberDisplayName } from "./teams-style.js";
import { ensureTeamConfig } from "./team-config.js";
import { getTeamDir } from "./paths.js";

// ---------------------------------------------------------------------------
// Shared opts type — passed to every tool registration function.
// ---------------------------------------------------------------------------

export interface TeamToolOpts {
	pi: ExtensionAPI;
	teammates: Map<string, TeammateRpc>;
	spawnTeammate: SpawnTeammateFn;
	getTeamId: (ctx: ExtensionContext) => string;
	getTaskListId: () => string | null;
	refreshTasks: () => Promise<void>;
	renderWidget: () => void;
	pendingPlanApprovals: Map<string, { requestId: string; name: string; taskId?: string }>;
	getContextUsage: () => ContextUsage | undefined;
	triggerCompaction?: () => void;
	/** Optional cached team config — avoids hitting disk on every tool call. */
	getTeamConfig?: () => TeamConfig | null;
}

// ---------------------------------------------------------------------------
// Common team context resolution — shared by all tool handlers.
// ---------------------------------------------------------------------------

export interface TeamToolContext {
	teamId: string;
	teamDir: string;
	effectiveTlId: string;
	cfg: TeamConfig;
	style: TeamsStyle;
	strings: ReturnType<typeof getTeamsStrings>;
	refreshUi: () => Promise<void>;
}

export async function resolveTeamToolContext(opts: TeamToolOpts, ctx: ExtensionContext): Promise<TeamToolContext> {
	const teamId = opts.getTeamId(ctx);
	const teamDir = getTeamDir(teamId);
	const taskListId = opts.getTaskListId();
	const effectiveTlId = taskListId ?? teamId;
	// Use cached config when available to avoid hitting disk on every tool call.
	const cached = opts.getTeamConfig?.();
	const cfg = cached ?? await ensureTeamConfig(teamDir, {
		teamId,
		taskListId: effectiveTlId,
		leadName: "team-lead",
		style: getTeamsStyleFromEnv(),
	});
	const style: TeamsStyle = cfg.style ?? getTeamsStyleFromEnv();
	const strings = getTeamsStrings(style);
	const refreshUi = async (): Promise<void> => {
		await opts.refreshTasks();
		opts.renderWidget();
	};
	return { teamId, teamDir, effectiveTlId, cfg, style, strings, refreshUi };
}

// ---------------------------------------------------------------------------
// Shared result helpers
// ---------------------------------------------------------------------------

/** Build a terse tool result — keeps content to a single text block for minimal context usage. */
export function compactResult(text: string, details: unknown): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

/**
 * Append a context-usage warning to a tool result when context pressure is
 * high. The warning is placed in a second `content` block so the LLM sees
 * it alongside the result and can self-regulate.
 */
export function appendContextWarning(
	result: AgentToolResult<unknown>,
	usage: ContextUsage | undefined,
	triggerCompaction?: () => void,
): AgentToolResult<unknown> {
	const percent = usage?.percent;
	if (percent === null || percent === undefined || percent < 65) return result;

	let warning: string;
	if (percent > 80) {
		warning = `⚠️ Context ${percent.toFixed(0)}% full. Finish active tasks before delegating more. Avoid policy queries.`;
	} else {
		warning = `Context at ${percent.toFixed(0)}%. Consider wrapping up current delegation cycle.`;
	}

	if (percent > 85 && triggerCompaction) {
		triggerCompaction();
	}

	return {
		...result,
		content: [...result.content, { type: "text" as const, text: warning }],
	};
}

// ---------------------------------------------------------------------------
// Shared list-summary helpers
// ---------------------------------------------------------------------------

/** Threshold at which lists are summarized instead of fully enumerated. */
const LIST_THRESHOLD = 4;

/** Summarize a list of names: inline if ≤ threshold, otherwise show first 3 + "+N more". */
export function summarizeNameList(names: string[], style: TeamsStyle, noun: string): string {
	if (names.length === 0) return `0 ${noun}(s)`;
	if (names.length <= LIST_THRESHOLD) {
		return `${names.length} ${noun}(s): ${names.map((n) => formatMemberDisplayName(style, n)).join(", ")}`;
	}
	const shown = names.slice(0, 3).map((n) => formatMemberDisplayName(style, n)).join(", ");
	return `${names.length} ${noun}(s): ${shown}, +${names.length - 3} more`;
}

/** Summarize task assignments: full list if ≤ threshold, otherwise grouped by assignee. */
export function summarizeTaskAssignments(
	assignments: Array<{ taskId: string; assignee: string; subject: string }>,
	style: TeamsStyle,
): string[] {
	const lines: string[] = [];
	if (assignments.length <= LIST_THRESHOLD) {
		for (const a of assignments) {
			lines.push(`#${a.taskId} → ${formatMemberDisplayName(style, a.assignee)}: ${a.subject}`);
		}
	} else {
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

// ---------------------------------------------------------------------------
// Shared schema fragments — used by delegate + member tools.
// ---------------------------------------------------------------------------

export const TeamsContextModeSchema = StringEnum(["fresh", "branch"] as const, {
	description: "How to initialize teammate session context. 'branch' clones the leader session branch.",
	default: "fresh",
});

export const TeamsWorkspaceModeSchema = StringEnum(["shared", "worktree"] as const, {
	description: "Workspace isolation mode. 'shared' matches Claude Teams; 'worktree' creates a git worktree per teammate.",
	default: "shared",
});

export const TeamsThinkingLevelSchema = StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const, {
	description:
		"Thinking level to use for spawned teammates (defaults to the leader's current thinking level when omitted).",
});

export const TeamsModelSchema = Type.Optional(
	Type.String({
		description:
			"Optional model override for spawned teammates. Use '<provider>/<modelId>'. If you pass only '<modelId>', the provider is inherited from the leader when available.",
	}),
);

