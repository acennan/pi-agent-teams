import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { sanitizeName } from "./names.js";
import { formatMemberDisplayName } from "./teams-style.js";
import { listTasks, unassignTasksForAgent } from "./task-store.js";
import { setMemberStatus } from "./team-config.js";
import { writeToMailbox } from "./mailbox.js";
import { TEAM_MAILBOX_NS } from "./protocol.js";
import type { ContextMode, WorkspaceMode } from "./spawn-types.js";
import {
	type TeamToolOpts,
	resolveTeamToolContext,
	compactResult,
	appendContextWarning,
	summarizeNameList,
	TeamsContextModeSchema,
	TeamsWorkspaceModeSchema,
	TeamsThinkingLevelSchema,
	TeamsModelSchema,
} from "./leader-tool-shared.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const MemberActionSchema = StringEnum(
	["spawn", "shutdown", "kill", "prune"] as const,
	{ description: "Member lifecycle action.", default: "spawn" },
);

const MemberParamsSchema = Type.Object({
	action: MemberActionSchema,
	name: Type.Optional(Type.String({ description: "Teammate name." })),
	all: Type.Optional(Type.Boolean({ description: "For shutdown/prune, apply to all workers." })),
	reason: Type.Optional(Type.String({ description: "Optional reason for lifecycle actions." })),
	planRequired: Type.Optional(Type.Boolean({ description: "For spawn, start worker in plan-required mode." })),
	contextMode: Type.Optional(TeamsContextModeSchema),
	workspaceMode: Type.Optional(TeamsWorkspaceModeSchema),
	model: TeamsModelSchema,
	thinking: Type.Optional(TeamsThinkingLevelSchema),
});

