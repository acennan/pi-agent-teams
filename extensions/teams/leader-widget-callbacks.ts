/**
 * Widget callback implementations extracted from `leader.ts`.
 *
 * Builds the `InteractiveWidgetDeps` callbacks that `openInteractiveWidget`
 * expects, keeping `openWidget` in `leader.ts` a slim wiring call.
 */

import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { writeToMailbox } from "./mailbox.js";
import { sanitizeName } from "./names.js";
import { TEAM_MAILBOX_NS, taskAssignmentPayload } from "./protocol.js";
import { unassignTasksForAgent, updateTask, type TeamTask } from "./task-store.js";
import { applyStatusChange, applyUnassign, applyReassign } from "./task-mutations.js";
import { setMemberStatus } from "./team-config.js";
import type { TeammateRpc } from "./teammate-rpc.js";
import { formatMemberDisplayName, getTeamsStrings, type TeamsStyle } from "./teams-style.js";
import type { ActivityTracker, TranscriptLog, TranscriptTracker } from "./activity-tracker.js";
import type { TeamConfig } from "./team-config.js";
import type { InteractiveWidgetDeps } from "./teams-panel.js";
import { fireAndForget } from "./fire-and-forget.js";
import { getTeamDir } from "./paths.js";

// ---------------------------------------------------------------------------
// Closure state the callbacks need access to
// ---------------------------------------------------------------------------

export interface WidgetCallbackContext {
	teammates: Map<string, TeammateRpc>;
	tracker: ActivityTracker;
	transcriptTracker: TranscriptTracker;
	getTasks: () => TeamTask[];
	getTeamConfig: () => TeamConfig | null;
	getStyle: () => TeamsStyle;
	isDelegateMode: () => boolean;
	getCurrentTeamId: () => string | null;
	getTaskListId: () => string | null;
	getWidgetSuppressed: () => boolean;
	setWidgetSuppressed: (v: boolean) => void;
	refreshTasks: () => Promise<void>;
	renderWidget: () => void;
	ctx: ExtensionCommandContext;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/** Build the full `InteractiveWidgetDeps` bag from the leader closure state. */
export function buildWidgetCallbacks(wctx: WidgetCallbackContext): InteractiveWidgetDeps {
	const {
		teammates,
		tracker,
		transcriptTracker,
		getTasks,
		getTeamConfig,
		getStyle,
		isDelegateMode,
		getCurrentTeamId,
		refreshTasks,
		renderWidget,
		ctx,
	} = wctx;

	const teamId = getCurrentTeamId() ?? ctx.sessionManager.getSessionId();
	const teamDir = getTeamDir(teamId);
	const taskListId = resolveTaskListId(wctx);
	const leadName = getTeamConfig()?.leadName ?? "team-lead";
	const strings = getTeamsStrings(getStyle());

	return {
		getTeammates: () => teammates,
		getTracker: () => tracker,
		getTranscript: (n: string) => transcriptTracker.get(n),
		getTasks,
		getTeamConfig,
		getStyle,
		isDelegateMode,

		async sendMessage(name: string, message: string) {
			const rpc = teammates.get(name);
			if (rpc) {
				if (rpc.status === "streaming") await rpc.followUp(message);
				else await rpc.prompt(message);
				return;
			}

			await writeToMailbox(teamDir, TEAM_MAILBOX_NS, name, {
				from: leadName,
				text: message,
				timestamp: new Date().toISOString(),
			});
		},

		abortMember(name: string) {
			const rpc = teammates.get(name);
			if (rpc) fireAndForget(rpc.abort(), ctx);
		},

		killMember(name: string) {
			const rpc = teammates.get(name);
			if (!rpc) return;

			fireAndForget(rpc.stop(), ctx);
			teammates.delete(name);

			const displayName = formatMemberDisplayName(getStyle(), name);
			fireAndForget(unassignTasksForAgent(teamDir, taskListId, name, `${displayName} ${strings.killedVerb}`), ctx);
			fireAndForget(setMemberStatus(teamDir, name, "offline", { meta: { killedAt: new Date().toISOString() } }), ctx);
			fireAndForget(refreshTasks(), ctx);
		},

		async setTaskStatus(taskIdArg: string, status: TeamTask["status"]) {
			const updated = await updateTask(teamDir, taskListId, taskIdArg, (cur) => applyStatusChange(cur, status));
			if (!updated) return false;
			await refreshTasks();
			renderWidget();
			return true;
		},

		async unassignTask(taskIdArg: string) {
			const updated = await updateTask(teamDir, taskListId, taskIdArg, (cur) => applyUnassign(cur, leadName, "leader-panel"));
			if (!updated) return false;
			await refreshTasks();
			renderWidget();
			return true;
		},

		async assignTask(taskIdArg: string, ownerName: string) {
			const owner = sanitizeName(ownerName);
			if (!owner) return false;
			const updated = await updateTask(teamDir, taskListId, taskIdArg, (cur) => applyReassign(cur, owner, leadName));
			if (!updated) return false;

			await writeToMailbox(teamDir, taskListId, owner, {
				from: leadName,
				text: JSON.stringify(taskAssignmentPayload(updated, leadName)),
				timestamp: new Date().toISOString(),
			});

			await refreshTasks();
			renderWidget();
			return true;
		},

		getActiveTeamId() {
			return getCurrentTeamId();
		},

		getSessionTeamId() {
			return ctx.sessionManager.getSessionId();
		},

		suppressWidget() {
			wctx.setWidgetSuppressed(true);
			ctx.ui.setWidget("pi-teams", undefined);
		},

		restoreWidget() {
			wctx.setWidgetSuppressed(false);
			renderWidget();
		},
	};
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveTaskListId(wctx: WidgetCallbackContext): string {
	const teamId = wctx.getCurrentTeamId() ?? wctx.ctx.sessionManager.getSessionId();
	return wctx.getTaskListId() ?? teamId;
}
