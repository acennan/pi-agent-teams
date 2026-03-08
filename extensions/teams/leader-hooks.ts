/**
 * Hook/quality-gate processing helpers extracted from `leader.ts`.
 *
 * The main entry point is `processHookResult`, which orchestrates:
 * 1. Log persistence
 * 2. Failure summary construction
 * 3. Quality-gate metadata stamping on tasks
 * 4. Task reopen logic (with counters and suppression)
 * 5. Follow-up task creation + mailbox delivery
 * 6. Remediation message delivery
 * 7. UI notifications
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { writeToMailbox } from "./mailbox.js";
import { sanitizeName } from "./names.js";
import { taskAssignmentPayload } from "./protocol.js";
import { createTask, updateTask, type TeamTask } from "./task-store.js";
import { loadTeamConfig, type TeamConfig } from "./team-config.js";
import {
	getHookBaseName,
	getTeamsHookFailureAction,
	getTeamsHookFollowupOwnerPolicy,
	getTeamsHookMaxReopensPerTask,
	resolveTeamsHookFollowupOwner,
	shouldCreateHookFollowupTask,
	shouldReopenTaskOnHookFailure,
	type TeamsHookInvocation,
	type TeamsHookRunResult,
} from "./hooks.js";

// ---------------------------------------------------------------------------
// Failure summary
// ---------------------------------------------------------------------------

/** Build a compact, human-readable summary of why a hook failed. */
export function buildFailureSummary(res: TeamsHookRunResult): string {
	const stderrFirstLine = res.stderr
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	const parts: string[] = [];
	if (res.error) parts.push(res.error);
	if (res.timedOut) parts.push(`timeout after ${res.durationMs}ms`);
	if (!res.timedOut && res.exitCode !== null && res.exitCode !== 0) parts.push(`exit code ${res.exitCode}`);
	if (stderrFirstLine) parts.push(stderrFirstLine.length > 180 ? `${stderrFirstLine.slice(0, 179)}…` : stderrFirstLine);
	return parts.join(" • ") || "hook failed";
}

// ---------------------------------------------------------------------------
// Hook log persistence
// ---------------------------------------------------------------------------

/** Persist a hook invocation + result to the team's hook-logs directory. */
export async function persistHookLog(invocation: TeamsHookInvocation, res: TeamsHookRunResult): Promise<void> {
	try {
		const logsDir = path.join(invocation.teamDir, "hook-logs");
		await fs.promises.mkdir(logsDir, { recursive: true });
		const name = `${new Date().toISOString().replace(/[:.]/g, "-")}_${invocation.event}.json`;
		await fs.promises.writeFile(
			path.join(logsDir, name),
			JSON.stringify({ invocation, result: res }, null, 2) + "\n",
			"utf8",
		);
	} catch {
		// ignore logging errors
	}
}

// ---------------------------------------------------------------------------
// Quality-gate metadata
// ---------------------------------------------------------------------------

export interface QualityGateResult {
	taskReopened: boolean;
	taskReopenSuppressed: boolean;
}

