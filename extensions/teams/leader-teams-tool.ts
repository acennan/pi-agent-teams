/**
 * Backward-compatibility shim for the legacy "teams" tool.
 *
 * New sessions should use the split tools: teams_delegate, teams_task,
 * teams_message, teams_member, teams_policy. This shim exists so that
 * resumed sessions with old "teams" tool calls in history can still
 * function. It parses the old `action` field and routes to the
 * appropriate handler.
 *
 * The schema is intentionally minimal (just `action` + catch-all fields)
 * so it adds very few tokens to the LLM context.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import { Type, type Static } from "@sinclair/typebox";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { type TeamToolOpts, appendContextWarning } from "./leader-tool-shared.js";
import { executeDelegateAction } from "./leader-tool-delegate.js";
import { executeTaskAction } from "./leader-tool-task.js";
import { executeMessageAction } from "./leader-tool-message.js";
import { executeMemberAction } from "./leader-tool-member.js";
import { executePolicyAction } from "./leader-tool-policy.js";

// ---------------------------------------------------------------------------
// Legacy schema — kept minimal to reduce token overhead.
// Only the `action` field and a generic catch-all for the rest.
// ---------------------------------------------------------------------------

const LegacyActionSchema = StringEnum(
	[
		"delegate",
		"task_assign",
		"task_unassign",
		"task_set_status",
		"task_dep_add",
		"task_dep_rm",
		"task_dep_ls",
		"message_dm",
		"message_broadcast",
		"message_steer",
		"member_spawn",
		"member_shutdown",
		"member_kill",
		"member_prune",
		"plan_approve",
		"plan_reject",
		"hooks_policy_get",
		"hooks_policy_set",
		"model_policy_get",
		"model_policy_check",
	] as const,
	{ description: "Legacy action. Prefer the split tools: teams_delegate, teams_task, teams_message, teams_member, teams_policy." },
);

const LegacyParamsSchema = Type.Object({
	action: Type.Optional(LegacyActionSchema),
	// Catch-all fields so old tool calls still parse. Using Type.Unknown
	// allows any value without inflating the schema with per-field descriptions.
	tasks: Type.Optional(Type.Unknown()),
	taskId: Type.Optional(Type.String()),
	depId: Type.Optional(Type.String()),
	assignee: Type.Optional(Type.String()),
	status: Type.Optional(Type.String()),
	name: Type.Optional(Type.String()),
	message: Type.Optional(Type.String()),
	reason: Type.Optional(Type.String()),
	feedback: Type.Optional(Type.String()),
	all: Type.Optional(Type.Boolean()),
	planRequired: Type.Optional(Type.Boolean()),
	teammates: Type.Optional(Type.Unknown()),
	maxTeammates: Type.Optional(Type.Integer()),
	contextMode: Type.Optional(Type.String()),
	workspaceMode: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	thinking: Type.Optional(Type.String()),
	hookFailureAction: Type.Optional(Type.String()),
	hookMaxReopensPerTask: Type.Optional(Type.Integer()),
	hookFollowupOwner: Type.Optional(Type.String()),
	hooksPolicyReset: Type.Optional(Type.Boolean()),
});

type LegacyParams = Static<typeof LegacyParamsSchema>;

// ---------------------------------------------------------------------------
// Action routing map: old action → { strip prefix, target handler }
// ---------------------------------------------------------------------------

const TASK_PREFIX = "task_";
const MESSAGE_PREFIX = "message_";
const MEMBER_PREFIX = "member_";
const POLICY_REMAP: Record<string, string> = {
	hooks_policy_get: "hooks_get",
	hooks_policy_set: "hooks_set",
	model_policy_get: "model_get",
	model_policy_check: "model_check",
	plan_approve: "plan_approve",
	plan_reject: "plan_reject",
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerTeamsTool(opts: TeamToolOpts): void {
	const { pi, getContextUsage, triggerCompaction } = opts;

	pi.registerTool({
		name: "teams",
		label: "Teams (legacy)",
		description:
			"Deprecated — prefer teams_delegate, teams_task, teams_message, teams_member, teams_policy. " +
			"This shim routes old action names to the new tools.",
		parameters: LegacyParamsSchema,

		async execute(_toolCallId, params: LegacyParams, signal, _onUpdate, ctx) {
			const action = (params.action ?? "delegate") as string;
			let result: AgentToolResult<unknown>;

			if (action === "delegate") {
				// biome-ignore lint: legacy shim intentionally passes untyped params
				result = await executeDelegateAction(opts, params as any, signal, ctx);
			} else if (action.startsWith(TASK_PREFIX)) {
				const taskAction = action.slice(TASK_PREFIX.length);
				result = await executeTaskAction(opts, { ...params, action: taskAction } as any, ctx);
			} else if (action.startsWith(MESSAGE_PREFIX)) {
				const msgAction = action.slice(MESSAGE_PREFIX.length);
				result = await executeMessageAction(opts, { ...params, action: msgAction } as any, ctx);
			} else if (action.startsWith(MEMBER_PREFIX)) {
				const memberAction = action.slice(MEMBER_PREFIX.length);
				result = await executeMemberAction(opts, { ...params, action: memberAction } as any, signal, ctx);
			} else if (action in POLICY_REMAP) {
				const policyAction = POLICY_REMAP[action]!;
				result = await executePolicyAction(opts, { ...params, action: policyAction } as any, ctx);
			} else {
				result = {
					content: [{ type: "text", text: `Unknown legacy action: ${action}. Use the split tools instead.` }],
					details: { action },
				};
			}

			return appendContextWarning(result, getContextUsage(), triggerCompaction);
		},
	});
}
