import { describe, expect, test } from "bun:test";
import {
	brandApplyRequirement,
	derivePlanFacts,
	deriveProjectView,
	dubbingUpgradeFor,
	type ProjectDetailData,
	type ProjectRecord,
} from "./project-view-model";

function detail(overrides: {
	project?: Partial<ProjectRecord>;
	tier?: string;
	role?: string;
	status?: string;
	personal?: boolean;
	clips?: unknown[];
	pack?: unknown;
	transcriptStatus?: string | null;
	run?: unknown;
	progress?: unknown;
	creditUsage?: unknown;
	ingestAttemptCount?: number;
	usage?: Record<string, unknown>;
}): { data: ProjectDetailData; project: ProjectRecord } {
	const project = {
		id: "p1",
		title: "Show",
		ingestStatus: "ready",
		ingestErrorCode: null,
		sourceType: "upload",
		sourceInput: null,
		sourceMediaUrl: "",
		sourceStorageKey: "key",
		sourceDurationSeconds: 600,
		languageCode: null,
		notifyOnComplete: false,
		brandProfileId: null,
		...overrides.project,
	} as unknown as ProjectRecord;
	const data = {
		tab: "clips",
		access: {
			role: overrides.role ?? "owner",
			status: overrides.status ?? "active",
			pricingTier: overrides.tier ?? "pro",
			isPersonalWorkspace: overrides.personal ?? true,
		},
		snapshot: {
			project,
			progress: overrides.progress ?? { active: false, status: "completed", label: "Done" },
			activeRun: overrides.run ?? null,
			lastSeq: 0,
			ingestAttemptCount: overrides.ingestAttemptCount ?? 0,
			ingestJobType: "ingest",
		},
		transcript: {
			view: "status",
			data: overrides.transcriptStatus === null ? null : { status: overrides.transcriptStatus ?? "completed" },
		},
		clips: overrides.clips ?? [],
		contentPack: overrides.pack === undefined ? { mode: "clip", draft: false } : overrides.pack,
		socialPosts: { items: [], nextCursor: null },
		workflowHistory: [],
		usage: {
			tier: overrides.tier ?? "pro",
			remainingCredits: 40,
			limitCredits: 100,
			maxUploadSeconds: 3600,
			renewsAt: "2026-11-01T00:00:00.000Z",
			...overrides.usage,
		},
		finishing: null,
		creditUsage: overrides.creditUsage ?? null,
		tabData: {},
	} as unknown as ProjectDetailData;
	return { data, project };
}

function view(overrides: Parameters<typeof detail>[0]) {
	const { data, project } = detail(overrides);
	return deriveProjectView(data, project);
}

describe("Project view model", () => {
	test("capabilities follow role and Workspace status, and a paused Workspace explains itself", () => {
		const editor = view({ role: "editor" });
		expect(editor.canEdit).toBe(true);
		expect(editor.viewOnlyNote).toBeNull();

		const viewer = view({ role: "viewer" });
		expect(viewer.canEdit).toBe(false);
		expect(viewer.canPublish).toBe(false);
		expect(viewer.viewOnlyNote?.message).toContain("view access");

		const restrictedOwner = view({ role: "owner", status: "restricted" });
		expect(restrictedOwner.canEdit).toBe(false);
		expect(restrictedOwner.viewOnlyNote?.billingAction).toBe("Manage billing");
	});

	test("a source over the plan length shows the limit before the click, until settlement", () => {
		const over = view({ tier: "free", project: { sourceDurationSeconds: 5000 }, usage: { maxUploadSeconds: 1800 } });
		expect(over.planLimitMessage).toContain("over the 30-min per-video limit");

		const settled = view({
			tier: "free",
			project: { sourceDurationSeconds: 5000 },
			usage: { maxUploadSeconds: 1800 },
			creditUsage: { state: "settled", spentCredits: 10 },
		});
		expect(settled.planLimitMessage).toBeNull();
	});

	test("a credits stop mid-flight names the renewal date in UTC and keeps the processing panel up", () => {
		const blocked = view({
			project: { ingestStatus: "failed", ingestErrorCode: "credits_exhausted" },
			clips: [],
		});
		expect(blocked.quotaBlockedMessage).toContain("credits renew on 2026-11-01 (UTC)");
		expect(blocked.showProcessingPanel).toBe(true);
	});

	test("the retry limit message counts attempts and disables Retry once exhausted", () => {
		const open = view({ ingestAttemptCount: 4 });
		expect(open.ingestAttemptsExhausted).toBe(false);
		const spent = view({ ingestAttemptCount: 5 });
		expect(spent.ingestAttemptsExhausted).toBe(true);
		expect(spent.ingestRetryLimitMessage).toContain("(5/5)");
	});

	test("a draft pack is never read as a running configuration", () => {
		const draft = view({ pack: { mode: "caption_only", draft: true } });
		expect(draft.isDraftPack).toBe(true);
		expect(draft.showProcessingPanel).toBe(false);
	});

	test("a reclaimed source is reported once ingest is ready without a storage key", () => {
		expect(view({ project: { sourceStorageKey: null } }).isSourceExpired).toBe(true);
		expect(view({}).isSourceExpired).toBe(false);
	});

	test("the pipeline lists the five steps in order", () => {
		expect(view({}).steps.map((step) => step.label)).toEqual(["Ingest", "Transcribe", "Detect", "Render", "Publish"]);
	});
});

function clipWith(id: string, ...variants: Array<[status: string, errorCode?: string]>) {
	return {
		id,
		renderVariants: variants.map(([status, errorCode], index) => ({
			aspectRatio: index === 0 ? "9:16" : "1:1",
			resolution: "1080p",
			status,
			errorCode: errorCode ?? null,
			hasAsset: status === "completed",
		})),
	};
}

