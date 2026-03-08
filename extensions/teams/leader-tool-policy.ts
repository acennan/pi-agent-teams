import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { sanitizeName } from "./names.js";
import { formatMemberDisplayName } from "./teams-style.js";
import { updateTeamHooksPolicy } from "./team-config.js";
import { writeToMailbox } from "./mailbox.js";
import { TEAM_MAILBOX_NS } from "./protocol.js";
import {
	formatProviderModel,
	isDeprecatedTeammateModelId,
	resolveTeammateModelSelection,
	type TeammateModelSource,
} from "./model-policy.js";
import {
	getTeamsHookFailureAction,
	getTeamsHookFollowupOwnerPolicy,
	getTeamsHookMaxReopensPerTask,
	type TeamsHookFailureAction,
	type TeamsHookFollowupOwnerPolicy,
} from "./hooks.js";
import {
	type TeamToolOpts,
	resolveTeamToolContext,
	compactResult,
	appendContextWarning,
} from "./leader-tool-shared.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** Canonical policy action names — also referenced by `POLICY_REMAP` in `leader-teams-tool.ts`. */
export const POLICY_ACTIONS = ["hooks_get", "hooks_set", "model_get", "model_check", "plan_approve", "plan_reject"] as const;

const PolicyActionSchema = StringEnum(
	POLICY_ACTIONS,
	{ description: "Policy action.", default: "hooks_get" },
);

const HookFailureActionSchema = StringEnum(["warn", "followup", "reopen", "reopen_followup"] as const, {
	description: "Hook failure policy for hooks_set.",
});

const HookFollowupOwnerSchema = StringEnum(["member", "lead", "none"] as const, {
	description: "Follow-up owner policy for hooks_set.",
});

const PolicyParamsSchema = Type.Object({
	action: PolicyActionSchema,
	name: Type.Optional(Type.String({ description: "Teammate name for plan_approve/plan_reject." })),
	feedback: Type.Optional(Type.String({ description: "Feedback for plan_reject." })),
	reason: Type.Optional(Type.String({ description: "Alternative feedback field for plan_reject." })),
	model: Type.Optional(Type.String({ description: "Model to check for model_check." })),
	hookFailureAction: Type.Optional(HookFailureActionSchema),
	hookMaxReopensPerTask: Type.Optional(
		Type.Integer({ minimum: 0, description: "Per-task auto-reopen cap for hooks_set (0 disables auto-reopen)." }),
	),
	hookFollowupOwner: Type.Optional(HookFollowupOwnerSchema),
	hooksPolicyReset: Type.Optional(Type.Boolean({ description: "For hooks_set, clear team-level overrides before applying fields." })),
});

