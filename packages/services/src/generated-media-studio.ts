import {
	generatedMediaEditorInsertionSchema,
	generatedMediaBrollPlaybackSchema,
	generatedMediaBrollPlaybackResultSchema,
	generatedMediaDownloadResultSchema,
	generatedMediaAutomationSubmitSchema,
	generatedMediaListSchema,
	generatedMediaStudioJobSchema,
	generatedMediaStudioListResultSchema,
	generatedMediaStudioSubmitSchema,
	generatedMediaSubmitSchema,
	workspaceAllowsCapability,
	type GeneratedMediaEditorInsertionInput,
	type GeneratedMediaBrollPlaybackInput,
	type GeneratedMediaListInput,
	type GeneratedMediaStudioSubmitInput,
	type GeneratedMediaAutomationSubmit,
	type GeneratedMediaSubmitInput,
} from "@narriflow/validators";

import type { BrandActorScope } from "./brand-ownership";
import type {
	GeneratedMediaConfig,
	GeneratedMediaJobView,
	GeneratedMediaStore,
} from "./generated-media";
import type { GenerationUsageSummary } from "./generation-usage";
import type {
	GeneratedMediaInsertionResult,
	GeneratedMediaInsertionService,
} from "./generated-media-insertion";

type StudioVisualAsset = {
	id: string;
	title: string;
	kind: "image" | "video";
	fingerprint: string;
	provenance: "uploaded" | "generated" | "extracted";
	durationSec: number | null;
	accessUrl: string | null;
};

type ActiveBrandProfile = { id: string; name: string };

export type GeneratedMediaStudioJobAssetResolution = {
	jobId: string;
	state: "available" | "deleted" | "missing" | "storage_unavailable";
	savedToActiveBrandProfile: boolean;
	asset: StudioVisualAsset | null;
};

export type GeneratedMediaFrozenBrollPlayback = {
	assetId: string;
	fingerprint: string;
	mediaKind: "image" | "video";
	state:
		| "available"
		| "deleted"
		| "missing"
		| "fingerprint_stale"
		| "storage_unavailable";
	accessUrl: string | null;
};

export interface GeneratedMediaStudioLibrary {
	getActiveBrandProfile(
		scope: BrandActorScope,
		projectId: string,
	): Promise<ActiveBrandProfile | null>;
	softDeleteUnreferenced(input: {
		scope: BrandActorScope;
		projectId: string;
		jobId: string;
	}): Promise<{ assetId: string; deleted: true } | null>;
	resolveFrozenBrollAsset(
		input: GeneratedMediaBrollPlaybackInput & { scope: BrandActorScope },
	): Promise<GeneratedMediaFrozenBrollPlayback | null>;
	resolveJobDownload(input: {
		scope: BrandActorScope;
		projectId: string;
		jobId: string;
		resultAssetId: string;
		kind: "image" | "video";
	}): Promise<{ accessUrl: string } | null>;
	resolveJobAssets(input: {
		scope: BrandActorScope;
		projectId: string;
		activeBrandProfileId: string | null;
		jobs: readonly {
			jobId: string;
			resultAssetId: string | null;
			kind: "image" | "video";
		}[];
	}): Promise<readonly GeneratedMediaStudioJobAssetResolution[]>;
	resolvePromptContext(input: {
		scope: BrandActorScope;
		projectId: string;
		clipId: string | null;
		promptOrigin: {
			kind: "manual" | "transcript_selection" | "broll_cue";
			sourceIds: readonly string[];
		};
		includeDerivedContext: boolean;
		sourceRevision?: number | null;
	}): Promise<string | null>;
}

export type GeneratedMediaStudioErrorCode =
	| "generated_media_studio_forbidden"
	| "generated_media_studio_not_found"
	| "generated_media_studio_not_ready"
	| "generated_media_brand_profile_unavailable"
	| "generated_media_asset_in_use"
	| "generated_media_prompt_source_invalid"
	| "generated_media_prompt_source_revision_conflict"
	| "generated_media_not_configured";

export class GeneratedMediaStudioError extends Error {
	constructor(
		readonly code: GeneratedMediaStudioErrorCode,
		readonly currentRevision?: number,
	) {
		super(code);
		this.name = "GeneratedMediaStudioError";
	}
}

