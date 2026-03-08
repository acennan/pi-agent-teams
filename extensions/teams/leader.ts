import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { listTasks, unassignTasksForAgent, type TeamTask } from "./task-store.js";
import { TeammateRpc } from "./teammate-rpc.js";
import { ensureTeamConfig, loadTeamConfig, setMemberStatus, upsertMember, type TeamConfig } from "./team-config.js";
import { getTeamDir } from "./paths.js";
import { heartbeatTeamAttachClaim, releaseTeamAttachClaim } from "./team-attach-claim.js";
import { ActivityTracker, TranscriptTracker } from "./activity-tracker.js";
import { openInteractiveWidget } from "./teams-panel.js";
import { buildWidgetCallbacks } from "./leader-widget-callbacks.js";
import { createTeamsWidget } from "./teams-widget.js";
import { getTeamsStyleFromEnv, type TeamsStyle, getTeamsStrings } from "./teams-style.js";
import { pollLeaderInbox as pollLeaderInboxImpl } from "./leader-inbox.js";
import { runTeamsHook, type TeamsHookInvocation } from "./hooks.js";
import { processHookResult } from "./leader-hooks.js";
import { handleTeamCommand } from "./leader-team-command.js";
import { registerTeamsTool } from "./leader-teams-tool.js";
import { registerTeamsDelegateTool } from "./leader-tool-delegate.js";
import { registerTeamsTaskTool } from "./leader-tool-task.js";
import { registerTeamsMessageTool } from "./leader-tool-message.js";
import { registerTeamsMemberTool } from "./leader-tool-member.js";
import { registerTeamsPolicyTool } from "./leader-tool-policy.js";
import { buildTeamCompactionInstructions } from "./leader-compaction.js";
import { buildTeamStateSnapshot, filterStaleTeamsResults } from "./leader-context-filter.js";
import type { ContextMode, SpawnTeammateFn } from "./spawn-types.js";
import { spawnTeammateImpl, type SpawnContext } from "./leader-spawn.js";

function getTeamsExtensionEntryPath(): string | null {
	// In dev, teammates won't automatically have this extension unless it is installed or discoverable.
	// We try to load the same extension entry explicitly (and disable extension discovery to avoid duplicates).
	try {
		const dir = path.dirname(fileURLToPath(import.meta.url));
		const ts = path.join(dir, "index.ts");
		if (fs.existsSync(ts)) return ts;
		const js = path.join(dir, "index.js");
		if (fs.existsSync(js)) return js;
		return null;
	} catch {
		return null;
	}
}

/**
 * Shell-quote a value using single-quote wrapping with escaped interior quotes.
 *
 * **Display only** — used to construct CLI commands shown to the user (e.g.
 * via `/team info`), never to build commands for programmatic execution.
 * If execution use is ever needed, replace with a proper escaping library or
 * use `child_process` argument arrays (as `TeammateRpc.start` already does).
 */
