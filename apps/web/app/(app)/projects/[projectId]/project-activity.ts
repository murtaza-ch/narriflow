import type { WorkflowStageUpdatedEvent } from "@narriflow/validators";
import { projectActivityRows, workflowStageLabel } from "@/lib/project-state";

const TERMINAL_STATUSES = new Set(["completed", "partial", "failed"]);

/**
 * One occurrence of a workflow step: every update of one stage of one
 * Workflow Run (or of one Ingest Job, whose stages all read as "Ingest").
 */
export interface ActivityStep {
	key: string;
	label: string;
	/** The newest update: what the step is doing now. */
	latest: WorkflowStageUpdatedEvent;
	/** Every update still in the window, oldest first. */
	updates: WorkflowStageUpdatedEvent[];
	/** Whether the step has reached completed, partial or failed. */
	finished: boolean;
	/** The ISO time the step was queued, or null when that update is no longer in the window. */
	queuedAt: string | null;
	/** Seconds from queued to finished; null while running or when queuedAt is unknown. */
	durationSec: number | null;
}

function stepIdentity(event: WorkflowStageUpdatedEvent): string {
	return event.ingestJobId
		? `${event.ingestJobId}:ingest`
		: `${event.workflowRunId}:${event.stage}`;
}

/** Folds the event window into one step per run and stage, newest first. */
export function groupActivitySteps(events: WorkflowStageUpdatedEvent[]): ActivityStep[] {
	const updatesByStep = new Map<string, WorkflowStageUpdatedEvent[]>();
	// projectActivityRows collapses repeated identical updates; it returns newest first.
	for (const event of projectActivityRows(events).reverse()) {
		const key = stepIdentity(event);
		const updates = updatesByStep.get(key);
		if (updates) updates.push(event);
		else updatesByStep.set(key, [event]);
	}

	const steps: ActivityStep[] = [];
	for (const [key, updates] of updatesByStep) {
		const first = updates[0] as WorkflowStageUpdatedEvent;
		const latest = updates[updates.length - 1] as WorkflowStageUpdatedEvent;
		const finished = TERMINAL_STATUSES.has(latest.status);
		const queuedAt = first.status === "queued" ? first.emittedAt : null;
		// Only a step seen from its queued update has its whole history; time it
		// from when a worker picked it up, so waiting in the queue isn't counted.
		const startedAt = queuedAt
			? (updates.find((update) => (update as WorkflowStageUpdatedEvent).status === "running") as WorkflowStageUpdatedEvent | undefined)?.emittedAt ?? queuedAt
			: null;
		steps.push({
			key,
			label: latest.ingestJobId ? "Ingest" : workflowStageLabel(latest.stage),
			latest,
			updates,
			finished,
			queuedAt,
			durationSec:
				finished && startedAt
					? Math.max(0, (Date.parse(latest.emittedAt) - Date.parse(startedAt)) / 1000)
					: null,
		});
	}
	return steps.sort((left, right) => right.latest.seq - left.latest.seq);
}

/** Groups steps (already newest first) under the calendar day of their newest update. */
export function groupStepsByDay(
	steps: ActivityStep[],
	timeZone: string,
): Array<{ day: string; steps: ActivityStep[] }> {
	const days: Array<{ day: string; steps: ActivityStep[] }> = [];
	for (const step of steps) {
		const day = dayKey(step.latest.emittedAt, timeZone);
		const current = days[days.length - 1];
		if (current && current.day === day) current.steps.push(step);
		else days.push({ day, steps: [step] });
	}
	return days;
}

/** "45s", "1m 12s", "2h 5m". Under a second reads "<1s". */
export function formatElapsed(seconds: number): string {
	const total = Math.max(0, Math.round(seconds));
	if (total < 1) return "<1s";
	if (total < 60) return `${total}s`;
	const minutes = Math.floor(total / 60);
	if (total < 3600) {
		const rest = total % 60;
		return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	const restMinutes = minutes % 60;
	return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(
	timeZone: string,
	kind: "minute" | "second" | "day",
): Intl.DateTimeFormat {
	const cacheKey = `${kind}:${timeZone}`;
	let cached = formatters.get(cacheKey);
	if (!cached) {
		cached =
			kind === "day"
				? new Intl.DateTimeFormat("en-CA", {
						timeZone,
						year: "numeric",
						month: "2-digit",
						day: "2-digit",
					})
				: new Intl.DateTimeFormat("en-US", {
						timeZone,
						hour: "2-digit",
						minute: "2-digit",
						...(kind === "second" ? { second: "2-digit" } : {}),
						hourCycle: "h23",
					});
		formatters.set(cacheKey, cached);
	}
	return cached;
}

/** 24-hour clock time in the given zone: "19:48", or "19:48:05" with seconds. */
export function formatClock(iso: string, timeZone: string, withSeconds = false): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	return formatter(timeZone, withSeconds ? "second" : "minute").format(date);
}

/** The calendar day of an instant in the given zone, as "2026-10-22". */
export function dayKey(iso: string | number | Date, timeZone: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	return formatter(timeZone, "day").format(date);
}

function shiftDay(key: string, days: number): string {
	const [year, month, day] = key.split("-").map(Number) as [number, number, number];
	return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

const DAY_LABEL = new Intl.DateTimeFormat("en-US", {
	timeZone: "UTC",
	month: "short",
	day: "numeric",
});
const DAY_LABEL_WITH_YEAR = new Intl.DateTimeFormat("en-US", {
	timeZone: "UTC",
	month: "short",
	day: "numeric",
	year: "numeric",
});

/**
 * "Today", "Yesterday", "Oct 22", or "Oct 22, 2025" for another year. `today`
 * is null until the browser's clock is known, so the server and the first
 * client render agree on a plain date.
 */
export function dayLabel(key: string, today: string | null): string {
	if (today && key === today) return "Today";
	if (today && key === shiftDay(today, -1)) return "Yesterday";
	const date = new Date(`${key}T12:00:00Z`);
	if (Number.isNaN(date.getTime())) return key;
	const otherYear = today !== null && key.slice(0, 4) !== today.slice(0, 4);
	return (otherYear ? DAY_LABEL_WITH_YEAR : DAY_LABEL).format(date);
}