/** Stamp quality-gate pass/fail metadata on a task, optionally reopening it. */
export async function applyQualityGateMetadata(
	teamDir: string,
	taskListId: string,
	taskId: string,
	hookName: string,
	ok: boolean,
	failureSummary: string,
	durationMs: number,
	shouldReopen: boolean,
	maxReopens: number,
): Promise<QualityGateResult> {
	let taskReopened = false;
	let taskReopenSuppressed = false;
	const nowIso = new Date().toISOString();

	await updateTask(teamDir, taskListId, taskId, (cur) => {
		const metadata = { ...(cur.metadata ?? {}) };
		const prevFailureCountRaw = metadata["qualityGateFailureCount"];
		const prevFailureCount =
			typeof prevFailureCountRaw === "number" && Number.isFinite(prevFailureCountRaw) ? prevFailureCountRaw : 0;

		metadata["qualityGateHook"] = hookName;
		metadata["qualityGateAt"] = nowIso;

		if (ok) {
			metadata["qualityGateStatus"] = "passed";
			metadata["qualityGateSummary"] = `passed in ${durationMs}ms`;
			metadata["qualityGateLastSuccessAt"] = nowIso;
			metadata["qualityGateReopenSuppressed"] = false;
			return { ...cur, metadata };
		}

		metadata["qualityGateStatus"] = "failed";
		metadata["qualityGateSummary"] = failureSummary;
		metadata["qualityGateFailureCount"] = prevFailureCount + 1;
		metadata["qualityGateLastFailureAt"] = nowIso;

		if (shouldReopen && cur.status === "completed") {
			const prevReopenCountRaw = metadata["reopenedByQualityGateCount"];
			const prevReopenCount =
				typeof prevReopenCountRaw === "number" && Number.isFinite(prevReopenCountRaw) ? prevReopenCountRaw : 0;
			const canAutoReopen = maxReopens > 0 && prevReopenCount < maxReopens;
			if (canAutoReopen) {
				taskReopened = true;
				metadata["reopenedByQualityGateAt"] = nowIso;
				metadata["reopenedByQualityGateHook"] = hookName;
				metadata["reopenedByQualityGateCount"] = prevReopenCount + 1;
				metadata["qualityGateReopenSuppressed"] = false;
				return { ...cur, status: "pending", metadata };
			}
			taskReopenSuppressed = true;
			metadata["qualityGateReopenSuppressed"] = true;
			metadata["qualityGateReopenSuppressedReason"] =
				maxReopens <= 0
					? "PI_TEAMS_HOOKS_MAX_REOPENS_PER_TASK=0"
					: `reopen limit reached (${maxReopens})`;
		}
		return { ...cur, metadata };
	});

	return { taskReopened, taskReopenSuppressed };
}

// ---------------------------------------------------------------------------
// Follow-up task creation
// ---------------------------------------------------------------------------

/** Create a follow-up task for a quality-gate failure and notify the assignee via mailbox. */
export async function createFollowupTask(
	teamDir: string,
	taskListId: string,
	task: TeamTask,
	hookName: string,
	failureAction: string,
	failureSummary: string,
	res: TeamsHookRunResult,
	followupOwner: string | undefined,
	leadName: string,
): Promise<TeamTask> {
	const subject = `Quality gate failed: ${hookName} (task #${task.id})`;
	const descParts: string[] = [];
	descParts.push(`Hook: ${hookName}`);
	descParts.push(`Policy: ${failureAction}`);
	descParts.push(`Failure: ${failureSummary}`);
	if (res.command?.length) descParts.push(`Command: ${res.command.join(" ")}`);
	descParts.push("");
	if (task.subject) descParts.push(`Original task subject: ${task.subject}`);
	descParts.push("");
	if (res.stdout.trim()) {
		descParts.push("STDOUT:");
		descParts.push(res.stdout.trim());
		descParts.push("");
	}
	if (res.stderr.trim()) {
		descParts.push("STDERR:");
		descParts.push(res.stderr.trim());
		descParts.push("");
	}

	const followupTask = await createTask(teamDir, taskListId, {
		subject,
		description: descParts.join("\n"),
		owner: followupOwner,
	});

	if (followupOwner) {
		await writeToMailbox(teamDir, taskListId, followupOwner, {
			from: leadName,
			text: JSON.stringify(taskAssignmentPayload(followupTask, leadName)),
			timestamp: new Date().toISOString(),
		});
	}

	return followupTask;
}

// ---------------------------------------------------------------------------
// Remediation message
// ---------------------------------------------------------------------------

