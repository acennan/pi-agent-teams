import type { TeamTask, TaskStatus } from "./task-store.js";

/**
 * Shared task-mutation updaters used by both the widget callbacks (leader.ts)
 * and the LLM tool handler (leader-tool-task.ts).
 *
 * Each function takes a current task snapshot and returns the updated task
 * (immutably). They are designed to be passed as the `updater` argument to
 * `updateTask()`.
 */

/** Apply a status change, stamping `completedAt` / `reopenedAt` metadata. */
export function applyStatusChange(cur: TeamTask, status: TaskStatus): TeamTask {
	if (cur.status === status) return cur;
	const metadata = { ...(cur.metadata ?? {}) };
	if (status === "completed") metadata.completedAt = new Date().toISOString();
	if (status !== "completed" && cur.status === "completed") metadata.reopenedAt = new Date().toISOString();
	return { ...cur, status, metadata };
}

/** Remove the owner from a task, resetting to pending if not completed. */
export function applyUnassign(cur: TeamTask, by: string, reason: string): TeamTask {
	if (!cur.owner) return cur;
	if (cur.status === "completed") return { ...cur, owner: undefined };
	const metadata = { ...(cur.metadata ?? {}) };
	metadata.unassignedAt = new Date().toISOString();
	metadata.unassignedBy = by;
	metadata.unassignedReason = reason;
	return { ...cur, owner: undefined, status: "pending", metadata };
}

/** Reassign a task to a new owner, resetting to pending if not completed. */
export function applyReassign(cur: TeamTask, newOwner: string, by: string): TeamTask {
	const metadata = { ...(cur.metadata ?? {}) };
	metadata.reassignedAt = new Date().toISOString();
	metadata.reassignedBy = by;
	metadata.reassignedTo = newOwner;
	if (cur.status === "completed") return { ...cur, owner: newOwner, metadata };
	return { ...cur, owner: newOwner, status: "pending", metadata };
}