type MemberParams = Static<typeof MemberParamsSchema>;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function executeMemberAction(
	opts: TeamToolOpts,
	params: MemberParams,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
): Promise<AgentToolResult<unknown>> {
	const { teamId, teamDir, effectiveTlId, cfg, style, strings, refreshUi } = await resolveTeamToolContext(opts, ctx);
	const { teammates, spawnTeammate } = opts;
	const action = params.action;

	if (action === "spawn") {
		const nameRaw = params.name?.trim();
		const name = sanitizeName(nameRaw ?? "");
		if (!name) {
			return {
				content: [{ type: "text", text: "spawn requires name" }],
				details: { action, name: nameRaw },
			};
		}
		if (teammates.has(name)) {
			return {
				content: [{ type: "text", text: `${formatMemberDisplayName(style, name)} is already running` }],
				details: { action, teamId, name, alreadyRunning: true },
			};
		}

		const contextMode: ContextMode = params.contextMode === "branch" ? "branch" : "fresh";
		const workspaceMode: WorkspaceMode = params.workspaceMode === "worktree" ? "worktree" : "shared";
		const modelOverride = params.model?.trim();
		const spawnModel = modelOverride && modelOverride.length > 0 ? modelOverride : undefined;
		const res = await spawnTeammate(ctx, {
			name,
			mode: contextMode,
			workspaceMode,
			model: spawnModel,
			thinking: params.thinking,
			planRequired: params.planRequired === true,
		});

		if (!res.ok) {
			return {
				content: [{ type: "text", text: `Failed to spawn ${formatMemberDisplayName(style, name)}: ${res.error}` }],
				details: { action, teamId, name, error: res.error },
			};
		}

		await refreshUi();
		const lines: string[] = [
			`Spawned ${formatMemberDisplayName(style, res.name)} (${res.mode}/${res.workspaceMode})`,
		];
		if (res.note) lines.push(`note: ${res.note}`);
		for (const w of res.warnings) lines.push(`warning: ${w}`);
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { action, teamId, name: res.name, mode: res.mode, workspaceMode: res.workspaceMode, warnings: res.warnings },
		};
	}

	if (action === "kill") {
		const nameRaw = params.name?.trim();
		const name = sanitizeName(nameRaw ?? "");
		if (!name) {
			return {
				content: [{ type: "text", text: "kill requires name" }],
				details: { action, name: nameRaw },
			};
		}
		const rpc = teammates.get(name);
		if (!rpc) {
			return {
				content: [{ type: "text", text: `Unknown ${strings.memberTitle.toLowerCase()}: ${name}` }],
				details: { action, name },
			};
		}

		await rpc.stop();
		teammates.delete(name);
		await unassignTasksForAgent(teamDir, effectiveTlId, name, `${formatMemberDisplayName(style, name)} ${strings.killedVerb}`);
		await setMemberStatus(teamDir, name, "offline", { meta: { killedAt: new Date().toISOString() } });
		await refreshUi();
		return {
			content: [{ type: "text", text: `${formatMemberDisplayName(style, name)} ${strings.killedVerb} (SIGTERM)` }],
			details: { action, teamId, name },
		};
	}

	if (action === "shutdown") {
		const reason = params.reason?.trim();
		const all = params.all === true;
		const explicitName = sanitizeName(params.name?.trim() ?? "");
		if (!all && !explicitName) {
			return {
				content: [{ type: "text", text: "shutdown requires name (or all=true)" }],
				details: { action },
			};
		}

		const recipients = new Set<string>();
		if (all) {
			for (const m of cfg.members) {
				if (m.role === "worker" && m.status === "online") recipients.add(m.name);
			}
			for (const name of teammates.keys()) recipients.add(name);
		} else if (explicitName) {
			recipients.add(explicitName);
		}

		const names = Array.from(recipients).sort();
		if (names.length === 0) {
			return compactResult(`No ${strings.memberTitle.toLowerCase()}s to shut down`, { action, all, recipients: [] });
		}

		const ts = new Date().toISOString();
		for (const name of names) {
			const requestId = randomUUID();
			await writeToMailbox(teamDir, TEAM_MAILBOX_NS, name, {
				from: cfg.leadName,
				text: JSON.stringify({
					type: "shutdown_request",
					requestId,
					from: cfg.leadName,
					timestamp: ts,
					...(reason ? { reason } : {}),
				}),
				timestamp: ts,
			});
			await setMemberStatus(teamDir, name, "online", {
				meta: {
					shutdownRequestedAt: ts,
					shutdownRequestId: requestId,
					...(reason ? { shutdownReason: reason } : {}),
				},
			});
		}

		await refreshUi();
		return compactResult(
			`Shutdown requested for ${summarizeNameList(names, style, strings.memberTitle.toLowerCase())}`,
			{ action, teamId, names, all, reason },
		);
	}

	if (action === "prune") {
		const all = params.all === true;
		const workers = cfg.members.filter((m) => m.role === "worker");
		if (workers.length === 0) {
			return compactResult(`No ${strings.memberTitle.toLowerCase()}s to prune`, { action, teamId, pruned: [] });
		}

		const tasks = await listTasks(teamDir, effectiveTlId);
		const inProgressOwners = new Set<string>();
		for (const t of tasks) {
			if (t.owner && t.status === "in_progress") inProgressOwners.add(t.owner);
		}

		const cutoffMs = 60 * 60 * 1000;
		const now = Date.now();
		const pruned: string[] = [];
		for (const m of workers) {
			if (teammates.has(m.name)) continue;
			if (inProgressOwners.has(m.name)) continue;
			if (!all) {
				const lastSeen = m.lastSeenAt ? Date.parse(m.lastSeenAt) : Number.NaN;
				if (!Number.isFinite(lastSeen)) continue;
				if (now - lastSeen < cutoffMs) continue;
			}
			await setMemberStatus(teamDir, m.name, "offline", {
				meta: { prunedAt: new Date().toISOString(), prunedBy: "teams-tool" },
			});
			pruned.push(m.name);
		}

		await refreshUi();
		if (pruned.length === 0) {
			return compactResult(
				`No stale ${strings.memberTitle.toLowerCase()}s to prune${all ? "" : " (use all=true to force)"}`,
				{ action, teamId, pruned },
			);
		}
		return compactResult(
			`Pruned ${summarizeNameList(pruned, style, `stale ${strings.memberTitle.toLowerCase()}`)}`,
			{ action, teamId, pruned },
		);
	}

	return {
		content: [{ type: "text", text: `Unsupported member action: ${String(action)}` }],
		details: { action },
	};
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerTeamsMemberTool(opts: TeamToolOpts): void {
	const { pi, getContextUsage, triggerCompaction } = opts;

	pi.registerTool({
		name: "teams_member",
		label: "Teams: Member",
		description:
			"Teammate lifecycle: spawn, shutdown, kill, prune stale members. " +
			"Supports context/workspace/model/thinking/plan options for spawn.",
		parameters: MemberParamsSchema,

		async execute(_toolCallId, params: MemberParams, signal, _onUpdate, ctx) {
			const result = await executeMemberAction(opts, params, signal, ctx);
			return appendContextWarning(result, getContextUsage(), triggerCompaction);
		},
	});
}
