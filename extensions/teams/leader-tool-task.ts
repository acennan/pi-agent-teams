import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { sanitizeName } from "./names.js";
import { formatMemberDisplayName } from "./teams-style.js";
import {
	addTaskDependency,
	getTask,
	isTaskBlocked,
	listTasks,
	removeTaskDependency,
	updateTask,
} from "./task-store.js";
import { applyStatusChange, applyUnassign, applyReassign } from "./task-mutations.js";
import { writeToMailbox } from "./mailbox.js";
import { taskAssignmentPayload } from "./protocol.js";
import {
	type TeamToolOpts,
	resolveTeamToolContext,
	appendContextWarning,
} from "./leader-tool-shared.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const TaskActionSchema = StringEnum(
	["assign", "unassign", "set_status", "dep_add", "dep_rm", "dep_ls"] as const,
	{ description: "Task action.", default: "set_status" },
);

const TaskStatusSchema = StringEnum(["pending", "in_progress", "completed"] as const, {
	description: "Task status for action=set_status.",
});

const TaskParamsSchema = Type.Object({
	action: TaskActionSchema,
	taskId: Type.String({ description: "Task id." }),
	depId: Type.Optional(Type.String({ description: "Dependency task id for dep_add/dep_rm." })),
	assignee: Type.Optional(Type.String({ description: "Assignee name for action=assign." })),
	status: Type.Optional(TaskStatusSchema),
});

