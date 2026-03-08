/**
 * Teammate spawning logic extracted from `leader.ts`.
 *
 * The main export `spawnTeammateImpl` contains all the logic that was
 * previously inline in `runLeader`. It receives a `SpawnContext` that
 * provides access to the closure state it needs.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { writeToMailbox } from "./mailbox.js";
import { sanitizeName } from "./names.js";
import { TEAM_MAILBOX_NS } from "./protocol.js";
import { unassignTasksForAgent } from "./task-store.js";
import { TeammateRpc } from "./teammate-rpc.js";
import { ensureTeamConfig, setMemberStatus, upsertMember } from "./team-config.js";
import { getTeamDir } from "./paths.js";
import { ensureWorktreeCwd } from "./worktree.js";
import { ActivityTracker, TranscriptTracker } from "./activity-tracker.js";
import { resolveTeammateModelSelection, formatProviderModel } from "./model-policy.js";
import { formatMemberDisplayName, getTeamsStrings, type TeamsStyle } from "./teams-style.js";
import type { ContextMode, SpawnTeammateOptions, SpawnTeammateResult, WorkspaceMode } from "./spawn-types.js";
import { fireAndForget } from "./fire-and-forget.js";

// ---------------------------------------------------------------------------
// Built-in tool set (hoisted to module scope per audit recommendation 3.2)
// ---------------------------------------------------------------------------

const BUILT_IN_TOOL_SET = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

// ---------------------------------------------------------------------------
// Spawn context — closure state provided by `runLeader`
// ---------------------------------------------------------------------------

export interface SpawnContext {
	pi: ExtensionAPI;
	teammates: Map<string, TeammateRpc>;
	tracker: ActivityTracker;
	transcriptTracker: TranscriptTracker;
	teammateEventUnsubs: Map<string, () => void>;
	getCurrentCtx: () => ExtensionContext | null;
	getCurrentTeamId: () => string | null;
	getTaskListId: () => string | null;
	getStyle: () => TeamsStyle;
	refreshTasks: () => Promise<void>;
	renderWidget: () => void;
	getTeamsExtensionEntryPath: () => string | null;
	createSessionForTeammate: (
		ctx: ExtensionContext,
		mode: ContextMode,
		teamSessionsDir: string,
	) => Promise<{ sessionFile?: string; note?: string; warnings: string[] }>;
	getTeamSessionsDir: (teamDir: string) => string;
}

// ---------------------------------------------------------------------------
// onClose handler (extracted as a named function per audit recommendation)
// ---------------------------------------------------------------------------

function handleTeammateClose(
	spawnCtx: SpawnContext,
	name: string,
	teamDir: string,
	leaderTeamId: string,
	code: number | null,
): void {
	const { tracker, transcriptTracker, teammateEventUnsubs, getCurrentTeamId, getTaskListId, getStyle, refreshTasks, renderWidget } = spawnCtx;
	const style = getStyle();

	try {
		teammateEventUnsubs.get(name)?.();
	} catch {
		// ignore
	}
	teammateEventUnsubs.delete(name);
	tracker.reset(name);
	transcriptTracker.reset(name);

	if (getCurrentTeamId() !== leaderTeamId) return;
	const ctx = spawnCtx.getCurrentCtx();
	const effectiveTlId = getTaskListId() ?? leaderTeamId;
	fireAndForget(
		unassignTasksForAgent(
			teamDir,
			effectiveTlId,
			name,
			`${formatMemberDisplayName(style, name)} ${getTeamsStrings(style).leftVerb}`,
		).finally(() => {
			fireAndForget(refreshTasks().finally(renderWidget), ctx);
		}),
		ctx,
	);
	fireAndForget(setMemberStatus(teamDir, name, "offline", { meta: { exitCode: code ?? undefined } }), ctx);
}

// ---------------------------------------------------------------------------
// Main spawn implementation
// ---------------------------------------------------------------------------

export async function spawnTeammateImpl(
	spawnCtx: SpawnContext,
	ctx: ExtensionContext,
	opts: SpawnTeammateOptions,
): Promise<SpawnTeammateResult> {
	const {
		pi,
		teammates,
		tracker,
		transcriptTracker,
		teammateEventUnsubs,
		getCurrentTeamId,
		getTaskListId,
		getStyle,
		refreshTasks,
		renderWidget,
		getTeamsExtensionEntryPath,
		createSessionForTeammate,
		getTeamSessionsDir,
	} = spawnCtx;

	const style = getStyle();
	const warnings: string[] = [];
	const mode: ContextMode = opts.mode ?? "fresh";
	let workspaceMode: WorkspaceMode = opts.workspaceMode ?? "shared";

	const name = sanitizeName(opts.name);
	if (!name) return { ok: false, error: "Missing comrade name" };
	if (teammates.has(name)) {
		const strings = getTeamsStrings(style);
		return { ok: false, error: `${formatMemberDisplayName(style, name)} already exists (${strings.teamNoun})` };
	}

	// Spawn-time model / thinking overrides (optional).
	const thinkingLevel = opts.thinking ?? pi.getThinkingLevel();

	const modelResolution = resolveTeammateModelSelection({
		modelOverride: opts.model,
		leaderProvider: ctx.model?.provider,
		leaderModelId: ctx.model?.id,
	});
	if (!modelResolution.ok) return { ok: false, error: modelResolution.error };
	const { provider: childProvider, modelId: childModelId, warnings: modelWarnings } = modelResolution.value;
	warnings.push(...modelWarnings);

	const currentTeamId = getCurrentTeamId();
	const taskListId = getTaskListId();
	const teamId = currentTeamId ?? ctx.sessionManager.getSessionId();
	const teamDir = getTeamDir(teamId);
	const teamSessionsDir = getTeamSessionsDir(teamDir);
	const session = await createSessionForTeammate(ctx, mode, teamSessionsDir);
	const { sessionFile, note } = session;
	warnings.push(...session.warnings);

	const t = new TeammateRpc(name, sessionFile);
	teammates.set(name, t);
	// Track teammate activity for the widget/panel.
	const unsub = t.onEvent((ev) => {
		tracker.handleEvent(name, ev);
		transcriptTracker.handleEvent(name, ev);
	});
	teammateEventUnsubs.set(name, unsub);
	renderWidget();

	// On crash/close, unassign tasks.
	const leaderTeamId = teamId;
	t.onClose((code) => handleTeammateClose(spawnCtx, name, teamDir, leaderTeamId, code));

	const tools = (pi.getActiveTools() ?? []).filter((t) => BUILT_IN_TOOL_SET.has(t));
	const argsForChild: string[] = [];
	if (sessionFile) argsForChild.push("--session", sessionFile);
	argsForChild.push("--session-dir", teamSessionsDir);
	if (tools.length) argsForChild.push("--tools", tools.join(","));

	// Model + thinking for the child process.
	if (childModelId) {
		if (childProvider) argsForChild.push("--provider", childProvider);
		argsForChild.push("--model", childModelId);
	}
	argsForChild.push("--thinking", thinkingLevel);

	const teamsEntry = getTeamsExtensionEntryPath();
	if (teamsEntry) {
		argsForChild.push("--no-extensions", "-e", teamsEntry);
	}

	const strings = getTeamsStrings(style);
	const systemAppend = `You are ${strings.memberTitle.toLowerCase()} '${name}'. You collaborate with the ${strings.leaderTitle.toLowerCase()}. Prefer working from the shared task list.\n`;
	argsForChild.push("--append-system-prompt", systemAppend);

	const autoClaim = (process.env.PI_TEAMS_DEFAULT_AUTO_CLAIM ?? "1") === "1";

	let childCwd = ctx.cwd;
	if (workspaceMode === "worktree") {
		const res = await ensureWorktreeCwd({ leaderCwd: ctx.cwd, teamDir, teamId, agentName: name });
		childCwd = res.cwd;
		workspaceMode = res.mode;
		warnings.push(...res.warnings);
	}

	try {
		await t.start({
			cwd: childCwd,
			env: {
				PI_TEAMS_WORKER: "1",
				PI_TEAMS_TEAM_ID: teamId,
				PI_TEAMS_TASK_LIST_ID: taskListId ?? teamId,
				PI_TEAMS_AGENT_NAME: name,
				PI_TEAMS_LEAD_NAME: "team-lead",
				PI_TEAMS_STYLE: style,
				PI_TEAMS_AUTO_CLAIM: autoClaim ? "1" : "0",
				...(opts.planRequired ? { PI_TEAMS_PLAN_REQUIRED: "1" } : {}),
			},
			args: argsForChild,
		});
	} catch (err) {
		teammates.delete(name);
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}

	const sessionName = `pi agent teams - ${strings.memberTitle.toLowerCase()} ${name}`;

	// Leader-driven session naming (so teammates are easy to spot in /resume).
	try {
		await t.setSessionName(sessionName);
	} catch (err) {
		warnings.push(`Failed to set session name for ${name}: ${err instanceof Error ? err.message : String(err)}`);
	}

	// Also send via mailbox so non-RPC/manual workers can be named the same way.
	try {
		const ts = new Date().toISOString();
		await writeToMailbox(teamDir, TEAM_MAILBOX_NS, name, {
			from: "team-lead",
			text: JSON.stringify({ type: "set_session_name", name: sessionName, from: "team-lead", timestamp: ts }),
			timestamp: ts,
		});
	} catch (err: unknown) {
		ctx.ui.notify(`Failed to send session name to ${name} via mailbox: ${err instanceof Error ? err.message : String(err)}`, "warning");
	}

	await ensureTeamConfig(teamDir, { teamId, taskListId: taskListId ?? teamId, leadName: "team-lead", style });
	const childModel = formatProviderModel(childProvider, childModelId);
	await upsertMember(teamDir, {
		name,
		role: "worker",
		status: "online",
		cwd: childCwd,
		sessionFile,
		meta: {
			workspaceMode,
			sessionName,
			thinkingLevel,
			...(childModel ? { model: childModel } : {}),
		},
	});

	await refreshTasks();
	renderWidget();

	return { ok: true, name, mode, workspaceMode, childCwd, note, warnings };
}