const failedRenderRun = {
	workflowRunId: "r1",
	stage: "clip_rendering",
	status: "failed",
	progress: 0,
	errorCode: "clip_render_group_failed",
};
const failedRenderProgress = { active: false, status: "failed", label: "Rendering failed" };

describe("A failed render never hides the clips", () => {
	test("first run: every render failed, the clips stay with Retry targets and the badge counts renders", () => {
		const first = view({
			run: failedRenderRun,
			progress: failedRenderProgress,
			clips: [clipWith("a", ["failed", "x_unmapped"]), clipWith("b", ["failed"])],
		});
		expect(first.showProcessingPanel).toBe(false);
		expect(first.renderStatus.failedCount).toBe(2);
		expect(first.renderStatus.groups).toEqual([{ aspectRatio: "9:16", resolution: "1080p", clipIds: ["a", "b"] }]);
		expect(first.headerBadge).toEqual({ status: "failed", label: "2 renders failed" });
	});

	test("a re-render of one clip failed: nine rendered clips stay, one retry target, badge says 1 render failed", () => {
		const rendered = Array.from({ length: 9 }, (_, index) => clipWith(`ok${index}`, ["completed"]));
		const failed = view({
			run: failedRenderRun,
			progress: failedRenderProgress,
			clips: [...rendered, clipWith("bad", ["failed", "clip_render_group_failed"])],
		});
		expect(failed.showProcessingPanel).toBe(false);
		expect(failed.renderStatus.failedCount).toBe(1);
		expect(failed.renderStatus.groups[0]?.clipIds).toEqual(["bad"]);
		expect(failed.headerBadge).toEqual({ status: "failed", label: "1 render failed" });
	});

	test("partial: failed and rendered variants of different clips both stay, one group per format", () => {
		const partial = view({
			run: failedRenderRun,
			progress: failedRenderProgress,
			clips: [clipWith("a", ["completed"], ["failed"]), clipWith("b", ["failed"]), clipWith("c", ["completed"])],
		});
		expect(partial.showProcessingPanel).toBe(false);
		expect(partial.renderStatus.groups.map((group) => [group.aspectRatio, group.clipIds])).toEqual([
			["1:1", ["a"]],
			["9:16", ["b"]],
		]);
		expect(partial.headerBadge?.label).toBe("2 renders failed");
	});

	test("once the failed renders are retried the badge clears and a running retry keeps the list", () => {
		const retrying = view({
			run: { ...failedRenderRun, status: "running" },
			progress: { active: true, status: "processing", label: "Rendering" },
			clips: [clipWith("a", ["completed"]), clipWith("b", ["rendering"])],
		});
		expect(retrying.showProcessingPanel).toBe(false);
		expect(retrying.renderStatus.inFlightCount).toBe(1);
		expect(retrying.headerBadge?.label).toBe("Rendering");
		const settled = view({
			run: failedRenderRun,
			progress: failedRenderProgress,
			clips: [clipWith("a", ["completed"])],
		});
		expect(settled.headerBadge).toBeNull();
	});

	test("a first render that is still running shows the progress card until a video exists", () => {
		const running = view({
			run: { ...failedRenderRun, status: "running" },
			progress: { active: true, status: "processing", label: "Rendering" },
			clips: [clipWith("a", ["rendering"])],
		});
		expect(running.showProcessingPanel).toBe(true);
	});

	test("a failed earlier stage still shows the panel, which has its own retry", () => {
		const failedDetect = view({
			run: { workflowRunId: "r1", stage: "moment_detection", status: "failed", progress: 0, errorCode: "x" },
			progress: { active: false, status: "failed", label: "Detecting failed" },
			clips: [clipWith("a", ["completed"])],
		});
		expect(failedDetect.showProcessingPanel).toBe(true);
	});
});

describe("Plan facts", () => {
	test("branding a shared Workspace needs Business even where Pro brands a personal one", () => {
		expect(brandApplyRequirement({ pricingTier: "pro", isPersonalWorkspace: true })).toBeNull();
		const shared = brandApplyRequirement({ pricingTier: "pro", isPersonalWorkspace: false });
		expect(shared?.requiredTier).toBe("business");
		expect(shared?.message).toBe("Branding in a shared Workspace needs the Business plan.");
		expect(brandApplyRequirement({ pricingTier: "business", isPersonalWorkspace: false })).toBeNull();
	});

	test("the free plan is offered the upgrades that unlock publishing and repurposing", () => {
		const free = derivePlanFacts("free", true);
		expect(free.publishingUpgrade?.tier).toBeDefined();
		expect(free.contentSuiteRequirement).not.toBeNull();
		expect(free.brandUpgrade?.headline).toBe("Upgrade to brand your clips");
		const business = derivePlanFacts("business", true);
		expect(business.publishingUpgrade).toBeNull();
		expect(business.contentSuiteRequirement).toBeNull();
	});

	test("the same inputs yield equal facts, so a memoized result keeps panel props stable", () => {
		expect(derivePlanFacts("pro", false)).toEqual(derivePlanFacts("pro", false));
	});

	test("dubbing: no offer when the plan dubs and has room, an offer once the allowance is spent", () => {
		const room = { used: 1, remaining: 5 } as unknown as ProjectDetailData["tabData"]["dubAllowance"];
		const spent = { used: 5, remaining: 0 } as unknown as ProjectDetailData["tabData"]["dubAllowance"];
		expect(dubbingUpgradeFor("business", room)).toBeNull();
		expect(dubbingUpgradeFor("free", null)?.headline).toBe("Upgrade to dub your clips");
		expect(dubbingUpgradeFor("creator", spent)).not.toBeUndefined();
	});
});
