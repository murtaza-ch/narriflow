import {
	type ApiError,
	type ApiTransport,
	isApiError,
	STALE_TIME,
	type WorkspaceScope,
} from "@narriflow/api-client";
import {
	createPublishingClient,
	type PublishingClient,
	publishingCommands,
	publishingKeys,
	publishingReads,
} from "@narriflow/api-client/publishing";
import { queryOptions } from "@tanstack/react-query";
import { authenticatedRequestFailureMessage, type BrowserRequestFailure } from "./authenticated-request-browser";
import { socialPollDelayMs } from "./social-post-status";

/**
 * Typed publishing reads and commands for the Calendar, Queue, Social accounts,
 * Performance and Project publishing screens. Everything goes through the
 * Workspace-bound transport (Bearer token, `X-Workspace-Id`, typed `ApiError`),
 * so no screen builds a URL.
 */

/** The client for one scope; the signal ends the request when the query or screen goes away. */
export function publishingClientFor(
	transport: ApiTransport,
	scope: WorkspaceScope,
	signal?: AbortSignal,
): PublishingClient {
	const bound = transport.scoped(scope);
	return createPublishingClient({
		baseUrl: bound.baseUrl,
		fetch: (input, init) => bound.fetch(input, signal ? { ...init, signal } : init),
	});
}

export function publishingApi(transport: ApiTransport, scope: WorkspaceScope, signal?: AbortSignal) {
	const client = publishingClientFor(transport, scope, signal);
	return { reads: publishingReads(client), commands: publishingCommands(client), client };
}
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

type Runtime = { transport: ApiTransport };

export const publishingQueries = {
	accounts: (runtime: Runtime, scope: WorkspaceScope) =>
		queryOptions({
			queryKey: publishingKeys.accounts(scope),
			queryFn: ({ signal }) => publishingApi(runtime.transport, scope, signal).reads.accounts(),
			staleTime: STALE_TIME.default,
		}),
	/** Posts in flight tighten the cadence (`socialPollDelayMs`); a settled calendar stops polling. */
	calendar: (runtime: Runtime, scope: WorkspaceScope, query: CalendarWindowQuery) =>
		queryOptions({
			queryKey: publishingKeys.calendar(scope, query),
			queryFn: ({ signal }) => publishingApi(runtime.transport, scope, signal).reads.calendar(query),
			staleTime: STALE_TIME.default,
			refetchInterval: (state) => socialPollDelayMs(state.state.data?.posts ?? [], Date.now()) ?? false,
		}),
	composerOptions: (runtime: Runtime, scope: WorkspaceScope, query: { q?: string; cursor?: string }) =>
		queryOptions({
			queryKey: publishingKeys.composerOptions(scope, query),
			queryFn: ({ signal }) => publishingApi(runtime.transport, scope, signal).reads.composerOptions(query),
			staleTime: STALE_TIME.default,
		}),
	queue: (runtime: Runtime, scope: WorkspaceScope) =>
		queryOptions({
			queryKey: publishingKeys.queue(scope),
			queryFn: ({ signal }) => publishingApi(runtime.transport, scope, signal).reads.queue(),
			staleTime: STALE_TIME.default,
			// Finishing, the API and assistants add proposals while the page is open.
			refetchInterval: QUEUE_REFRESH_MS,
		}),
	whatWorked: (runtime: Runtime, scope: WorkspaceScope) =>
		queryOptions({
			queryKey: publishingKeys.whatWorked(scope),
			queryFn: ({ signal }) => publishingApi(runtime.transport, scope, signal).reads.whatWorked(),
			staleTime: STALE_TIME.default,
		}),
	/** Keyed where the Workspace guidance setting invalidates it. */
	guidance: (runtime: Runtime, scope: WorkspaceScope) =>
		queryOptions({
			queryKey: publishingKeys.guidance(scope),
			queryFn: ({ signal }) => publishingApi(runtime.transport, scope, signal).reads.guidance(),
			staleTime: STALE_TIME.default,
		}),
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