function shellQuote(v: string): string {
	return "'" + v.replace(/'/g, `"'"'"'`) + "'";
}

function getTeamSessionsDir(teamDir: string): string {
	return path.join(teamDir, "sessions");
}

async function ensureDir(p: string): Promise<void> {
	await fs.promises.mkdir(p, { recursive: true });
}

async function createSessionForTeammate(
	ctx: ExtensionContext,
	mode: ContextMode,
	teamSessionsDir: string,
): Promise<{ sessionFile?: string; note?: string; warnings: string[] }> {
	const warnings: string[] = [];
	await ensureDir(teamSessionsDir);

	if (mode === "fresh") {
		const sm = SessionManager.create(ctx.cwd, teamSessionsDir);
		return { sessionFile: sm.getSessionFile(), note: "fresh", warnings };
	}

	const leafId = ctx.sessionManager.getLeafId();
	if (!leafId) {
		const sm = SessionManager.create(ctx.cwd, teamSessionsDir);
		return { sessionFile: sm.getSessionFile(), note: "branch(empty->fresh)", warnings };
	}

	const parentSessionFile = ctx.sessionManager.getSessionFile();
	if (!parentSessionFile) {
		const sm = SessionManager.create(ctx.cwd, teamSessionsDir);
		return { sessionFile: sm.getSessionFile(), note: "branch(in-memory->fresh)", warnings };
	}

	try {
		const sm = SessionManager.open(parentSessionFile, teamSessionsDir);
		const branched = sm.createBranchedSession(leafId);
		if (!branched) {
			const fallback = SessionManager.create(ctx.cwd, teamSessionsDir);
			return { sessionFile: fallback.getSessionFile(), note: "branch(failed->fresh)", warnings };
		}
		return { sessionFile: branched, note: "branch", warnings };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (/Entry .* not found/i.test(msg)) {
			warnings.push(`Branch context missing (${msg}); falling back to fresh session.`);
		} else {
			warnings.push(`Branch context error (${msg}); falling back to fresh session.`);
		}
		const fallback = SessionManager.create(ctx.cwd, teamSessionsDir);
		return { sessionFile: fallback.getSessionFile(), note: "branch(error->fresh)", warnings };
	}
}

// Message parsers are shared with the worker implementation.
export function runLeader(pi: ExtensionAPI): void {
	const teammates = new Map<string, TeammateRpc>();
	const tracker = new ActivityTracker();
	const transcriptTracker = new TranscriptTracker();
	const teammateEventUnsubs = new Map<string, () => void>();
	let currentCtx: ExtensionContext | null = null;
	let currentTeamId: string | null = null;
	let tasks: TeamTask[] = [];
	let teamConfig: TeamConfig | null = null;
	const pendingPlanApprovals = new Map<string, { requestId: string; name: string; taskId?: string }>();
	// Task list namespace. By default we keep it aligned with the current session id.
	// (Do NOT read PI_TEAMS_TASK_LIST_ID for the leader; that env var is intended for workers
	// and can easily be set globally, which makes the leader "lose" its tasks.)
	let taskListId: string | null = null;

	let refreshTimer: NodeJS.Timeout | null = null;
	let inboxTimer: NodeJS.Timeout | null = null;
	let refreshInFlight = false;
	let inboxInFlight = false;
	let compactionInFlight = false;
	let isStopping = false;
	let delegateMode = process.env.PI_TEAMS_DELEGATE_MODE === "1";
	let style: TeamsStyle = getTeamsStyleFromEnv();
	let lastAttachClaimHeartbeatMs = 0;

	const stopLoops = () => {
		if (refreshTimer) clearInterval(refreshTimer);
		if (inboxTimer) clearInterval(inboxTimer);
		refreshTimer = null;
		inboxTimer = null;
	};

	const startLoops = (ctx: ExtensionContext) => {
		stopLoops();
		refreshTimer = setInterval(async () => {
			if (isStopping || refreshInFlight) return;
			refreshInFlight = true;
			try {
				await heartbeatActiveAttachClaim(ctx);
				await refreshTasks();
				renderWidget();

				// Proactively trigger compaction at 70% so team-aware custom
				// instructions are used before pi's built-in threshold (~85%).
				const usage = ctx.getContextUsage();
				if (usage?.percent !== null && usage?.percent !== undefined && usage.percent > 70) {
					tryCompact();
				}
			} finally {
				refreshInFlight = false;
			}
		}, 1000);

		inboxTimer = setInterval(async () => {
			if (isStopping || inboxInFlight) return;
			inboxInFlight = true;
			try {
				await pollLeaderInbox();
			} finally {
				inboxInFlight = false;
			}
		}, 700);
	};

	const initSession = async (ctx: ExtensionContext) => {
		currentCtx = ctx;
		currentTeamId = ctx.sessionManager.getSessionId();
		// Keep the task list aligned with the active session. If you want a shared namespace,
		// use `/team task use <taskListId>` after switching.
		taskListId = currentTeamId;
		lastAttachClaimHeartbeatMs = 0;

		// Claude-style: a persisted team config file.
		await ensureTeamConfig(getTeamDir(currentTeamId), {
			teamId: currentTeamId,
			taskListId: taskListId,
			leadName: "team-lead",
			style,
		});

		await refreshTasks();
		renderWidget();

		startLoops(ctx);
	};

	const releaseActiveAttachClaim = async (ctx: ExtensionContext): Promise<void> => {
		if (!currentTeamId) return;
		const sessionTeamId = ctx.sessionManager.getSessionId();
		if (currentTeamId === sessionTeamId) return;
		await releaseTeamAttachClaim(getTeamDir(currentTeamId), sessionTeamId);
	};

	const heartbeatActiveAttachClaim = async (ctx: ExtensionContext): Promise<void> => {
		if (!currentTeamId) return;
		const sessionTeamId = ctx.sessionManager.getSessionId();
		if (currentTeamId === sessionTeamId) return;
		const nowMs = Date.now();
		if (nowMs - lastAttachClaimHeartbeatMs < 5_000) return;
		lastAttachClaimHeartbeatMs = nowMs;
		const result = await heartbeatTeamAttachClaim(getTeamDir(currentTeamId), sessionTeamId);
		if (result === "updated") return;

		ctx.ui.notify(
			`Attach claim for team ${currentTeamId} is no longer owned by this session; detaching to session team.`,
			"warning",
		);
		currentTeamId = sessionTeamId;
		taskListId = sessionTeamId;
		await refreshTasks();
		renderWidget();
	};

	const stopAllTeammates = async (ctx: ExtensionContext, reason: string) => {
		if (teammates.size === 0) return;
		isStopping = true;
		try {
			for (const [name, t] of teammates.entries()) {
				try {
					teammateEventUnsubs.get(name)?.();
				} catch {
					// ignore
				}
				teammateEventUnsubs.delete(name);
				tracker.reset(name);
				transcriptTracker.reset(name);

				await t.stop();
				// Claude-style: unassign non-completed tasks on exit.
				const teamId = currentTeamId ?? ctx.sessionManager.getSessionId();
				const teamDir = getTeamDir(teamId);
				const effectiveTlId = taskListId ?? teamId;
				await unassignTasksForAgent(teamDir, effectiveTlId, name, reason);
				await setMemberStatus(teamDir, name, "offline", { meta: { stoppedReason: reason } });
			}
			teammates.clear();
		} finally {
			isStopping = false;
		}
	};

	// Hooks / quality gates (serialized execution so multiple idle events don't overlap).
	let hookChain: Promise<void> = Promise.resolve();
	const seenHookEvents = new Set<string>();

	const enqueueHook = (invocation: TeamsHookInvocation) => {
		const taskId = invocation.completedTask?.id ?? "";
		const ts = invocation.timestamp ?? "";
		const key = `${invocation.teamId}:${invocation.event}:${taskId}:${ts}:${invocation.memberName ?? ""}`;
		if (seenHookEvents.has(key)) return;
		seenHookEvents.add(key);

		hookChain = hookChain
			.then(async () => {
				// Only run hooks for the currently active team session.
				if (!currentCtx) return;
				if (!currentTeamId || currentTeamId !== invocation.teamId) return;

				const res = await runTeamsHook({ invocation, cwd: currentCtx.cwd });
				if (!res.ran) return;

				await processHookResult({
					invocation,
					res,
					ctx: currentCtx,
					teamConfig,
					refreshTasks,
					renderWidget,
				});
			})
			.catch((err: unknown) => {
				if (!currentCtx) return;
				currentCtx.ui.notify(err instanceof Error ? err.message : String(err), "warning");
			});
	};

	const widgetFactory = createTeamsWidget({
		getTeammates: () => teammates,
		getTracker: () => tracker,
		getTasks: () => tasks,
		getTeamConfig: () => teamConfig,
		getStyle: () => style,
		isDelegateMode: () => delegateMode,
		getActiveTeamId: () => currentTeamId,
		getSessionTeamId: () => currentCtx?.sessionManager.getSessionId() ?? null,
	});

	const refreshTasks = async () => {
		if (!currentCtx || !currentTeamId) return;
		const teamDir = getTeamDir(currentTeamId);
		const effectiveTaskListId = taskListId ?? currentTeamId;

		const [nextTasks, cfg] = await Promise.all([listTasks(teamDir, effectiveTaskListId), loadTeamConfig(teamDir)]);
		tasks = nextTasks;
		teamConfig =
			cfg ??
			(await ensureTeamConfig(teamDir, {
				teamId: currentTeamId,
				taskListId: effectiveTaskListId,
				leadName: "team-lead",
				style,
			}));
		style = teamConfig.style ?? style;
	};

	let widgetSuppressed = false;

	const renderWidget = () => {
		if (!currentCtx || widgetSuppressed) return;
		// Component widget (more informative + styled). Re-setting it is also our "refresh" trigger.
		currentCtx.ui.setWidget("pi-teams", widgetFactory);
	};

	/** Trigger team-aware context compaction if not already in flight. */
	const tryCompact = () => {
		if (compactionInFlight || !currentCtx) return;
		compactionInFlight = true;
		currentCtx.compact({
			customInstructions: buildTeamCompactionInstructions(tasks, teammates, teamConfig, style),
			onComplete: () => {
				compactionInFlight = false;
			},
			onError: () => {
				compactionInFlight = false;
			},
		});
	};

	const spawnCtx: SpawnContext = {
		pi,
		teammates,
		tracker,
		transcriptTracker,
		teammateEventUnsubs,
		getCurrentCtx: () => currentCtx,
		getCurrentTeamId: () => currentTeamId,
		getTaskListId: () => taskListId,
		getStyle: () => style,
		refreshTasks,
		renderWidget,
		getTeamsExtensionEntryPath,
		createSessionForTeammate,
		getTeamSessionsDir,
	};

	const spawnTeammate: SpawnTeammateFn = (ctx, opts) => spawnTeammateImpl(spawnCtx, ctx, opts);

	const pollLeaderInbox = async () => {
		if (!currentCtx || !currentTeamId) return;
		const teamDir = getTeamDir(currentTeamId);
		const effectiveTaskListId = taskListId ?? currentTeamId;
		await pollLeaderInboxImpl({
			ctx: currentCtx,
			teamId: currentTeamId,
			teamDir,
			taskListId: effectiveTaskListId,
			leadName: teamConfig?.leadName ?? "team-lead",
			style,
			pendingPlanApprovals,
			enqueueHook,
		});
	};

	pi.on("tool_call", (event, _ctx) => {
		if (!delegateMode) return;
		const blockedTools = new Set(["bash", "edit", "write"]);
		if (blockedTools.has(event.toolName)) {
			return { block: true, reason: "Delegate mode is active - use comrades for implementation." };
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		await initSession(ctx);
	});

	pi.on("session_compact", (_event, _ctx) => {
		if (currentCtx) {
			currentCtx.ui.notify("Context compacted — team state preserved in summary", "info");
		}
	});

	pi.on("session_switch", async (_event, ctx) => {
		if (currentCtx) {
			await releaseActiveAttachClaim(currentCtx);
			const strings = getTeamsStrings(style);
			await stopAllTeammates(currentCtx, `The ${strings.teamNoun} is dissolved — leader moved on`);
		}
		stopLoops();

		// Reset compaction and hook dedup state for the new session.
		compactionInFlight = false;
		seenHookEvents.clear();

		await initSession(ctx);
	});

	pi.on("session_shutdown", async () => {
		if (!currentCtx) return;
		await releaseActiveAttachClaim(currentCtx);
		stopLoops();
		const strings = getTeamsStrings(style);
		await stopAllTeammates(currentCtx, `The ${strings.teamNoun} is over`);
	});

	const toolOpts = {
		pi,
		teammates,
		spawnTeammate,
		getTeamId: (ctx: Parameters<typeof spawnTeammate>[0]) => currentTeamId ?? ctx.sessionManager.getSessionId(),
		getTaskListId: () => taskListId,
		refreshTasks,
		renderWidget,
		pendingPlanApprovals,
		getContextUsage: () => currentCtx?.getContextUsage(),
		triggerCompaction: tryCompact,
		getTeamConfig: () => teamConfig,
	};
	registerTeamsDelegateTool(toolOpts);
	registerTeamsTaskTool(toolOpts);
	registerTeamsMessageTool(toolOpts);
	registerTeamsMemberTool(toolOpts);
	registerTeamsPolicyTool(toolOpts);
	registerTeamsTool(toolOpts); // legacy shim for resumed sessions

	// Summarize-on-completion: replace stale teams tool results with a compact
	// state snapshot before each LLM call. This keeps the persisted session
	// intact while dramatically reducing context tokens from past delegation
	// cycles.
	pi.on("context", (event, _ctx) => {
		if (!currentTeamId) return;

		const snapshot = buildTeamStateSnapshot(
			tasks,
			teammates,
			teamConfig,
			style,
			pendingPlanApprovals,
		);

		const filtered = filterStaleTeamsResults(event.messages, snapshot);
		if (filtered !== event.messages) {
			return { messages: filtered };
		}
	});

	const openWidget = async (ctx: ExtensionCommandContext) => {
		const deps = buildWidgetCallbacks({
			teammates,
			tracker,
			transcriptTracker,
			getTasks: () => tasks,
			getTeamConfig: () => teamConfig,
			getStyle: () => style,
			isDelegateMode: () => delegateMode,
			getCurrentTeamId: () => currentTeamId,
			getTaskListId: () => taskListId,
			getWidgetSuppressed: () => widgetSuppressed,
			setWidgetSuppressed: (v: boolean) => { widgetSuppressed = v; },
			refreshTasks,
			renderWidget,
			ctx,
		});
		await openInteractiveWidget(ctx, deps);
	};

	pi.registerCommand("tw", {
		description: "Teams: open interactive widget panel",
		handler: async (_args, ctx) => {
			currentCtx = ctx;
			if (!currentTeamId) currentTeamId = ctx.sessionManager.getSessionId();
			await openWidget(ctx);
		},
	});

	pi.registerCommand("team-widget", {
		description: "Teams: open interactive widget panel (alias for /team widget)",
		handler: async (_args, ctx) => {
			currentCtx = ctx;
			if (!currentTeamId) currentTeamId = ctx.sessionManager.getSessionId();
			await openWidget(ctx);
		},
	});

	pi.registerCommand("swarm", {
		description: "Start a team of agents to work on a task",
		handler: async (args, _ctx) => {
			const task = args.trim();
			if (!task) {
				pi.sendUserMessage("Use your /team commands to spawn a team of agents and coordinate them to complete my next request. Ask me what I'd like done.");
				return;
			}
			pi.sendUserMessage(`Use your /team commands to spawn a team of agents and coordinate them to complete this task:\n\n${task}`);
		},
	});

	pi.registerCommand("team", {
		description: "Teams: spawn comrades + coordinate via Claude-like task list",
		handler: async (args, ctx) => {
			currentCtx = ctx;
			if (!currentTeamId) currentTeamId = ctx.sessionManager.getSessionId();

			await handleTeamCommand({
				args,
				ctx,
				teammates,
				getTeamConfig: () => teamConfig,
				getTasks: () => tasks,
				refreshTasks,
				renderWidget,
				getTaskListId: () => taskListId,
				setTaskListId: (id) => {
					taskListId = id;
				},
				getActiveTeamId: () => currentTeamId ?? ctx.sessionManager.getSessionId(),
				setActiveTeamId: (teamId) => {
					currentTeamId = teamId;
				},
				pendingPlanApprovals,
				getDelegateMode: () => delegateMode,
				setDelegateMode: (next) => {
					delegateMode = next;
				},
				getStyle: () => style,
				setStyle: (next) => {
					style = next;
				},
				spawnTeammate,
				openWidget,
				getTeamsExtensionEntryPath,
				shellQuote,
				getCurrentCtx: () => currentCtx,
				stopAllTeammates,
			});
		},
	});
}