type TaskParams = Static<typeof TaskParamsSchema>;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function executeTaskAction(
	opts: TeamToolOpts,
	params: TaskParams,
	ctx: ExtensionContext,
): Promise<AgentToolResult<unknown>> {
	const { teamId, teamDir, effectiveTlId, cfg, style, refreshUi } = await resolveTeamToolContext(opts, ctx);
	const action = params.action;

	if (action === "set_status") {
		const taskId = params.taskId?.trim();
		const status = params.status;
		if (!taskId || !status) {
			return {
				content: [{ type: "text", text: "set_status requires taskId and status" }],
				details: { action, taskId, status },
			};
		}

		const updated = await updateTask(teamDir, effectiveTlId, taskId, (cur) => applyStatusChange(cur, status));
		if (!updated) {
			return {
				content: [{ type: "text", text: `Task not found: ${taskId}` }],
				details: { action, taskId, status },
			};
		}

		await refreshUi();
		return {
			content: [{ type: "text", text: `Updated task #${updated.id}: status=${updated.status}` }],
			details: { action, teamId, taskListId: effectiveTlId, taskId: updated.id, status: updated.status },
		};
	}

	if (action === "unassign") {
		const taskId = params.taskId?.trim();
		if (!taskId) {
			return {
				content: [{ type: "text", text: "unassign requires taskId" }],
				details: { action },
			};
		}

		const updated = await updateTask(teamDir, effectiveTlId, taskId, (cur) => applyUnassign(cur, cfg.leadName, "teams-tool"));
		if (!updated) {
			return {
				content: [{ type: "text", text: `Task not found: ${taskId}` }],
				details: { action, taskId },
			};
		}

		await refreshUi();
		return {
			content: [{ type: "text", text: `Unassigned task #${updated.id}` }],
			details: { action, teamId, taskListId: effectiveTlId, taskId: updated.id },
		};
	}

	if (action === "assign") {
		const taskId = params.taskId?.trim();
		const assignee = sanitizeName(params.assignee ?? "");
		if (!taskId || !assignee) {
			return {
				content: [{ type: "text", text: "assign requires taskId and assignee" }],
				details: { action, taskId, assignee: params.assignee },
			};
		}

		const updated = await updateTask(teamDir, effectiveTlId, taskId, (cur) => applyReassign(cur, assignee, cfg.leadName));
		if (!updated) {
			return {
				content: [{ type: "text", text: `Task not found: ${taskId}` }],
				details: { action, taskId, assignee },
			};
		}

		await writeToMailbox(teamDir, effectiveTlId, assignee, {
			from: cfg.leadName,
			text: JSON.stringify(taskAssignmentPayload(updated, cfg.leadName)),
			timestamp: new Date().toISOString(),
		});

		await refreshUi();
		return {
			content: [{ type: "text", text: `Assigned task #${updated.id} to ${formatMemberDisplayName(style, assignee)}` }],
			details: { action, teamId, taskListId: effectiveTlId, taskId: updated.id, assignee },
		};
	}

	if (action === "dep_add" || action === "dep_rm") {
		const taskId = params.taskId?.trim();
		const depId = params.depId?.trim();
		if (!taskId || !depId) {
			return {
				content: [{ type: "text", text: `${action} requires taskId and depId` }],
				details: { action, taskId, depId },
			};
		}

		const res =
			action === "dep_add"
				? await addTaskDependency(teamDir, effectiveTlId, taskId, depId)
				: await removeTaskDependency(teamDir, effectiveTlId, taskId, depId);
		if (!res.ok) {
			return {
				content: [{ type: "text", text: res.error }],
				details: { action, taskId, depId, error: res.error },
			};
		}

		await refreshUi();
		return {
			content: [
				{
					type: "text",
					text:
						action === "dep_add"
							? `Added dependency: #${taskId} depends on #${depId}`
							: `Removed dependency: #${taskId} no longer depends on #${depId}`,
				},
			],
			details: { action, teamId, taskListId: effectiveTlId, taskId, depId },
		};
	}

	if (action === "dep_ls") {
		const taskId = params.taskId?.trim();
		if (!taskId) {
			return {
				content: [{ type: "text", text: "dep_ls requires taskId" }],
				details: { action },
			};
		}

		const task = await getTask(teamDir, effectiveTlId, taskId);
		if (!task) {
			return {
				content: [{ type: "text", text: `Task not found: ${taskId}` }],
				details: { action, taskId },
			};
		}
		const blocked = task.status !== "completed" && (await isTaskBlocked(teamDir, effectiveTlId, task));
		const all = await listTasks(teamDir, effectiveTlId);
		const byId = new Map<string, (typeof all)[number]>();
		for (const t of all) byId.set(t.id, t);

		const lines: string[] = [];
		lines.push(`#${task.id} ${task.subject}`);
		lines.push(`${blocked ? "blocked" : "unblocked"} • deps:${task.blockedBy.length} • blocks:${task.blocks.length}`);
		lines.push("");
		const MAX_DEPS = 6;

		lines.push("blockedBy:");
		if (task.blockedBy.length === 0) {
			lines.push("  (none)");
		} else {
			const depsToShow = task.blockedBy.slice(0, MAX_DEPS);
			for (const id of depsToShow) {
				const dep = byId.get(id) ?? (await getTask(teamDir, effectiveTlId, id));
				lines.push(dep ? `  - #${id} ${dep.status} ${dep.subject}` : `  - #${id} (missing)`);
			}
			if (task.blockedBy.length > MAX_DEPS) {
				lines.push(`  ... +${task.blockedBy.length - MAX_DEPS} more`);
			}
		}
		lines.push("");
		lines.push("blocks:");
		if (task.blocks.length === 0) {
			lines.push("  (none)");
		} else {
			const blocksToShow = task.blocks.slice(0, MAX_DEPS);
			for (const id of blocksToShow) {
				const child = byId.get(id) ?? (await getTask(teamDir, effectiveTlId, id));
				lines.push(child ? `  - #${id} ${child.status} ${child.subject}` : `  - #${id} (missing)`);
			}
			if (task.blocks.length > MAX_DEPS) {
				lines.push(`  ... +${task.blocks.length - MAX_DEPS} more`);
			}
		}

		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { action, teamId, taskListId: effectiveTlId, taskId, blocked },
		};
	}

	return {
		content: [{ type: "text", text: `Unsupported task action: ${String(action)}` }],
		details: { action },
	};
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerTeamsTaskTool(opts: TeamToolOpts): void {
	const { pi, getContextUsage, triggerCompaction } = opts;

	pi.registerTool({
		name: "teams_task",
		label: "Teams: Task",
		description: "Manage team task list: assign, unassign, set status, add/remove/list dependencies.",
		parameters: TaskParamsSchema,

		async execute(_toolCallId, params: TaskParams, _signal, _onUpdate, ctx) {
			const result = await executeTaskAction(opts, params, ctx);
			return appendContextWarning(result, getContextUsage(), triggerCompaction);
		},
	});
}
