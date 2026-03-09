import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	getTaskListDir,
	shortTaskId,
	formatTaskLine,
	listTasks,
	getTask,
	createTask,
	updateTask,
	isTaskBlocked,
	agentHasActiveTask,
	claimTask,
	startAssignedTask,
	completeTask,
	unassignTask,
	unassignTasksForAgent,
	claimNextAvailableTask,
	addTaskDependency,
	removeTaskDependency,
	clearTasks,
} from "../task-store.js";
import type { TeamTask, TaskStatus } from "../task-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
const TEAM = "test-team";
const LIST = "test-list";

function teamDir(): string {
	return path.join(tmpDir, TEAM);
}

beforeEach(async () => {
	tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "task-store-test-"));
});

afterEach(async () => {
	await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

/** Convenience: create a task and return it. */
async function makeTask(subject: string, opts?: { description?: string; owner?: string }): Promise<TeamTask> {
	return createTask(teamDir(), LIST, {
		subject,
		description: opts?.description ?? `Description for ${subject}`,
		owner: opts?.owner,
	});
}

/** Read the raw JSON for a task from disk. */
async function readRawTask(taskId: string): Promise<Record<string, unknown> | null> {
	const dir = getTaskListDir(teamDir(), LIST);
	const file = path.join(dir, `${taskId}.json`);
	try {
		const raw = await fs.promises.readFile(file, "utf8");
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return null;
	}
}

// ===========================================================================
// getTaskListDir
// ===========================================================================

describe("getTaskListDir", () => {
	it("returns a path under teamDir/tasks/<sanitised taskListId>", () => {
		const dir = getTaskListDir("/teams/abc", "my-list");
		expect(dir).toBe(path.join("/teams/abc", "tasks", "my-list"));
	});

	it("sanitises the taskListId", () => {
		const dir = getTaskListDir("/teams/abc", "bad name!");
		// sanitizeName replaces non-alphanum/hyphen/underscore with '-'
		expect(dir).toBe(path.join("/teams/abc", "tasks", "bad-name-"));
	});
});

// ===========================================================================
// shortTaskId
// ===========================================================================

describe("shortTaskId", () => {
	it("returns the id unchanged", () => {
		expect(shortTaskId("42")).toBe("42");
		expect(shortTaskId("999")).toBe("999");
	});
});

// ===========================================================================
// formatTaskLine
// ===========================================================================

describe("formatTaskLine", () => {
	const base: TeamTask = {
		id: "1",
		subject: "Implement feature X",
		description: "",
		status: "pending",
		blocks: [],
		blockedBy: [],
		createdAt: "",
		updatedAt: "",
	};

	it("formats a basic pending task", () => {
		const line = formatTaskLine(base);
		expect(line).toContain("1");
		expect(line).toContain("pending");
		expect(line).toContain("Implement feature X");
	});

	it("includes the owner when present", () => {
		const line = formatTaskLine({ ...base, owner: "agent-1" });
		expect(line).toContain("@agent-1");
	});

	it("shows 'blocked' status when opts.blocked is true and task is pending", () => {
		const line = formatTaskLine(base, { blocked: true });
		expect(line).toContain("blocked");
		expect(line).not.toContain("pending");
	});

	it("shows blocked tag when in_progress and opts.blocked is true", () => {
		const t = { ...base, status: "in_progress" as TaskStatus };
		const line = formatTaskLine(t, { blocked: true });
		expect(line).toContain("in_progress");
		expect(line).toContain("[blocked]");
	});

	it("shows deps and blocks counts", () => {
		const t = { ...base, blockedBy: ["2", "3"], blocks: ["4"] };
		const line = formatTaskLine(t);
		expect(line).toContain("deps:2");
		expect(line).toContain("blocks:1");
	});

	it("truncates long subjects at 80 chars", () => {
		const longSubject = "A".repeat(100);
		const t = { ...base, subject: longSubject };
		const line = formatTaskLine(t);
		expect(line).toContain("A".repeat(80) + "…");
		expect(line).not.toContain("A".repeat(81));
	});

	it("does not truncate subjects at exactly 80 chars", () => {
		const subject = "B".repeat(80);
		const t = { ...base, subject };
		const line = formatTaskLine(t);
		expect(line).toContain(subject);
		expect(line).not.toContain("…");
	});
});

// ===========================================================================
// createTask
// ===========================================================================

describe("createTask", () => {
	it("creates a task with auto-incremented id starting at 1", async () => {
		const t = await makeTask("First task");
		expect(t.id).toBe("1");
		expect(t.subject).toBe("First task");
		expect(t.description).toBe("Description for First task");
		expect(t.status).toBe("pending");
		expect(t.blocks).toEqual([]);
		expect(t.blockedBy).toEqual([]);
		expect(t.createdAt).toBeTruthy();
		expect(t.updatedAt).toBeTruthy();
	});

	it("increments ids sequentially", async () => {
		const t1 = await makeTask("Task 1");
		const t2 = await makeTask("Task 2");
		const t3 = await makeTask("Task 3");
		expect(t1.id).toBe("1");
		expect(t2.id).toBe("2");
		expect(t3.id).toBe("3");
	});

	it("persists the task to disk as JSON", async () => {
		const t = await makeTask("Persisted task");
		const raw = await readRawTask(t.id);
		expect(raw).not.toBeNull();
		expect(raw!.id).toBe(t.id);
		expect(raw!.subject).toBe("Persisted task");
	});

	it("sets the owner when provided", async () => {
		const t = await makeTask("Owned task", { owner: "agent-1" });
		expect(t.owner).toBe("agent-1");
	});

	it("leaves owner undefined when not provided", async () => {
		const t = await makeTask("Unowned task");
		expect(t.owner).toBeUndefined();
	});
});

// ===========================================================================
// getTask
// ===========================================================================

describe("getTask", () => {
	it("retrieves a created task by id", async () => {
		const created = await makeTask("Retrieve me");
		const fetched = await getTask(teamDir(), LIST, created.id);
		expect(fetched).not.toBeNull();
		expect(fetched!.id).toBe(created.id);
		expect(fetched!.subject).toBe("Retrieve me");
	});

	it("returns null for a non-existent task", async () => {
		const fetched = await getTask(teamDir(), LIST, "999");
		expect(fetched).toBeNull();
	});

	it("returns null for a non-existent task list", async () => {
		const fetched = await getTask(teamDir(), "no-such-list", "1");
		expect(fetched).toBeNull();
	});
});

// ===========================================================================
// listTasks
// ===========================================================================

describe("listTasks", () => {
	it("returns an empty array when no tasks exist", async () => {
		const tasks = await listTasks(teamDir(), LIST);
		expect(tasks).toEqual([]);
	});

	it("returns all created tasks sorted numerically", async () => {
		await makeTask("A");
		await makeTask("B");
		await makeTask("C");
		const tasks = await listTasks(teamDir(), LIST);
		expect(tasks).toHaveLength(3);
		expect(tasks.map((t) => t.id)).toEqual(["1", "2", "3"]);
		expect(tasks.map((t) => t.subject)).toEqual(["A", "B", "C"]);
	});

	it("returns an empty array for a non-existent team dir", async () => {
		const tasks = await listTasks("/nonexistent/path", LIST);
		expect(tasks).toEqual([]);
	});
});

// ===========================================================================
// updateTask
// ===========================================================================

describe("updateTask", () => {
	it("applies the updater and persists changes", async () => {
		const t = await makeTask("To update");
		const updated = await updateTask(teamDir(), LIST, t.id, (cur) => ({
			...cur,
			subject: "Updated subject",
		}));
		expect(updated).not.toBeNull();
		expect(updated!.subject).toBe("Updated subject");

		// Verify persistence
		const fetched = await getTask(teamDir(), LIST, t.id);
		expect(fetched!.subject).toBe("Updated subject");
	});

	it("sets updatedAt to a new timestamp", async () => {
		const t = await makeTask("Timestamp test");
		const originalUpdatedAt = t.updatedAt;

		// Small delay to ensure timestamp differs
		await new Promise((r) => setTimeout(r, 10));

		const updated = await updateTask(teamDir(), LIST, t.id, (cur) => ({
			...cur,
			subject: "Changed",
		}));
		expect(updated!.updatedAt).not.toBe(originalUpdatedAt);
	});

	it("returns null for a non-existent task", async () => {
		const result = await updateTask(teamDir(), LIST, "999", (cur) => cur);
		expect(result).toBeNull();
	});

	it("passes the current task state to the updater", async () => {
		const t = await makeTask("Check updater input", { owner: "agent-1" });
		let receivedCurrent: TeamTask | null = null;
		await updateTask(teamDir(), LIST, t.id, (cur) => {
			receivedCurrent = { ...cur };
			return cur;
		});
		expect(receivedCurrent).not.toBeNull();
		expect(receivedCurrent!.subject).toBe("Check updater input");
		expect(receivedCurrent!.owner).toBe("agent-1");
	});
});

// ===========================================================================
// claimTask
// ===========================================================================

describe("claimTask", () => {
	it("claims an unowned pending task", async () => {
		const t = await makeTask("Claimable");
		const claimed = await claimTask(teamDir(), LIST, t.id, "agent-1");
		expect(claimed).not.toBeNull();
		expect(claimed!.owner).toBe("agent-1");
		expect(claimed!.status).toBe("in_progress");
	});

	it("does not claim an already-owned task", async () => {
		const t = await makeTask("Already owned", { owner: "agent-1" });
		const claimed = await claimTask(teamDir(), LIST, t.id, "agent-2");
		// Should return the task unchanged (owner still agent-1 via the updater logic)
		expect(claimed).not.toBeNull();
		expect(claimed!.owner).toBe("agent-1");
		expect(claimed!.status).toBe("pending"); // wasn't changed
	});

	it("does not claim a non-pending task", async () => {
		const t = await makeTask("In progress");
		// First claim it
		await claimTask(teamDir(), LIST, t.id, "agent-1");
		// Complete it
		await completeTask(teamDir(), LIST, t.id, "agent-1");

		// Try to claim the completed task
		const claimed = await claimTask(teamDir(), LIST, t.id, "agent-2");
		expect(claimed).not.toBeNull();
		expect(claimed!.status).toBe("completed");
		expect(claimed!.owner).toBe("agent-1"); // unchanged
	});

	it("returns null for a non-existent task", async () => {
		const claimed = await claimTask(teamDir(), LIST, "999", "agent-1");
		expect(claimed).toBeNull();
	});

	it("respects checkAgentBusy option", async () => {
		const t1 = await makeTask("Task 1");
		const t2 = await makeTask("Task 2");

		// Claim first task
		await claimTask(teamDir(), LIST, t1.id, "agent-1");

		// Try to claim second task with checkAgentBusy
		const claimed = await claimTask(teamDir(), LIST, t2.id, "agent-1", { checkAgentBusy: true });
		expect(claimed).toBeNull();
	});

	it("allows claiming when checkAgentBusy is false (default)", async () => {
		const t1 = await makeTask("Task 1");
		const t2 = await makeTask("Task 2");

		await claimTask(teamDir(), LIST, t1.id, "agent-1");

		// Default (no checkAgentBusy) should allow second claim
		const claimed = await claimTask(teamDir(), LIST, t2.id, "agent-1");
		expect(claimed).not.toBeNull();
		expect(claimed!.owner).toBe("agent-1");
		expect(claimed!.status).toBe("in_progress");
	});
});

// ===========================================================================
// startAssignedTask
// ===========================================================================

describe("startAssignedTask", () => {
	it("starts a pending task assigned to the agent", async () => {
		const t = await makeTask("Assigned", { owner: "agent-1" });
		const started = await startAssignedTask(teamDir(), LIST, t.id, "agent-1");
		expect(started).not.toBeNull();
		expect(started!.status).toBe("in_progress");
		expect(started!.owner).toBe("agent-1");
	});

	it("does not start a task owned by a different agent", async () => {
		const t = await makeTask("Not mine", { owner: "agent-1" });
		const started = await startAssignedTask(teamDir(), LIST, t.id, "agent-2");
		expect(started).not.toBeNull();
		expect(started!.status).toBe("pending"); // unchanged
	});

	it("does not start a task that is already in_progress", async () => {
		const t = await makeTask("Already started");
		const claimed = await claimTask(teamDir(), LIST, t.id, "agent-1");
		expect(claimed!.status).toBe("in_progress");

		const started = await startAssignedTask(teamDir(), LIST, t.id, "agent-1");
		expect(started).not.toBeNull();
		expect(started!.status).toBe("in_progress"); // unchanged by startAssigned (it requires pending)
	});

	it("returns null for a non-existent task", async () => {
		const started = await startAssignedTask(teamDir(), LIST, "999", "agent-1");
		expect(started).toBeNull();
	});
});

// ===========================================================================
// completeTask
// ===========================================================================

describe("completeTask", () => {
	it("completes a task owned by the agent", async () => {
		const t = await makeTask("To complete");
		await claimTask(teamDir(), LIST, t.id, "agent-1");
		const completed = await completeTask(teamDir(), LIST, t.id, "agent-1");
		expect(completed).not.toBeNull();
		expect(completed!.status).toBe("completed");
		expect(completed!.metadata?.completedAt).toBeTruthy();
	});

	it("stores the result in metadata", async () => {
		const t = await makeTask("With result");
		await claimTask(teamDir(), LIST, t.id, "agent-1");
		const completed = await completeTask(teamDir(), LIST, t.id, "agent-1", "All tests pass");
		expect(completed!.metadata?.result).toBe("All tests pass");
	});

	it("does not complete a task owned by a different agent", async () => {
		const t = await makeTask("Not mine");
		await claimTask(teamDir(), LIST, t.id, "agent-1");
		const completed = await completeTask(teamDir(), LIST, t.id, "agent-2");
		expect(completed).not.toBeNull();
		expect(completed!.status).toBe("in_progress"); // unchanged
		expect(completed!.owner).toBe("agent-1");
	});

	it("is idempotent on already-completed tasks", async () => {
		const t = await makeTask("Already done");
		await claimTask(teamDir(), LIST, t.id, "agent-1");
		await completeTask(teamDir(), LIST, t.id, "agent-1");
		const again = await completeTask(teamDir(), LIST, t.id, "agent-1");
		expect(again).not.toBeNull();
		expect(again!.status).toBe("completed");
	});

	it("returns null for a non-existent task", async () => {
		const result = await completeTask(teamDir(), LIST, "999", "agent-1");
		expect(result).toBeNull();
	});
});

// ===========================================================================
// unassignTask
// ===========================================================================

describe("unassignTask", () => {
	it("unassigns a task and resets to pending", async () => {
		const t = await makeTask("To unassign");
		await claimTask(teamDir(), LIST, t.id, "agent-1");
		const unassigned = await unassignTask(teamDir(), LIST, t.id, "agent-1");
		expect(unassigned).not.toBeNull();
		expect(unassigned!.owner).toBeUndefined();
		expect(unassigned!.status).toBe("pending");
	});

	it("stores unassign reason in metadata", async () => {
		const t = await makeTask("With reason");
		await claimTask(teamDir(), LIST, t.id, "agent-1");
		const unassigned = await unassignTask(teamDir(), LIST, t.id, "agent-1", "agent crashed");
		expect(unassigned!.metadata?.unassignedReason).toBe("agent crashed");
		expect(unassigned!.metadata?.unassignedAt).toBeTruthy();
	});

	it("merges extra metadata", async () => {
		const t = await makeTask("With extra");
		await claimTask(teamDir(), LIST, t.id, "agent-1");
		const unassigned = await unassignTask(teamDir(), LIST, t.id, "agent-1", "reason", { custom: "value" });
		expect(unassigned!.metadata?.custom).toBe("value");
		expect(unassigned!.metadata?.unassignedReason).toBe("reason");
	});

	it("does not unassign a task owned by a different agent", async () => {
		const t = await makeTask("Wrong agent");
		await claimTask(teamDir(), LIST, t.id, "agent-1");
		const unassigned = await unassignTask(teamDir(), LIST, t.id, "agent-2");
		expect(unassigned).not.toBeNull();
		expect(unassigned!.owner).toBe("agent-1"); // unchanged
		expect(unassigned!.status).toBe("in_progress");
	});

	it("does not unassign a completed task", async () => {
		const t = await makeTask("Completed");
		await claimTask(teamDir(), LIST, t.id, "agent-1");
		await completeTask(teamDir(), LIST, t.id, "agent-1");
		const unassigned = await unassignTask(teamDir(), LIST, t.id, "agent-1");
		expect(unassigned).not.toBeNull();
		expect(unassigned!.status).toBe("completed"); // unchanged
		expect(unassigned!.owner).toBe("agent-1");
	});

	it("returns null for a non-existent task", async () => {
		const result = await unassignTask(teamDir(), LIST, "999", "agent-1");
		expect(result).toBeNull();
	});
});

// ===========================================================================
// unassignTasksForAgent
// ===========================================================================

describe("unassignTasksForAgent", () => {
	it("unassigns all non-completed tasks for the agent", async () => {
		const t1 = await makeTask("Task 1");
		const t2 = await makeTask("Task 2");
		const t3 = await makeTask("Task 3");

		await claimTask(teamDir(), LIST, t1.id, "agent-1");
		await claimTask(teamDir(), LIST, t2.id, "agent-1");
		await claimTask(teamDir(), LIST, t3.id, "agent-1");
		// Complete t3
		await completeTask(teamDir(), LIST, t3.id, "agent-1");

		const count = await unassignTasksForAgent(teamDir(), LIST, "agent-1");
		expect(count).toBe(2); // t1 and t2 unassigned, t3 stays completed

		const tasks = await listTasks(teamDir(), LIST);
		const t1Updated = tasks.find((t) => t.id === t1.id)!;
		const t2Updated = tasks.find((t) => t.id === t2.id)!;
		const t3Updated = tasks.find((t) => t.id === t3.id)!;

		expect(t1Updated.owner).toBeUndefined();
		expect(t1Updated.status).toBe("pending");
		expect(t2Updated.owner).toBeUndefined();
		expect(t2Updated.status).toBe("pending");
		expect(t3Updated.owner).toBe("agent-1");
		expect(t3Updated.status).toBe("completed");
	});

	it("does not affect tasks owned by other agents", async () => {
		const t1 = await makeTask("Agent 1 task");
		const t2 = await makeTask("Agent 2 task");

		await claimTask(teamDir(), LIST, t1.id, "agent-1");
		await claimTask(teamDir(), LIST, t2.id, "agent-2");

		const count = await unassignTasksForAgent(teamDir(), LIST, "agent-1");
		expect(count).toBe(1);

		const fetched = await getTask(teamDir(), LIST, t2.id);
		expect(fetched!.owner).toBe("agent-2");
		expect(fetched!.status).toBe("in_progress");
	});

	it("returns 0 when the agent has no tasks", async () => {
		await makeTask("Unrelated");
		const count = await unassignTasksForAgent(teamDir(), LIST, "agent-1");
		expect(count).toBe(0);
	});

	it("stores the reason in metadata", async () => {
		const t = await makeTask("Reasoned");
		await claimTask(teamDir(), LIST, t.id, "agent-1");
		await unassignTasksForAgent(teamDir(), LIST, "agent-1", "agent left");
		const fetched = await getTask(teamDir(), LIST, t.id);
		expect(fetched!.metadata?.unassignedReason).toBe("agent left");
	});
});

// ===========================================================================
// agentHasActiveTask
// ===========================================================================

describe("agentHasActiveTask", () => {
	it("returns false when agent has no tasks", async () => {
		expect(await agentHasActiveTask(teamDir(), LIST, "agent-1")).toBe(false);
	});

	it("returns true when agent has an in_progress task", async () => {
		const t = await makeTask("Active");
		await claimTask(teamDir(), LIST, t.id, "agent-1");
		expect(await agentHasActiveTask(teamDir(), LIST, "agent-1")).toBe(true);
	});

	it("returns false when agent only has completed tasks", async () => {
		const t = await makeTask("Done");
		await claimTask(teamDir(), LIST, t.id, "agent-1");
		await completeTask(teamDir(), LIST, t.id, "agent-1");
		expect(await agentHasActiveTask(teamDir(), LIST, "agent-1")).toBe(false);
	});

	it("returns false when agent only has pending assigned tasks", async () => {
		await makeTask("Pending assigned", { owner: "agent-1" });
		expect(await agentHasActiveTask(teamDir(), LIST, "agent-1")).toBe(false);
	});
});

// ===========================================================================
// isTaskBlocked
// ===========================================================================

describe("isTaskBlocked", () => {
	it("returns false when task has no dependencies", async () => {
		const t = await makeTask("No deps");
		expect(await isTaskBlocked(teamDir(), LIST, t)).toBe(false);
	});

	it("returns true when a dependency is not completed", async () => {
		const dep = await makeTask("Dependency");
		const t = await makeTask("Dependent");

		await addTaskDependency(teamDir(), LIST, t.id, dep.id);
		const updated = await getTask(teamDir(), LIST, t.id);
		expect(await isTaskBlocked(teamDir(), LIST, updated!)).toBe(true);
	});

	it("returns false when all dependencies are completed", async () => {
		const dep = await makeTask("Dependency");
		const t = await makeTask("Dependent");

		await addTaskDependency(teamDir(), LIST, t.id, dep.id);
		await claimTask(teamDir(), LIST, dep.id, "agent-1");
		await completeTask(teamDir(), LIST, dep.id, "agent-1");

		const updated = await getTask(teamDir(), LIST, t.id);
		expect(await isTaskBlocked(teamDir(), LIST, updated!)).toBe(false);
	});

	it("returns true when dependency task does not exist", async () => {
		const t = await makeTask("Bad dep");
		// Manually set a non-existent blockedBy
		await updateTask(teamDir(), LIST, t.id, (cur) => ({
			...cur,
			blockedBy: ["999"],
		}));
		const updated = await getTask(teamDir(), LIST, t.id);
		expect(await isTaskBlocked(teamDir(), LIST, updated!)).toBe(true);
	});

	it("returns true when any one of multiple dependencies is not completed", async () => {
		const dep1 = await makeTask("Dep 1");
		const dep2 = await makeTask("Dep 2");
		const t = await makeTask("Dependent");

		await addTaskDependency(teamDir(), LIST, t.id, dep1.id);
		await addTaskDependency(teamDir(), LIST, t.id, dep2.id);

		// Complete only dep1
		await claimTask(teamDir(), LIST, dep1.id, "agent-1");
		await completeTask(teamDir(), LIST, dep1.id, "agent-1");

		const updated = await getTask(teamDir(), LIST, t.id);
		expect(await isTaskBlocked(teamDir(), LIST, updated!)).toBe(true);
	});
});

// ===========================================================================
// claimNextAvailableTask
// ===========================================================================

describe("claimNextAvailableTask", () => {
	it("claims the first pending unowned unblocked task", async () => {
		await makeTask("Task 1");
		await makeTask("Task 2");
		const claimed = await claimNextAvailableTask(teamDir(), LIST, "agent-1");
		expect(claimed).not.toBeNull();
		expect(claimed!.id).toBe("1");
		expect(claimed!.owner).toBe("agent-1");
		expect(claimed!.status).toBe("in_progress");
	});

	it("skips owned tasks", async () => {
		const t1 = await makeTask("Owned");
		await makeTask("Free");
		await claimTask(teamDir(), LIST, t1.id, "agent-1");

		const claimed = await claimNextAvailableTask(teamDir(), LIST, "agent-2");
		expect(claimed).not.toBeNull();
		expect(claimed!.id).toBe("2");
	});

	it("skips blocked tasks", async () => {
		const dep = await makeTask("Dependency");
		const blocked = await makeTask("Blocked");
		await makeTask("Free");

		await addTaskDependency(teamDir(), LIST, blocked.id, dep.id);

		const claimed = await claimNextAvailableTask(teamDir(), LIST, "agent-1");
		expect(claimed).not.toBeNull();
		// Should skip the blocked task (id=2) and claim the dependency (id=1) or the free task (id=3).
		// The dependency (id=1) is first and unblocked, so it gets claimed.
		expect(claimed!.id).toBe("1");
	});

	it("returns null when no tasks are available", async () => {
		const claimed = await claimNextAvailableTask(teamDir(), LIST, "agent-1");
		expect(claimed).toBeNull();
	});

	it("returns null when all tasks are completed", async () => {
		const t = await makeTask("Done");
		await claimTask(teamDir(), LIST, t.id, "agent-1");
		await completeTask(teamDir(), LIST, t.id, "agent-1");

		const claimed = await claimNextAvailableTask(teamDir(), LIST, "agent-2");
		expect(claimed).toBeNull();
	});

	it("respects checkAgentBusy", async () => {
		const t1 = await makeTask("Task 1");
		await makeTask("Task 2");
		await claimTask(teamDir(), LIST, t1.id, "agent-1");

		const claimed = await claimNextAvailableTask(teamDir(), LIST, "agent-1", { checkAgentBusy: true });
		expect(claimed).toBeNull();
	});

	it("skips non-pending tasks", async () => {
		const t1 = await makeTask("In progress");
		await makeTask("Available");
		await claimTask(teamDir(), LIST, t1.id, "agent-1");

		const claimed = await claimNextAvailableTask(teamDir(), LIST, "agent-2");
		expect(claimed).not.toBeNull();
		expect(claimed!.id).toBe("2");
	});
});

// ===========================================================================
// addTaskDependency
// ===========================================================================

describe("addTaskDependency", () => {
	it("adds blockedBy to the task and blocks to the dependency", async () => {
		const t1 = await makeTask("Task");
		const t2 = await makeTask("Dependency");

		const result = await addTaskDependency(teamDir(), LIST, t1.id, t2.id);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.task.blockedBy).toContain(t2.id);
		expect(result.dependency.blocks).toContain(t1.id);
	});

	it("is idempotent (no duplicates)", async () => {
		const t1 = await makeTask("Task");
		const t2 = await makeTask("Dependency");

		await addTaskDependency(teamDir(), LIST, t1.id, t2.id);
		const result = await addTaskDependency(teamDir(), LIST, t1.id, t2.id);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		// uniqStrings should prevent duplicates
		expect(result.task.blockedBy.filter((x) => x === t2.id)).toHaveLength(1);
		expect(result.dependency.blocks.filter((x) => x === t1.id)).toHaveLength(1);
	});

	it("rejects self-dependency", async () => {
		const t = await makeTask("Self");
		const result = await addTaskDependency(teamDir(), LIST, t.id, t.id);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("itself");
	});

	it("rejects missing task id", async () => {
		const result = await addTaskDependency(teamDir(), LIST, "", "1");
		expect(result.ok).toBe(false);
	});

	it("rejects missing dependency id", async () => {
		const result = await addTaskDependency(teamDir(), LIST, "1", "");
		expect(result.ok).toBe(false);
	});

	it("returns error for non-existent task", async () => {
		const dep = await makeTask("Exists");
		const result = await addTaskDependency(teamDir(), LIST, "999", dep.id);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("999");
	});

	it("returns error for non-existent dependency", async () => {
		const t = await makeTask("Exists");
		const result = await addTaskDependency(teamDir(), LIST, t.id, "999");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("999");
	});
});

// ===========================================================================
// removeTaskDependency
// ===========================================================================

describe("removeTaskDependency", () => {
	it("removes the dependency edge from both tasks", async () => {
		const t1 = await makeTask("Task");
		const t2 = await makeTask("Dependency");

		await addTaskDependency(teamDir(), LIST, t1.id, t2.id);
		const result = await removeTaskDependency(teamDir(), LIST, t1.id, t2.id);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.task.blockedBy).not.toContain(t2.id);
		expect(result.dependency.blocks).not.toContain(t1.id);
	});

	it("is safe to call when no dependency exists", async () => {
		const t1 = await makeTask("Task");
		const t2 = await makeTask("Not a dep");

		const result = await removeTaskDependency(teamDir(), LIST, t1.id, t2.id);
		expect(result.ok).toBe(true);
	});

	it("rejects self-reference", async () => {
		const t = await makeTask("Self");
		const result = await removeTaskDependency(teamDir(), LIST, t.id, t.id);
		expect(result.ok).toBe(false);
	});

	it("rejects empty ids", async () => {
		expect((await removeTaskDependency(teamDir(), LIST, "", "1")).ok).toBe(false);
		expect((await removeTaskDependency(teamDir(), LIST, "1", "")).ok).toBe(false);
	});

	it("returns error for non-existent task", async () => {
		const dep = await makeTask("Exists");
		const result = await removeTaskDependency(teamDir(), LIST, "999", dep.id);
		expect(result.ok).toBe(false);
	});

	it("returns error for non-existent dependency", async () => {
		const t = await makeTask("Exists");
		const result = await removeTaskDependency(teamDir(), LIST, t.id, "999");
		expect(result.ok).toBe(false);
	});

	it("only removes the specified dependency, not others", async () => {
		const t = await makeTask("Task");
		const d1 = await makeTask("Dep 1");
		const d2 = await makeTask("Dep 2");

		await addTaskDependency(teamDir(), LIST, t.id, d1.id);
		await addTaskDependency(teamDir(), LIST, t.id, d2.id);

		await removeTaskDependency(teamDir(), LIST, t.id, d1.id);

		const updated = await getTask(teamDir(), LIST, t.id);
		expect(updated!.blockedBy).not.toContain(d1.id);
		expect(updated!.blockedBy).toContain(d2.id);
	});
});