type BrandProfileAggregate = {
	revision: number;
	assets: ReadonlyArray<{ id: string; position?: number }>;
};

type BrandProfiles = {
	get(scope: BrandActorScope, profileId: string): Promise<BrandProfileAggregate>;
	setMembership(
		scope: BrandActorScope,
		profileId: string,
		input: {
			kind: "asset";
			resourceId: string;
			role: "image" | "video";
			position: number;
		},
	): Promise<{ revision: number }>;
};

export interface GeneratedMediaStudioDependencies {
	store: GeneratedMediaStore;
	library: GeneratedMediaStudioLibrary;
	brandProfiles: BrandProfiles;
	insertion: Pick<GeneratedMediaInsertionService, "insert">;
	submit(
		scope: BrandActorScope,
		input: GeneratedMediaSubmitInput,
	): Promise<GeneratedMediaJobView>;
	usageSummary(scope: BrandActorScope): Promise<GenerationUsageSummary>;
	writeCapabilities(): GeneratedMediaConfig;
	now?: () => Date;
}

function can(
	scope: BrandActorScope,
	capability:
		| "content.view"
		| "content.download"
		| "content.edit"
		| "processing.consume"
		| "brand.manage",
) {
	return workspaceAllowsCapability(
		{ role: scope.role, status: scope.status },
		capability,
	);
}

function assertView(scope: BrandActorScope) {
	if (!can(scope, "content.view")) {
		throw new GeneratedMediaStudioError("generated_media_studio_forbidden");
	}
}

function assertEdit(scope: BrandActorScope) {
	if (!can(scope, "content.edit")) {
		throw new GeneratedMediaStudioError("generated_media_studio_forbidden");
	}
}

function assertDownload(scope: BrandActorScope) {
	if (!can(scope, "content.download")) {
		throw new GeneratedMediaStudioError("generated_media_studio_forbidden");
	}
}

function assertConsume(scope: BrandActorScope) {
	if (!can(scope, "processing.consume")) {
		throw new GeneratedMediaStudioError("generated_media_studio_forbidden");
	}
}

function assertBrand(scope: BrandActorScope) {
	if (!can(scope, "brand.manage")) {
		throw new GeneratedMediaStudioError("generated_media_studio_forbidden");
	}
}

function durationOptions(config: GeneratedMediaConfig["video"]): number[] {
	if (!config.enabled || !config.maxDurationSec) return [];
	const common = [4, 6, 8].filter((duration) => duration <= config.maxDurationSec!);
	return common.length > 0 ? common : [config.maxDurationSec];
}

function capabilityProjection(config: GeneratedMediaConfig) {
	return {
		imageAvailable: config.image.enabled,
		videoAvailable: config.video.enabled,
		supportedImageRatios: config.image.enabled
			? [...(config.image.supportedAspectRatios ?? ["9:16", "1:1", "16:9"])]
			: [],
		supportedVideoRatios: config.video.enabled
			? [...(config.video.supportedAspectRatios ?? [])]
			: [],
		supportedVideoDurations: durationOptions(config.video),
	};
}

function isReusableGeneratedResult(
	provenance: StudioVisualAsset["provenance"],
): provenance is "uploaded" | "generated" {
	return provenance === "uploaded" || provenance === "generated";
}

function publicJob(
	job: GeneratedMediaJobView,
	resolution: GeneratedMediaStudioJobAssetResolution | null,
) {
	const assetAvailability =
		job.status !== "completed"
			? ("not_ready" as const)
			: resolution?.state ?? ("missing" as const);
	const asset =
		assetAvailability === "available" && resolution?.asset
			? resolution.asset
			: null;
	return generatedMediaStudioJobSchema.parse({
		id: job.id,
		kind: job.kind,
		status: job.status,
		aspectRatio: job.aspectRatio,
		style: job.style,
		durationSec: job.durationSec,
		insertionCount: job.insertionCount,
		lastInsertionKind: job.lastInsertionKind,
		lastInsertedAt: job.lastInsertedAt,
		errorCode: job.errorCode,
		moderationOutcome: job.moderation.outcome,
		createdAt: job.createdAt,
		updatedAt: job.updatedAt,
		assetAvailability,
		savedToActiveBrandProfile:
			resolution?.savedToActiveBrandProfile ?? false,
		asset:
			asset &&
			job.status === "completed" &&
			job.resultAssetId === asset.id &&
			isReusableGeneratedResult(asset.provenance) &&
			asset.kind === job.kind &&
			asset.accessUrl
				? {
						jobId: job.id,
						assetId: asset.id,
						fingerprint: asset.fingerprint,
						provenance: asset.provenance,
						kind: asset.kind,
						durationSec: asset.durationSec,
						title: asset.title,
						accessUrl: asset.accessUrl,
					}
				: null,
	});
}

