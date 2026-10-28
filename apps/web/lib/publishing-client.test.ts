import { describe, expect, test } from "bun:test";
import { ApiError } from "@narriflow/api-client";
import { publishingKeys } from "@narriflow/api-client/publishing";
import { isUncertainFailure, publishingQueries } from "./publishing-client";

const scope = { userId: "user_1", workspaceId: "workspace_1" };
const runtime = { transport: {} as never };
const window = { from: "2026-10-01T00:00:00.000Z", to: "2026-10-31T23:59:59.999Z" };

function intervalFor(posts: Array<{ status: string; createdAt?: string }>) {
	const { refetchInterval } = publishingQueries.calendar(runtime, scope, window);
	if (typeof refetchInterval !== "function") throw new Error("the calendar polls through a function");
	return refetchInterval({ state: { data: { posts } } } as never);
}

describe("publishing queries", () => {
	test("the calendar is keyed inside one identity and Workspace, by its window", () => {
		expect(publishingQueries.calendar(runtime, scope, window).queryKey).toEqual(publishingKeys.calendar(scope, window));
		expect(publishingKeys.calendar(scope, window).slice(0, 4)).toEqual(["nf", "user_1", "workspace_1", "publishing"]);
	});

	test("the calendar polls while posts are in flight and stops when everything has settled", () => {
		expect(intervalFor([{ status: "publishing" }])).toBe(3_000);
		expect(intervalFor([{ status: "posted" }, { status: "failed" }])).toBe(false);
		expect(intervalFor([])).toBe(false);
	});

	test("the guidance read uses the key the Workspace guidance setting invalidates", () => {
		expect(publishingQueries.guidance(runtime, scope).queryKey).toEqual(["nf", "user_1", "workspace_1", "publishing", "guidance"]);
	});
});

describe("uncertain failures", () => {
	const failure = (status: number) => new ApiError({ code: "x", message: "x", status });
	test("conflicts, outages and unreachable APIs are re-read; plain refusals are not", () => {
		for (const status of [0, 409, 500, 503]) expect(isUncertainFailure(failure(status))).toBe(true);
		for (const status of [400, 402, 403, 404, 422, 429]) expect(isUncertainFailure(failure(status))).toBe(false);
	});
});