// ===========================================================================
// clearTasks
// ===========================================================================

describe("clearTasks", () => {
	it("deletes only completed tasks in 'completed' mode", async () => {
		const t1 = await makeTask("Pending");
		const t2 = await makeTask("To complete");
		await claimTask(teamDir(), LIST, t2.id, "agent-1");
		await completeTask(teamDir(), LIST, t2.id, "agent-1");

		const result = await clearTasks(teamDir(), LIST, "completed");
		expect(result.deletedTaskIds).toContain(t2.id);
		expect(result.skippedTaskIds).toContain(t1.id);

		// Verify t1 still exists
		expect(await getTask(teamDir(), LIST, t1.id)).not.toBeNull();
		// Verify t2 is gone
		expect(await getTask(teamDir(), LIST, t2.id)).toBeNull();
	});

	it("deletes all tasks in 'all' mode", async () => {
		const t1 = await makeTask("Pending");
		const t2 = await makeTask("In progress");
		await claimTask(teamDir(), LIST, t2.id, "agent-1");

		const result = await clearTasks(teamDir(), LIST, "all");
		expect(result.deletedTaskIds).toHaveLength(2);
		expect(result.skippedTaskIds).toHaveLength(0);

		expect(await listTasks(teamDir(), LIST)).toHaveLength(0);
	});

	it("defaults to 'completed' mode", async () => {
		const t1 = await makeTask("Pending");
		const t2 = await makeTask("To complete");
		await claimTask(teamDir(), LIST, t2.id, "agent-1");
		await completeTask(teamDir(), LIST, t2.id, "agent-1");

		const result = await clearTasks(teamDir(), LIST);
		expect(result.mode).toBe("completed");
		expect(result.deletedTaskIds).toContain(t2.id);
		expect(result.skippedTaskIds).toContain(t1.id);
	});

	it("returns empty results for a non-existent directory", async () => {
		const result = await clearTasks(teamDir(), "nonexistent");
		expect(result.deletedTaskIds).toEqual([]);
		expect(result.skippedTaskIds).toEqual([]);
		expect(result.errors).toEqual([]);
	});

	it("includes taskListId and taskListDir in the result", async () => {
		const result = await clearTasks(teamDir(), LIST);
		expect(result.taskListId).toBe(LIST);
		expect(result.taskListDir).toBe(getTaskListDir(teamDir(), LIST));
	});
});