export class GeneratedMediaStudioService {
	private readonly now: () => Date;

	constructor(private readonly dependencies: GeneratedMediaStudioDependencies) {
		this.now = dependencies.now ?? (() => new Date());
	}

	private async projectJob(
		scope: BrandActorScope,
		projectId: string,
		jobId: string,
	): Promise<GeneratedMediaJobView> {
		const job = await this.dependencies.store.get(scope, jobId);
		if (!job || job.projectId !== projectId) {
			throw new GeneratedMediaStudioError("generated_media_studio_not_found");
		}
		return job;
	}

	private async jobAssetMap(
		scope: BrandActorScope,
		projectId: string,
		jobs: readonly GeneratedMediaJobView[],
		activeBrandProfileId: string | null,
	) {
		const resolutions = await this.dependencies.library.resolveJobAssets({
			scope,
			projectId,
			activeBrandProfileId,
			jobs: jobs.map((job) => ({
				jobId: job.id,
				resultAssetId: job.resultAssetId,
				kind: job.kind,
			})),
		});
		return new Map(resolutions.map((resolution) => [resolution.jobId, resolution]));
	}

	async list(scope: BrandActorScope, input: GeneratedMediaListInput) {
		assertView(scope);
		const request = generatedMediaListSchema.parse(input);
		const allJobs = await this.dependencies.store.list(scope, request.projectId);
		const visibleJobs = allJobs
			.filter((job) => request.clipId === undefined || job.clipId === request.clipId)
			.slice(0, request.limit);
		const [activeBrandProfile, usage] = await Promise.all([
			this.dependencies.library.getActiveBrandProfile(scope, request.projectId),
			this.dependencies.usageSummary(scope),
		]);
		const assets = await this.jobAssetMap(
			scope,
			request.projectId,
			visibleJobs,
			activeBrandProfile?.id ?? null,
		);
		const jobs = visibleJobs
			.map((job) =>
				publicJob(
					job,
					assets.get(job.id) ?? null,
				),
			);
		return generatedMediaStudioListResultSchema.parse({
			jobs,
			capabilities: capabilityProjection(this.dependencies.writeCapabilities()),
			activeBrandProfile,
			usage,
		});
	}

	async get(scope: BrandActorScope, projectId: string, jobId: string) {
		assertView(scope);
		const job = await this.projectJob(scope, projectId, jobId);
		const activeBrandProfile = await this.dependencies.library.getActiveBrandProfile(
			scope,
			projectId,
		);
		const assets = await this.jobAssetMap(
			scope,
			projectId,
			[job],
			activeBrandProfile?.id ?? null,
		);
		return publicJob(
			job,
			assets.get(job.id) ?? null,
		);
	}

	async download(scope: BrandActorScope, projectId: string, jobId: string) {
		assertDownload(scope);
		const job = await this.projectJob(scope, projectId, jobId);
		if (job.status !== "completed" || !job.resultAssetId) {
			throw new GeneratedMediaStudioError("generated_media_studio_not_ready");
		}
		const result = await this.dependencies.library.resolveJobDownload({
			scope,
			projectId,
			jobId,
			resultAssetId: job.resultAssetId,
			kind: job.kind,
		});
		if (!result) {
			throw new GeneratedMediaStudioError("generated_media_studio_not_ready");
		}
		return generatedMediaDownloadResultSchema.parse(result);
	}

	async resolveBrollPlayback(
		scope: BrandActorScope,
		input: GeneratedMediaBrollPlaybackInput,
	) {
		assertView(scope);
		const request = generatedMediaBrollPlaybackSchema.parse(input);
		const result = await this.dependencies.library.resolveFrozenBrollAsset({
			...request,
			scope,
		});
		if (!result) {
			throw new GeneratedMediaStudioError("generated_media_studio_not_found");
		}
		return generatedMediaBrollPlaybackResultSchema.parse(result);
	}

