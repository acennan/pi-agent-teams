import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { sanitizeName, pickAgentNames, pickNamesFromPool } from "./names.js";
import { getTeamsNamingRules } from "./teams-style.js";
import { createTask } from "./task-store.js";
import { writeToMailbox } from "./mailbox.js";
import { taskAssignmentPayload } from "./protocol.js";
import type { ContextMode, WorkspaceMode } from "./spawn-types.js";
import {
	type TeamToolOpts,
	resolveTeamToolContext,
	compactResult,
	appendContextWarning,
	summarizeTaskAssignments,
	TeamsContextModeSchema,
	TeamsWorkspaceModeSchema,
	TeamsThinkingLevelSchema,
	TeamsModelSchema,
} from "./leader-tool-shared.js";
import { fireAndForget } from "./fire-and-forget.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const TeamsDelegateTaskSchema = Type.Object({
	text: Type.String({ description: "Task / TODO text." }),
	assignee: Type.Optional(Type.String({ description: "Optional teammate name. If omitted, assigned round-robin." })),
});

const DelegateParamsSchema = Type.Object({
	tasks: Type.Array(TeamsDelegateTaskSchema, { description: "Tasks to delegate." }),
	teammates: Type.Optional(
		Type.Array(Type.String(), {
			description: "Explicit teammate names to use/spawn. If omitted, uses existing or auto-generates.",
		}),
	),
	maxTeammates: Type.Optional(
		Type.Integer({
			description: "If teammates list is omitted and none exist, spawn up to this many.",
			default: 4,
			minimum: 1,
			maximum: 16,
		}),
	),
	contextMode: Type.Optional(TeamsContextModeSchema),
	workspaceMode: Type.Optional(TeamsWorkspaceModeSchema),
	model: TeamsModelSchema,
	thinking: Type.Optional(TeamsThinkingLevelSchema),
});

type DelegateParams = Static<typeof DelegateParamsSchema>;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function executeDelegateAction(
	opts: TeamToolOpts,
	params: DelegateParams,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
): Promise<AgentToolResult<unknown>> {
	const { teamId, teamDir, effectiveTlId, cfg, style } = await resolveTeamToolContext(opts, ctx);
	const { teammates, spawnTeammate } = opts;

	const inputTasks = params.tasks ?? [];
	if (inputTasks.length === 0) {
		return compactResult("No tasks provided. Provide tasks: [{text, assignee?}, ...]", { action: "delegate" });
	}

	const contextMode: ContextMode = params.contextMode === "branch" ? "branch" : "fresh";
	const requestedWorkspaceMode: WorkspaceMode = params.workspaceMode === "worktree" ? "worktree" : "shared";
	const modelOverride = params.model?.trim();
	const spawnModel = modelOverride && modelOverride.length > 0 ? modelOverride : undefined;
	const spawnThinking = params.thinking;

	let teammateNames: string[] = [];
	const explicit = params.teammates;
	if (explicit && explicit.length) {
		teammateNames = explicit.map((n) => sanitizeName(n)).filter((n) => n.length > 0);
	}

	if (teammateNames.length === 0 && teammates.size > 0) {
		teammateNames = Array.from(teammates.keys());
	}

	if (teammateNames.length === 0) {
		const maxTeammates = Math.max(1, Math.min(16, params.maxTeammates ?? 4));
		const count = Math.min(maxTeammates, inputTasks.length);
		const taken = new Set(teammates.keys());
		const naming = getTeamsNamingRules(style);
		teammateNames =
			naming.autoNameStrategy.kind === "agent"
				? pickAgentNames(count, taken)
				: pickNamesFromPool({
						pool: naming.autoNameStrategy.pool,
						count,
						taken,
						fallbackBase: naming.autoNameStrategy.fallbackBase,
					});
	}

	const spawned: string[] = [];
	const warnings: string[] = [];

	for (const name of teammateNames) {
		if (signal?.aborted) break;
		if (teammates.has(name)) continue;
		const res = await spawnTeammate(ctx, {
			name,
			mode: contextMode,
			workspaceMode: requestedWorkspaceMode,
			model: spawnModel,
			thinking: spawnThinking,
		});
		if (!res.ok) {
			warnings.push(`Failed to spawn '${name}': ${res.error}`);
			continue;
		}
		spawned.push(res.name);
		warnings.push(...res.warnings);
	}

	const assignments: Array<{ taskId: string; assignee: string; subject: string }> = [];
	let rr = 0;
	for (const t of inputTasks) {
		if (signal?.aborted) break;

		const text = t.text.trim();
		if (!text) {
			warnings.push("Skipping empty task");
			continue;
		}

		const explicitAssignee = t.assignee ? sanitizeName(t.assignee) : undefined;
		const assignee = explicitAssignee ?? teammateNames[rr++ % teammateNames.length];
		if (!assignee) {
			warnings.push(`No assignee available for task: ${text.slice(0, 60)}`);
			continue;
		}

		if (!teammates.has(assignee)) {
			const res = await spawnTeammate(ctx, {
				name: assignee,
				mode: contextMode,
				workspaceMode: requestedWorkspaceMode,
				model: spawnModel,
				thinking: spawnThinking,
			});
			if (res.ok) {
				spawned.push(res.name);
				warnings.push(...res.warnings);
			} else {
				warnings.push(`Failed to spawn assignee '${assignee}': ${res.error}`);
				continue;
			}
		}

		const description = text;
		const firstLine = description.split("\n").at(0) ?? "";
		const subject = firstLine.slice(0, 120);
		const task = await createTask(teamDir, effectiveTlId, { subject, description, owner: assignee });

		await writeToMailbox(teamDir, effectiveTlId, assignee, {
			from: cfg.leadName,
			text: JSON.stringify(taskAssignmentPayload(task, cfg.leadName)),
			timestamp: new Date().toISOString(),
		});

		assignments.push({ taskId: task.id, assignee, subject });
	}

	fireAndForget(opts.refreshTasks().finally(opts.renderWidget), ctx);

	const lines: string[] = [];
	lines.push(`Delegated ${assignments.length} task(s):`);
	lines.push(...summarizeTaskAssignments(assignments, style));
	if (spawned.length) lines.push(`Spawned: ${spawned.join(", ")}.`);
	if (warnings.length) lines.push(`Warnings: ${warnings.join("; ")}`);

	return compactResult(lines.join("\n"), {
		action: "delegate",
		teamId,
		taskListId: effectiveTlId,
		contextMode,
		workspaceMode: requestedWorkspaceMode,
		model: spawnModel,
		thinking: spawnThinking,
		spawned,
		assignments,
		warnings,
	});
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerTeamsDelegateTool(opts: TeamToolOpts): void {
	const { pi, getContextUsage, triggerCompaction } = opts;

	pi.registerTool({
		name: "teams_delegate",
		label: "Teams: Delegate",
		description:
			"Delegate tasks to teammate agents. Spawns teammates as needed and assigns tasks round-robin. " +
			"Provide a list of tasks with optional assignees. " +
			"Options: contextMode=branch (clone session context), workspaceMode=worktree (git worktree isolation).",
		parameters: DelegateParamsSchema,

		async execute(_toolCallId, params: DelegateParams, signal, _onUpdate, ctx) {
			const result = await executeDelegateAction(opts, params, signal, ctx);
			return appendContextWarning(result, getContextUsage(), triggerCompaction);
		},
	});
}