// ===========================================================================
// End-to-end workflow
// ===========================================================================

describe("end-to-end workflow", () => {
	it("create → claim → complete → clear lifecycle", async () => {
		// Create tasks
		const t1 = await makeTask("Feature A");
		const t2 = await makeTask("Feature B");
		const t3 = await makeTask("Feature C");

		// Claim and work on tasks
		const claimed1 = await claimTask(teamDir(), LIST, t1.id, "agent-1");
		expect(claimed1!.status).toBe("in_progress");

		const claimed2 = await claimTask(teamDir(), LIST, t2.id, "agent-2");
		expect(claimed2!.status).toBe("in_progress");

		// Complete task 1
		const completed1 = await completeTask(teamDir(), LIST, t1.id, "agent-1", "Done!");
		expect(completed1!.status).toBe("completed");

		// Agent 1 picks up next available
		const next = await claimNextAvailableTask(teamDir(), LIST, "agent-1");
		expect(next).not.toBeNull();
		expect(next!.id).toBe(t3.id);

		// Complete remaining tasks
		await completeTask(teamDir(), LIST, t2.id, "agent-2");
		await completeTask(teamDir(), LIST, t3.id, "agent-1");

		// Verify all completed
		const tasks = await listTasks(teamDir(), LIST);
		expect(tasks.every((t) => t.status === "completed")).toBe(true);

		// Clear completed
		const cleared = await clearTasks(teamDir(), LIST, "completed");
		expect(cleared.deletedTaskIds).toHaveLength(3);

		// No tasks remain
		expect(await listTasks(teamDir(), LIST)).toHaveLength(0);
	});

	it("dependency chain: blocked task becomes available after dep completes", async () => {
		const t1 = await makeTask("Build foundation");
		const t2 = await makeTask("Build walls");
		const t3 = await makeTask("Build roof");

		// t2 depends on t1, t3 depends on t2
		await addTaskDependency(teamDir(), LIST, t2.id, t1.id);
		await addTaskDependency(teamDir(), LIST, t3.id, t2.id);

		// Only t1 should be claimable
		const first = await claimNextAvailableTask(teamDir(), LIST, "agent-1");
		expect(first!.id).toBe(t1.id);

		// t2 and t3 should still be blocked
		const t2Fresh = await getTask(teamDir(), LIST, t2.id);
		const t3Fresh = await getTask(teamDir(), LIST, t3.id);
		expect(await isTaskBlocked(teamDir(), LIST, t2Fresh!)).toBe(true);
		expect(await isTaskBlocked(teamDir(), LIST, t3Fresh!)).toBe(true);

		// Complete t1 → t2 unblocks
		await completeTask(teamDir(), LIST, t1.id, "agent-1");
		expect(await isTaskBlocked(teamDir(), LIST, t2Fresh!)).toBe(false);
		expect(await isTaskBlocked(teamDir(), LIST, t3Fresh!)).toBe(true);

		// Claim and complete t2 → t3 unblocks
		await claimTask(teamDir(), LIST, t2.id, "agent-1");
		await completeTask(teamDir(), LIST, t2.id, "agent-1");
		expect(await isTaskBlocked(teamDir(), LIST, t3Fresh!)).toBe(false);
	});

	it("agent crash: unassign all tasks then another agent picks them up", async () => {
		const t1 = await makeTask("Task 1");
		const t2 = await makeTask("Task 2");

		await claimTask(teamDir(), LIST, t1.id, "agent-crash");
		await claimTask(teamDir(), LIST, t2.id, "agent-crash");

		// Simulate crash
		const count = await unassignTasksForAgent(teamDir(), LIST, "agent-crash", "process exited");
		expect(count).toBe(2);

		// Another agent can now claim them
		const reclaimed = await claimNextAvailableTask(teamDir(), LIST, "agent-rescue");
		expect(reclaimed).not.toBeNull();
		expect(reclaimed!.owner).toBe("agent-rescue");
	});
});
