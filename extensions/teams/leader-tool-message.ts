import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { sanitizeName } from "./names.js";
import { formatMemberDisplayName } from "./teams-style.js";
import { listTasks } from "./task-store.js";
import { writeToMailbox } from "./mailbox.js";
import { TEAM_MAILBOX_NS } from "./protocol.js";
import {
	type TeamToolOpts,
	resolveTeamToolContext,
	compactResult,
	appendContextWarning,
	summarizeNameList,
} from "./leader-tool-shared.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const MessageActionSchema = StringEnum(
	["dm", "broadcast", "steer"] as const,
	{ description: "Message action.", default: "dm" },
);

const MessageParamsSchema = Type.Object({
	action: MessageActionSchema,
	name: Type.Optional(Type.String({ description: "Teammate name for dm/steer." })),
	message: Type.String({ description: "Message body." }),
});

type MessageParams = Static<typeof MessageParamsSchema>;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function executeMessageAction(
	opts: TeamToolOpts,
	params: MessageParams,
	ctx: ExtensionContext,
): Promise<AgentToolResult<unknown>> {
	const { teamId, teamDir, effectiveTlId, cfg, style, strings } = await resolveTeamToolContext(opts, ctx);
	const { teammates } = opts;
	const action = params.action;

	if (action === "dm") {
		const nameRaw = params.name?.trim();
		const message = params.message?.trim();
		if (!nameRaw || !message) {
			return {
				content: [{ type: "text", text: "dm requires name and message" }],
				details: { action, name: nameRaw },
			};
		}
		const name = sanitizeName(nameRaw);
		await writeToMailbox(teamDir, TEAM_MAILBOX_NS, name, {
			from: cfg.leadName,
			text: message,
			timestamp: new Date().toISOString(),
		});
		return {
			content: [{ type: "text", text: `DM queued for ${formatMemberDisplayName(style, name)}` }],
			details: { action, teamId, name, mailboxNamespace: TEAM_MAILBOX_NS },
		};
	}

	if (action === "broadcast") {
		const message = params.message?.trim();
		if (!message) {
			return {
				content: [{ type: "text", text: "broadcast requires message" }],
				details: { action },
			};
		}
		const recipients = new Set<string>();
		for (const m of cfg.members) {
			if (m.role === "worker") recipients.add(m.name);
		}
		for (const name of teammates.keys()) recipients.add(name);
		const allTasks = await listTasks(teamDir, effectiveTlId);
		for (const t of allTasks) {
			if (t.owner && t.owner !== cfg.leadName) recipients.add(t.owner);
		}
		const names = Array.from(recipients).sort();
		if (names.length === 0) {
			return compactResult(`No ${strings.memberTitle.toLowerCase()}s to broadcast to`, { action, recipients: [] });
		}
		const ts = new Date().toISOString();
		await Promise.all(
			names.map((name) =>
				writeToMailbox(teamDir, TEAM_MAILBOX_NS, name, {
					from: cfg.leadName,
					text: message,
					timestamp: ts,
				}),
			),
		);
		return compactResult(
			`Broadcast queued for ${summarizeNameList(names, style, strings.memberTitle.toLowerCase())}`,
			{ action, teamId, recipients: names, mailboxNamespace: TEAM_MAILBOX_NS },
		);
	}

	if (action === "steer") {
		const nameRaw = params.name?.trim();
		const message = params.message?.trim();
		if (!nameRaw || !message) {
			return {
				content: [{ type: "text", text: "steer requires name and message" }],
				details: { action, name: nameRaw },
			};
		}
		const name = sanitizeName(nameRaw);
		const rpc = teammates.get(name);
		if (!rpc) {
			return {
				content: [{ type: "text", text: `Unknown ${strings.memberTitle.toLowerCase()}: ${name}` }],
				details: { action, name },
			};
		}
		await rpc.steer(message);
		opts.renderWidget();
		return {
			content: [{ type: "text", text: `Steering sent to ${formatMemberDisplayName(style, name)}` }],
			details: { action, teamId, name },
		};
	}

	return {
		content: [{ type: "text", text: `Unsupported message action: ${String(action)}` }],
		details: { action },
	};
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerTeamsMessageTool(opts: TeamToolOpts): void {
	const { pi, getContextUsage, triggerCompaction } = opts;

	pi.registerTool({
		name: "teams_message",
		label: "Teams: Message",
		description: "Send messages to teammates: DM, broadcast, or steer (RPC redirect).",
		parameters: MessageParamsSchema,

		async execute(_toolCallId, params: MessageParams, _signal, _onUpdate, ctx) {
			const result = await executeMessageAction(opts, params, ctx);
			return appendContextWarning(result, getContextUsage(), triggerCompaction);
		},
	});
}
