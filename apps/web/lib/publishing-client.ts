import { type ApiError, isApiError, type WorkspaceScope } from "@narriflow/api-client";
import {
	type PublishingClient,
	publishingApi,
	publishingClientFor,
	publishingQueries as domainPublishingQueries,
	type publishingReads,
} from "@narriflow/api-client/publishing";
import { queryOptions } from "@tanstack/react-query";
import { authenticatedRequestFailureMessage, type BrowserRequestFailure } from "./authenticated-request-browser";
import { socialPollDelayMs } from "./social-post-status";

/**
 * The Calendar, Queue, Social accounts, Performance and Project publishing
 * screens read through the API client's publishing queries (Workspace-bound
 * transport, abort signal, typed `ApiError`), so no screen builds a URL. This
 * module adds only the cadence those screens poll at and their failure copy.
 */
export { publishingApi, publishingClientFor };
export type { PublishingClient };
export type PublishingApi = ReturnType<typeof publishingApi>;

type Reads = ReturnType<typeof publishingReads>;
type Data<Name extends keyof Reads> = Awaited<ReturnType<Reads[Name]>>;

export type CalendarData = Data<"calendar">;
export type CalendarPost = CalendarData["posts"][number];
export type QueueData = Data<"queue">;
export type ProposalInboxItem = QueueData["proposals"][number];
export type ComposerOptionsData = Data<"composerOptions">;
export type WhatWorkedData = Data<"whatWorked">;
export type PerformanceSummaryView = WhatWorkedData["summary"];
export type GuidanceView = Data<"guidance">["guidance"];
export type PerformanceGroupView = PerformanceSummaryView["dimensions"][number]["groups"][number];
export type SocialAccountView = Data<"accounts">["accounts"][number];
export type TikTokOptionsView = Data<"tiktokOptions">;
export type CalendarWindowQuery = Parameters<Reads["calendar"]>[0];

/** The calendar and the queue re-ask while posts are in flight; this is their slowest cadence otherwise. */
const QUEUE_REFRESH_MS = 30_000;

type Runtime = Parameters<typeof domainPublishingQueries.queue>[0];

export const publishingQueries = {
	accounts: domainPublishingQueries.accounts,
	/** Posts in flight tighten the cadence (`socialPollDelayMs`); a settled calendar stops polling. */
	calendar: (runtime: Runtime, scope: WorkspaceScope, query: CalendarWindowQuery) =>
		queryOptions({
			...domainPublishingQueries.calendar(runtime, scope, query),
			refetchInterval: (state) => socialPollDelayMs(state.state.data?.posts ?? [], Date.now()) ?? false,
		}),
	composerOptions: domainPublishingQueries.composerOptions,
	queue: (runtime: Runtime, scope: WorkspaceScope) =>
		queryOptions({
			...domainPublishingQueries.queue(runtime, scope),
			// Finishing, the API and assistants add proposals while the page is open.
			refetchInterval: QUEUE_REFRESH_MS,
		}),
	whatWorked: domainPublishingQueries.whatWorked,
	/** Keyed where the Workspace guidance setting invalidates it. */
	guidance: domainPublishingQueries.guidance,
};

/** The API's refusal in the shape the plan-upgrade and message helpers read. */
export function browserFailureFromApiError(error: ApiError): BrowserRequestFailure {
	return {
		ok: false,
		error: error.code,
		code: error.code,
		message: error.message,
		...(error.requestId ? { requestId: error.requestId } : {}),
		...(error.details ? { details: { ...error.details } } : {}),
		...(error.issues.length > 0 ? { issues: error.issues.map((issue) => ({ ...issue, path: [...issue.path] })) } : {}),
		...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
	};
}

/** The sentence to show for a failed call: the API's own recovery wording, else `fallback`. */
export function apiFailureMessage(error: unknown, fallback: string): string {
	if (isApiError(error)) {
		return authenticatedRequestFailureMessage(
			browserFailureFromApiError(error),
			typeof window === "undefined" ? "/home" : window.location.pathname,
			fallback,
		);
	}
	return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Whether a failed command may have changed state, so the screen should re-read
 * it: a conflict, an unreachable API, or a server fault. A plain refusal
 * (validation, permission, plan) changed nothing and needs no refetch.
 */
export function isUncertainFailure(error: unknown): boolean {
	return !isApiError(error) || error.status === 0 || error.status === 409 || error.status >= 500;
}