	private async admitResolved(
		scope: BrandActorScope,
		request: GeneratedMediaAutomationSubmit,
		sourceRevision?: number | null,
	) {
		assertConsume(scope);
		const derivedContext = await this.dependencies.library.resolvePromptContext({
			scope,
			projectId: request.projectId,
			clipId: request.clipId,
			promptOrigin: request.promptOrigin,
			includeDerivedContext: request.includeDerivedContext,
			...(sourceRevision === undefined ? {} : { sourceRevision }),
		});
		const { includeDerivedContext: _includeDerivedContext, ...publicRequest } = request;
		const resolvedRequest = generatedMediaSubmitSchema.parse({
			...publicRequest,
			derivedContext,
			seed: null,
		});
		return this.dependencies.submit(scope, resolvedRequest);
	}

	async submit(scope: BrandActorScope, input: GeneratedMediaStudioSubmitInput) {
		const { sourceRevision, ...request } = generatedMediaStudioSubmitSchema.parse(input);
		return publicJob(await this.admitResolved(scope, request, sourceRevision), null);
	}

	async submitAutomation(scope: BrandActorScope, input: unknown) {
		return this.admitResolved(
			scope,
			generatedMediaAutomationSubmitSchema.parse(input),
		);
	}

	async cancel(scope: BrandActorScope, projectId: string, jobId: string) {
		assertEdit(scope);
		await this.projectJob(scope, projectId, jobId);
		const job = await this.dependencies.store.requestCancellation({
			scope,
			jobId,
			now: this.now(),
			promptRetentionMs:
				this.dependencies.writeCapabilities().terminalPromptRetentionMs ??
				30 * 24 * 60 * 60 * 1000,
		});
		if (!job || job.projectId !== projectId) {
			throw new GeneratedMediaStudioError("generated_media_studio_not_found");
		}
		return publicJob(job, null);
	}

	insert(
		scope: BrandActorScope,
		input: GeneratedMediaEditorInsertionInput,
	): Promise<GeneratedMediaInsertionResult> {
		assertEdit(scope);
		return this.dependencies.insertion.insert(
			scope,
			generatedMediaEditorInsertionSchema.parse(input),
		);
	}

	async saveToActiveBrand(
		scope: BrandActorScope,
		projectId: string,
		jobId: string,
	) {
		assertBrand(scope);
		const job = await this.projectJob(scope, projectId, jobId);
		if (job.status !== "completed" || !job.resultAssetId) {
			throw new GeneratedMediaStudioError("generated_media_studio_not_ready");
		}
		const profile = await this.dependencies.library.getActiveBrandProfile(
			scope,
			projectId,
		);
		if (!profile) {
			throw new GeneratedMediaStudioError(
				"generated_media_brand_profile_unavailable",
			);
		}
		const resolution = (
			await this.jobAssetMap(scope, projectId, [job], profile.id)
		).get(job.id);
		const asset = resolution?.state === "available" ? resolution.asset : null;
		if (
			!asset ||
			asset.id !== job.resultAssetId ||
			!isReusableGeneratedResult(asset.provenance) ||
			asset.kind !== job.kind
		) {
			throw new GeneratedMediaStudioError("generated_media_studio_not_ready");
		}
		const aggregate = await this.dependencies.brandProfiles.get(scope, profile.id);
		if (aggregate.assets.some((member) => member.id === asset.id)) {
			return {
				profileId: profile.id,
				profileRevision: aggregate.revision,
				assetId: asset.id,
			};
		}
		const position = aggregate.assets.reduce(
			(max, member) => Math.max(max, member.position ?? -1),
			-1,
		) + 1;
		const updated = await this.dependencies.brandProfiles.setMembership(
			scope,
			profile.id,
			{
				kind: "asset",
				resourceId: asset.id,
				role: asset.kind,
				position,
			},
		);
		return {
			profileId: profile.id,
			profileRevision: updated.revision,
			assetId: asset.id,
		};
	}

	async deleteAsset(scope: BrandActorScope, projectId: string, jobId: string) {
		assertBrand(scope);
		const deleted = await this.dependencies.library.softDeleteUnreferenced({
			scope,
			projectId,
			jobId,
		});
		if (!deleted) {
			throw new GeneratedMediaStudioError("generated_media_studio_not_found");
		}
		return deleted;
	}
}
