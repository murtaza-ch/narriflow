import { describe, expect, test } from "bun:test";
import type { WorkflowStageUpdatedEvent } from "@narriflow/validators";
import {
	dayKey,
	dayLabel,
	formatClock,
	formatElapsed,
	groupActivitySteps,
	groupStepsByDay,
} from "./project-activity";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const RUN_A = "22222222-2222-4222-8222-222222222222";
const RUN_B = "33333333-3333-4333-8333-333333333333";
const JOB = "44444444-4444-4444-8444-444444444444";

function run(
	workflowRunId: string,
	seq: number,
	status: WorkflowStageUpdatedEvent["status"],
	progress: number,
	emittedAt: string,
	extra: Partial<WorkflowStageUpdatedEvent> = {},
): WorkflowStageUpdatedEvent {
	return {
		event: "workflow.stage.updated",
		projectId: PROJECT_ID,
		workflowRunId,
		seq,
		stage: "clip_rendering",
		status,
		progress,
		errorCode: null,
		emittedAt,
		...extra,
	};
}

describe("groupActivitySteps", () => {
	test("folds the updates of one run and stage into one step, timed from when it started running", () => {
		const steps = groupActivitySteps([
			run(RUN_A, 1, "queued", 0, "2026-10-22T19:47:00.000Z"),
			run(RUN_A, 2, "running", 10, "2026-10-22T19:47:30.000Z"),
			run(RUN_A, 3, "running", 90, "2026-10-22T19:48:00.000Z"),
			run(RUN_A, 4, "completed", 100, "2026-10-22T19:48:12.000Z"),
		]);
		expect(steps).toHaveLength(1);
		// Queued at 19:47:00, picked up at 19:47:30: the 30s in the queue is not part of the work.
		expect(steps[0]).toMatchObject({ label: "Render", finished: true, durationSec: 42 });
		expect(steps[0]?.latest.status).toBe("completed");
		expect(steps[0]?.updates.map((update) => update.seq)).toEqual([1, 2, 3, 4]);
	});

	test("keeps separate runs, and separate stages of one run, apart, newest first", () => {
		const steps = groupActivitySteps([
			run(RUN_A, 1, "completed", 100, "2026-10-05T10:00:00.000Z"),
			run(RUN_B, 2, "queued", 0, "2026-10-22T19:47:00.000Z"),
			run(RUN_B, 3, "completed", 100, "2026-10-22T19:47:05.000Z", { stage: "stt" }),
			run(RUN_B, 4, "running", 40, "2026-10-22T19:48:00.000Z"),
		]);
		expect(steps.map((step) => [step.label, step.latest.seq])).toEqual([
			["Render", 4],
			["Transcribe", 3],
			["Render", 1],
		]);
	});

	test("a running step has no duration, and one whose queued update left the window has none either", () => {
		const [running] = groupActivitySteps([
			run(RUN_A, 1, "queued", 0, "2026-10-22T19:47:00.000Z"),
			run(RUN_A, 2, "running", 50, "2026-10-22T19:47:30.000Z"),
		]);
		expect(running).toMatchObject({ finished: false, durationSec: null });

		const [cutOff] = groupActivitySteps([
			run(RUN_A, 5, "running", 50, "2026-10-22T19:47:30.000Z"),
			run(RUN_A, 6, "completed", 100, "2026-10-22T19:48:00.000Z"),
		]);
		expect(cutOff).toMatchObject({ finished: true, queuedAt: null, durationSec: null });
	});

	test("every stage of an ingest job is one Ingest step", () => {
		const ingest = (seq: number, stage: WorkflowStageUpdatedEvent["stage"], status: WorkflowStageUpdatedEvent["status"], at: string) =>
			run(RUN_A, seq, status, 50, at, { workflowRunId: null, ingestJobId: JOB, stage });
		const steps = groupActivitySteps([
			ingest(1, "ingest_queued", "queued", "2026-10-22T19:40:00.000Z"),
			ingest(2, "ingest_downloading", "running", "2026-10-22T19:40:05.000Z"),
			ingest(3, "ingest_normalizing", "running", "2026-10-22T19:40:30.000Z"),
			ingest(4, "ingest_ready", "completed", "2026-10-22T19:40:45.000Z"),
		]);
		expect(steps).toHaveLength(1);
		expect(steps[0]).toMatchObject({ label: "Ingest", finished: true, durationSec: 40 });
	});

	test("repeats of the same update collapse to one", () => {
		const [step] = groupActivitySteps([
			run(RUN_A, 1, "running", 18, "2026-10-22T19:47:00.000Z"),
			run(RUN_A, 2, "running", 18, "2026-10-22T19:47:01.000Z"),
			run(RUN_A, 3, "running", 26, "2026-10-22T19:47:02.000Z"),
		]);
		expect(step?.updates.map((update) => update.seq)).toEqual([2, 3]);
	});
});

describe("groupStepsByDay", () => {
	test("starts a new day when the newest update falls on another calendar day in the zone", () => {
		const steps = groupActivitySteps([
			run(RUN_A, 1, "completed", 100, "2026-10-05T23:30:00.000Z"),
			run(RUN_B, 2, "completed", 100, "2026-10-22T12:00:00.000Z"),
		]);
		expect(groupStepsByDay(steps, "UTC").map((group) => group.day)).toEqual(["2026-10-22", "2026-10-05"]);
		// 23:30 UTC on the 5th is already the 6th in Karachi.
		expect(groupStepsByDay(steps, "Asia/Karachi").map((group) => group.day)).toEqual(["2026-10-22", "2026-10-06"]);
	});
});

describe("time formatting", () => {
	test("elapsed time reads in the largest two units", () => {
		expect(formatElapsed(0.2)).toBe("<1s");
		expect(formatElapsed(45)).toBe("45s");
		expect(formatElapsed(72)).toBe("1m 12s");
		expect(formatElapsed(120)).toBe("2m");
		expect(formatElapsed(7500)).toBe("2h 5m");
	});

	test("clock times and days follow the zone", () => {
		expect(formatClock("2026-10-22T19:48:05.000Z", "UTC")).toBe("19:48");
		expect(formatClock("2026-10-22T19:48:05.000Z", "UTC", true)).toBe("19:48:05");
		expect(formatClock("2026-10-22T19:48:05.000Z", "Asia/Karachi")).toBe("00:48");
		expect(dayKey("2026-10-22T19:48:05.000Z", "Asia/Karachi")).toBe("2026-10-23");
	});

	test("day labels say Today and Yesterday only once the browser's date is known", () => {
		expect(dayLabel("2026-10-22", "2026-10-22")).toBe("Today");
		expect(dayLabel("2026-10-21", "2026-10-22")).toBe("Yesterday");
		expect(dayLabel("2026-09-30", "2026-10-01")).toBe("Yesterday");
		expect(dayLabel("2026-10-05", "2026-10-22")).toBe("Oct 5");
		expect(dayLabel("2025-12-31", "2026-10-22")).toBe("Dec 31, 2025");
		expect(dayLabel("2026-10-22", null)).toBe("Oct 22");
	});
});