/** Send a remediation message to the teammate that owns the failed task. */
export async function sendRemediationMessage(
	teamDir: string,
	taskListId: string,
	target: string,
	hookName: string,
	failureSummary: string,
	taskId: string | undefined,
	taskReopened: boolean,
	followupTaskId: string | undefined,
	leadName: string,
): Promise<void> {
	const nextSteps: string[] = [];
	if (taskId && taskReopened) nextSteps.push(`Task #${taskId} was reopened to pending.`);
	if (followupTaskId) nextSteps.push(`Follow-up task #${followupTaskId} was created.`);
	if (nextSteps.length === 0 && taskId) nextSteps.push(`Task #${taskId} still requires remediation.`);

	const messageLines = [
		`Quality gate failed (${hookName}${taskId ? ` / task #${taskId}` : ""}): ${failureSummary}`,
		...nextSteps,
		"Please remediate automatically and continue without waiting for user intervention.",
	];

	await writeToMailbox(teamDir, taskListId, target, {
		from: leadName,
		text: messageLines.join("\n"),
		timestamp: new Date().toISOString(),
	});
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export interface ProcessHookOpts {
	invocation: TeamsHookInvocation;
	res: TeamsHookRunResult;
	ctx: ExtensionContext;
	teamConfig: TeamConfig | null;
	refreshTasks: () => Promise<void>;
	renderWidget: () => void;
}

/**
 * Process a hook result: persist log, stamp quality-gate metadata, create
 * follow-ups, send remediation messages, and fire UI notifications.
 *
 * Called from `enqueueHook` in `leader.ts` after `runTeamsHook` returns.
 */
export async function processHookResult(opts: ProcessHookOpts): Promise<void> {
	const { invocation, res, ctx, teamConfig, refreshTasks, renderWidget } = opts;

	// Persist a log for debugging.
	await persistHookLog(invocation, res);

	const ok = res.exitCode === 0 && !res.timedOut && !res.error;
	const hookName = getHookBaseName(invocation.event);
	const cfgForInvocation = await loadTeamConfig(invocation.teamDir);
	const hookPolicy = cfgForInvocation?.hooks;
	const failureAction = getTeamsHookFailureAction(process.env, hookPolicy?.failureAction);
	const shouldFollowup = shouldCreateHookFollowupTask(failureAction);
	const shouldReopen = shouldReopenTaskOnHookFailure(failureAction);
	const maxReopens = getTeamsHookMaxReopensPerTask(process.env, hookPolicy?.maxReopensPerTask);
	const followupOwnerPolicy = getTeamsHookFollowupOwnerPolicy(process.env, hookPolicy?.followupOwner);
	const task = invocation.completedTask;
	const leadName = cfgForInvocation?.leadName ?? teamConfig?.leadName ?? "team-lead";
	const failureSummary = buildFailureSummary(res);

	// Idle hooks are intentionally quiet unless they fail.
	if (invocation.event === "idle") {
		if (!ok) {
			ctx.ui.notify(`Hook ${hookName} failed: ${failureSummary}`, "warning");
		}
		return;
	}

	// Quality-gate metadata stamping + potential reopen.
	let taskReopened = false;
	let taskReopenSuppressed = false;
	if (task?.id) {
		const qg = await applyQualityGateMetadata(
			invocation.teamDir,
			invocation.taskListId,
			task.id,
			hookName,
			ok,
			failureSummary,
			res.durationMs,
			shouldReopen,
			maxReopens,
		);
		taskReopened = qg.taskReopened;
		taskReopenSuppressed = qg.taskReopenSuppressed;
		await refreshTasks();
		renderWidget();
	}

	// Success notification.
	if (ok) {
		const taskRef = task?.id ? ` for task #${task.id}` : "";
		ctx.ui.notify(`Hook ${hookName} passed${taskRef} (${res.durationMs}ms)`, "info");
		return;
	}

	// Failure notifications.
	const failedTaskRef = task?.id ? ` for task #${task.id}` : "";
	ctx.ui.notify(`Hook ${hookName} failed${failedTaskRef}: ${failureSummary}`, "warning");
	if (taskReopened && task?.id) {
		ctx.ui.notify(`Reopened task #${task.id} due to quality-gate failure`, "warning");
	} else if (taskReopenSuppressed && shouldReopen && task?.id) {
		ctx.ui.notify(`Auto-reopen suppressed for task #${task.id} (limit ${maxReopens})`, "warning");
	}

	// Follow-up task creation.
	let followupTask: TeamTask | null = null;
	if (shouldFollowup && task?.id) {
		const followupOwner = resolveTeamsHookFollowupOwner({
			policy: followupOwnerPolicy,
			memberName: invocation.memberName,
			leadName,
		});
		followupTask = await createFollowupTask(
			invocation.teamDir,
			invocation.taskListId,
			task,
			hookName,
			failureAction,
			failureSummary,
			res,
			followupOwner,
			leadName,
		);
		await refreshTasks();
		renderWidget();
	}

	// Remediation message.
	const remediationTarget = sanitizeName(task?.owner ?? invocation.memberName ?? "");
	if (remediationTarget) {
		await sendRemediationMessage(
			invocation.teamDir,
			invocation.taskListId,
			remediationTarget,
			hookName,
			failureSummary,
			task?.id,
			taskReopened,
			followupTask?.id,
			leadName,
		);
	}
}