type PolicyParams = Static<typeof PolicyParamsSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function describeModelSource(source: TeammateModelSource): string {
	if (source === "override") return "override";
	if (source === "inherit_leader") return "leader";
	return "teammate-default";
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function executePolicyAction(
	opts: TeamToolOpts,
	params: PolicyParams,
	ctx: ExtensionContext,
): Promise<AgentToolResult<unknown>> {
	const { teamId, teamDir, cfg, style, refreshUi } = await resolveTeamToolContext(opts, ctx);
	const { pendingPlanApprovals } = opts;
	const action = params.action;

	if (action === "plan_approve") {
		const nameRaw = params.name?.trim();
		const name = sanitizeName(nameRaw ?? "");
		if (!name) {
			return compactResult("plan_approve requires name", { action, name: nameRaw });
		}
		const pending = pendingPlanApprovals.get(name);
		if (!pending) {
			return compactResult(`No pending plan approval for ${name}`, { action, name });
		}
		const ts = new Date().toISOString();
		await writeToMailbox(teamDir, TEAM_MAILBOX_NS, name, {
			from: cfg.leadName,
			text: JSON.stringify({
				type: "plan_approved",
				requestId: pending.requestId,
				from: cfg.leadName,
				timestamp: ts,
			}),
			timestamp: ts,
		});
		pendingPlanApprovals.delete(name);
		return compactResult(`Approved plan for ${formatMemberDisplayName(style, name)}`, { action, teamId, name, requestId: pending.requestId, taskId: pending.taskId });
	}

	if (action === "plan_reject") {
		const nameRaw = params.name?.trim();
		const name = sanitizeName(nameRaw ?? "");
		if (!name) {
			return compactResult("plan_reject requires name", { action, name: nameRaw });
		}
		const pending = pendingPlanApprovals.get(name);
		if (!pending) {
			return compactResult(`No pending plan approval for ${name}`, { action, name });
		}
		const feedback = params.feedback?.trim() || params.reason?.trim() || "Plan rejected";
		const ts = new Date().toISOString();
		await writeToMailbox(teamDir, TEAM_MAILBOX_NS, name, {
			from: cfg.leadName,
			text: JSON.stringify({
				type: "plan_rejected",
				requestId: pending.requestId,
				from: cfg.leadName,
				feedback,
				timestamp: ts,
			}),
			timestamp: ts,
		});
		pendingPlanApprovals.delete(name);
		return compactResult(`Rejected plan for ${formatMemberDisplayName(style, name)}: ${feedback}`, { action, teamId, name, requestId: pending.requestId, taskId: pending.taskId, feedback });
	}

	if (action === "model_get") {
		const leaderProvider = ctx.model?.provider;
		const leaderModelId = ctx.model?.id;
		const leaderModel = formatProviderModel(leaderProvider, leaderModelId);
		const leaderModelDeprecated = leaderModelId ? isDeprecatedTeammateModelId(leaderModelId) : false;
		const resolved = resolveTeammateModelSelection({
			leaderProvider,
			leaderModelId,
		});
		if (!resolved.ok) {
			return compactResult(`Model policy resolution failed: ${resolved.error}`, {
				action,
				teamId,
				error: resolved.error,
				reason: resolved.reason,
			});
		}

		const effectiveModel = formatProviderModel(resolved.value.provider, resolved.value.modelId);

		return compactResult(
			`Model policy: leader=${leaderModel ?? "(unknown)"}${leaderModelDeprecated ? " (deprecated)" : ""}, teammate default=${effectiveModel ?? "(inherit leader)"} (source=${describeModelSource(resolved.value.source)}). Override: '<provider>/<modelId>'.`,
			{
				action,
				teamId,
				deprecatedPolicy: {
					family: "claude-sonnet-4",
					allowedExceptions: ["claude-sonnet-4-5", "claude-sonnet-4.5"],
				},
				leader: {
					provider: leaderProvider,
					modelId: leaderModelId,
					model: leaderModel,
					deprecated: leaderModelDeprecated,
				},
				defaultSelection: {
					source: resolved.value.source,
					provider: resolved.value.provider,
					modelId: resolved.value.modelId,
					model: effectiveModel,
					warnings: resolved.value.warnings,
				},
			},
		);
	}

	if (action === "model_check") {
		const modelInput = params.model?.trim();
		const resolved = resolveTeammateModelSelection({
			modelOverride: modelInput,
			leaderProvider: ctx.model?.provider,
			leaderModelId: ctx.model?.id,
		});

		if (!resolved.ok) {
			return compactResult(
				`Model check rejected: ${modelInput ?? "(none)"} — ${resolved.error}`,
				{
					action,
					teamId,
					accepted: false,
					input: modelInput,
					error: resolved.error,
					reason: resolved.reason,
				},
			);
		}

		const resolvedModel = formatProviderModel(resolved.value.provider, resolved.value.modelId);
		const warnSuffix = resolved.value.warnings.length > 0 ? ` [${resolved.value.warnings.join("; ")}]` : "";
		return compactResult(
			`Model check accepted: ${modelInput ?? "(none)"} → ${resolvedModel ?? "(teammate default)"} (${describeModelSource(resolved.value.source)})${warnSuffix}`,
			{
				action,
				teamId,
				accepted: true,
				input: modelInput,
				source: resolved.value.source,
				provider: resolved.value.provider,
				modelId: resolved.value.modelId,
				model: resolvedModel,
				warnings: resolved.value.warnings,
			},
		);
	}

	if (action === "hooks_get") {
		const configuredFailureAction: TeamsHookFailureAction | undefined = cfg.hooks?.failureAction;
		const configuredFollowupOwner: TeamsHookFollowupOwnerPolicy | undefined = cfg.hooks?.followupOwner;
		const configuredMaxReopens = cfg.hooks?.maxReopensPerTask;

		const effectiveFailureAction = getTeamsHookFailureAction(process.env, configuredFailureAction);
		const effectiveFollowupOwner = getTeamsHookFollowupOwnerPolicy(process.env, configuredFollowupOwner);
		const effectiveMaxReopens = getTeamsHookMaxReopensPerTask(process.env, configuredMaxReopens);

		const overrides: string[] = [];
		if (configuredFailureAction) overrides.push("failureAction");
		if (configuredMaxReopens !== undefined) overrides.push("maxReopensPerTask");
		if (configuredFollowupOwner) overrides.push("followupOwner");
		const overrideSuffix = overrides.length > 0 ? ` (team overrides: ${overrides.join(", ")})` : " (all env defaults)";

		return compactResult(
			`Hooks: failureAction=${effectiveFailureAction}, maxReopens=${String(effectiveMaxReopens)}, followupOwner=${effectiveFollowupOwner}${overrideSuffix}`,
			{
				action,
				teamId,
				configured: {
					failureAction: configuredFailureAction,
					maxReopensPerTask: configuredMaxReopens,
					followupOwner: configuredFollowupOwner,
				},
				effective: {
					failureAction: effectiveFailureAction,
					maxReopensPerTask: effectiveMaxReopens,
					followupOwner: effectiveFollowupOwner,
				},
			},
		);
	}

	if (action === "hooks_set") {
		const reset = params.hooksPolicyReset === true;
		const nextFailureAction = params.hookFailureAction;
		const nextMaxReopens = params.hookMaxReopensPerTask;
		const nextFollowupOwner = params.hookFollowupOwner;
		if (!reset && nextFailureAction === undefined && nextMaxReopens === undefined && nextFollowupOwner === undefined) {
			return compactResult("hooks_set requires at least one policy field (or hooksPolicyReset=true)", { action, reset });
		}

		const updatedCfg = await updateTeamHooksPolicy(teamDir, (current) => {
			const next = reset ? {} : { ...current };
			if (nextFailureAction !== undefined) next.failureAction = nextFailureAction;
			if (nextMaxReopens !== undefined) next.maxReopensPerTask = nextMaxReopens;
			if (nextFollowupOwner !== undefined) next.followupOwner = nextFollowupOwner;
			if (
				next.failureAction === undefined &&
				next.maxReopensPerTask === undefined &&
				next.followupOwner === undefined
			) {
				return undefined;
			}
			return next;
		});
		if (!updatedCfg) {
			return compactResult("Failed to update hooks policy: team config missing", { action, teamId });
		}

		await refreshUi();
		const configuredFailureAction: TeamsHookFailureAction | undefined = updatedCfg.hooks?.failureAction;
		const configuredFollowupOwner: TeamsHookFollowupOwnerPolicy | undefined = updatedCfg.hooks?.followupOwner;
		const configuredMaxReopens = updatedCfg.hooks?.maxReopensPerTask;
		const effectiveFailureAction = getTeamsHookFailureAction(process.env, configuredFailureAction);
		const effectiveFollowupOwner = getTeamsHookFollowupOwnerPolicy(process.env, configuredFollowupOwner);
		const effectiveMaxReopens = getTeamsHookMaxReopensPerTask(process.env, configuredMaxReopens);

		return compactResult(
			`Updated hooks: failureAction=${effectiveFailureAction}, maxReopens=${String(effectiveMaxReopens)}, followupOwner=${effectiveFollowupOwner}`,
			{
				action,
				teamId,
				reset,
				configured: {
					failureAction: configuredFailureAction,
					maxReopensPerTask: configuredMaxReopens,
					followupOwner: configuredFollowupOwner,
				},
				effective: {
					failureAction: effectiveFailureAction,
					maxReopensPerTask: effectiveMaxReopens,
					followupOwner: effectiveFollowupOwner,
				},
			},
		);
	}

	return compactResult(`Unsupported policy action: ${String(action)}`, { action });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerTeamsPolicyTool(opts: TeamToolOpts): void {
	const { pi, getContextUsage, triggerCompaction } = opts;

	pi.registerTool({
		name: "teams_policy",
		label: "Teams: Policy",
		description: "Read/set hooks policy, model policy, and approve/reject teammate plans.",
		parameters: PolicyParamsSchema,

		async execute(_toolCallId, params: PolicyParams, _signal, _onUpdate, ctx) {
			const result = await executePolicyAction(opts, params, ctx);
			return appendContextWarning(result, getContextUsage(), triggerCompaction);
		},
	});
}
