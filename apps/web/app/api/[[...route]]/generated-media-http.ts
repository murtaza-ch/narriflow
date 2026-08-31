import { Hono, type Context } from "hono";
import {
	GeneratedMediaError,
	GeneratedMediaInsertionError,
	GeneratedMediaStudioError,
	ProgramWriteDisabledError,
	type BrandActorScope,
	type GeneratedMediaStudioService,
} from "@narriflow/services";
import type {
	GeneratedMediaEditorInsertionInput,
	GeneratedMediaBrollPlaybackInput,
	GeneratedMediaStudioSubmitInput,
} from "@narriflow/validators";
import { ZodError } from "zod";

type StudioService = Pick<
	GeneratedMediaStudioService,
	| "list"
	| "get"
	| "download"
	| "submit"
	| "cancel"
	| "insert"
	| "saveToActiveBrand"
	| "deleteAsset"
	| "resolveBrollPlayback"
>;

export interface GeneratedMediaStudioRouteDependencies {
	getActor(context: Context): BrandActorScope;
	getInput(context: Context): unknown | Promise<unknown>;
	getService(): StudioService;
}

type StudioFailureStatus = 400 | 402 | 403 | 404 | 409 | 422 | 429 | 503;

const STUDIO_FAILURE_MESSAGES: Readonly<Record<string, string>> = {
	validation_failed: "The generated-media request is invalid.",
	generated_media_studio_forbidden: "You cannot use generated media in this project.",
	generated_media_studio_not_found: "The generated-media item was not found.",
	generated_media_studio_not_ready: "The generated-media item is not ready yet.",
	generated_media_brand_profile_unavailable: "An active Brand Profile is required.",
	generated_media_asset_in_use: "This asset is still used by an editor document.",
	generated_media_prompt_source_invalid: "The selected prompt source is no longer available.",
	generated_media_prompt_source_revision_conflict:
		"The selected transcript changed. Review it again before generating.",
	generated_media_not_configured: "Generated media is temporarily unavailable.",
	generated_media_forbidden: "You cannot generate media in this Workspace.",
	generated_media_not_entitled: "Generated media is not available on this plan.",
	generated_media_usage_exhausted: "Generated-media usage is exhausted for this period.",
	generated_media_not_found: "The generated-media job was not found.",
	generated_media_idempotency_conflict: "This request key was already used for different input.",
	generated_media_prompt_unreadable: "The protected prompt could not be read safely.",
	generated_media_insertion_forbidden: "You cannot edit this Clip.",
	generated_media_insertion_not_found: "The generated-media insertion target was not found.",
	generated_media_insertion_not_ready: "The generated-media result is not ready to insert.",
	generated_media_insertion_asset_unavailable: "The generated-media asset is unavailable.",
	generated_media_insertion_asset_too_short: "The generated video is too short for this range.",
	generated_media_insertion_invalid: "The generated-media insertion is invalid.",
	generated_media_insertion_revision_conflict: "The Clip changed. Refresh before inserting.",
	generated_media_insertion_idempotency_conflict:
		"This insertion key was already used for different input.",
	generated_media_insertion_scene_entitlement_required:
		"Scene insertion is not available on this plan.",
};

const RETRYABLE_STUDIO_FAILURES = new Set([
	"generated_media_studio_not_ready",
	"generated_media_prompt_source_revision_conflict",
	"generated_media_not_configured",
	"generated_media_insertion_revision_conflict",
]);

function expectedFailure(
	c: Context,
	code: string,
	status: StudioFailureStatus,
	options: {
		issues?: ZodError["issues"];
		currentRevision?: number;
		message?: string;
	} = {},
) {
	c.header("X-Narriflow-Error-Contract", "expected-v1");
	return c.json(
		{
			error: code,
			message:
				options.message ??
				STUDIO_FAILURE_MESSAGES[code] ??
				"The generated-media request could not be completed.",
			retryable: RETRYABLE_STUDIO_FAILURES.has(code),
			...(options.issues ? { issues: options.issues } : {}),
			...(options.currentRevision === undefined
				? {}
				: { currentRevision: options.currentRevision }),
		},
		status,
	);
}

function studioFailure(c: Context, error: unknown) {
	if (error instanceof ZodError) {
		return expectedFailure(c, "validation_failed", 400, { issues: error.issues });
	}
	if (error instanceof GeneratedMediaStudioError) {
		if (error.code === "generated_media_studio_forbidden") {
			return expectedFailure(c, error.code, 403);
		}
		if (error.code === "generated_media_studio_not_found") {
			return expectedFailure(c, error.code, 404);
		}
		if (error.code === "generated_media_not_configured") {
			return expectedFailure(c, error.code, 503);
		}
		if (error.code === "generated_media_prompt_source_invalid") {
			return expectedFailure(c, error.code, 422);
		}
		if (error.code === "generated_media_prompt_source_revision_conflict") {
			return expectedFailure(c, error.code, 409, {
				currentRevision: error.currentRevision,
			});
		}
		return expectedFailure(c, error.code, 409);
	}
	if (error instanceof GeneratedMediaError) {
		if (error.code === "generated_media_forbidden") {
			return expectedFailure(c, error.code, 403);
		}
		if (error.code === "generated_media_not_entitled") {
			return expectedFailure(c, error.code, 402);
		}
		if (error.code === "generated_media_usage_exhausted") {
			return expectedFailure(c, error.code, 429);
		}
		if (error.code === "generated_media_not_found") {
			return expectedFailure(c, error.code, 404);
		}
		if (error.code === "generated_media_idempotency_conflict") {
			return expectedFailure(c, error.code, 409);
		}
		return expectedFailure(c, error.code, 503);
	}
	if (error instanceof GeneratedMediaInsertionError) {
		if (error.code === "generated_media_insertion_forbidden") {
			return expectedFailure(c, error.code, 403);
		}
		if (error.code === "generated_media_insertion_not_found") {
			return expectedFailure(c, error.code, 404);
		}
		if (error.code === "generated_media_insertion_revision_conflict") {
			return expectedFailure(c, error.code, 409, {
				currentRevision: error.currentRevision,
			});
		}
		if (error.code === "generated_media_insertion_idempotency_conflict") {
			return expectedFailure(c, error.code, 409);
		}
		if (error.code === "generated_media_insertion_scene_entitlement_required") {
			return expectedFailure(c, error.code, 402);
		}
		return expectedFailure(c, error.code, 422);
	}
	if (error instanceof ProgramWriteDisabledError) {
		return expectedFailure(c, error.code, 503, { message: error.message });
	}
	throw error;
}

export function createGeneratedMediaStudioRoutes(
	dependencies: GeneratedMediaStudioRouteDependencies,
) {
	const app = new Hono();

	app.get("/projects/:id/clips/:clipId/generated-media/assets/:assetId/playback", async (c) => {
			const input = (await dependencies.getInput(c)) as {
				id: string;
				clipId: string;
				assetId: string;
				fingerprint: string;
				mediaKind: "image" | "video";
			};
			const request: GeneratedMediaBrollPlaybackInput = {
				projectId: input.id,
				clipId: input.clipId,
				assetId: input.assetId,
				fingerprint: input.fingerprint,
				mediaKind: input.mediaKind,
			};
			try {
				return c.json(
					await dependencies
						.getService()
						.resolveBrollPlayback(dependencies.getActor(c), request),
					200,
				);
			} catch (error) {
				return studioFailure(c, error);
			}
	});

	app.get("/projects/:id/generated-media/jobs", async (c) => {
		const input = (await dependencies.getInput(c)) as {
			id: string;
			clipId?: string;
			limit?: number;
		};
		try {
			return c.json(
				await dependencies.getService().list(dependencies.getActor(c), {
					projectId: input.id,
					...(input.clipId ? { clipId: input.clipId } : {}),
					limit: input.limit ?? 40,
				}),
				200,
			);
		} catch (error) {
			return studioFailure(c, error);
		}
	});

	app.post("/projects/:id/generated-media/jobs", async (c) => {
		const input = (await dependencies.getInput(c)) as {
			id: string;
			body: GeneratedMediaStudioSubmitInput;
		};
		if (input.body.projectId !== input.id) {
			return expectedFailure(c, "generated_media_studio_not_found", 404);
		}
		try {
			return c.json(
				await dependencies.getService().submit(dependencies.getActor(c), input.body),
				202,
			);
		} catch (error) {
			return studioFailure(c, error);
		}
	});

	app.get("/projects/:id/generated-media/jobs/:jobId", async (c) => {
		const input = (await dependencies.getInput(c)) as {
			id: string;
			jobId: string;
		};
		try {
			return c.json(
				await dependencies
					.getService()
					.get(dependencies.getActor(c), input.id, input.jobId),
				200,
			);
		} catch (error) {
			return studioFailure(c, error);
		}
	});

	app.get("/projects/:id/generated-media/jobs/:jobId/download", async (c) => {
		const input = (await dependencies.getInput(c)) as {
			id: string;
			jobId: string;
		};
		try {
			return c.json(
				await dependencies
					.getService()
					.download(dependencies.getActor(c), input.id, input.jobId),
				200,
			);
		} catch (error) {
			return studioFailure(c, error);
		}
	});

	app.post("/projects/:id/generated-media/jobs/:jobId/cancel", async (c) => {
		const input = (await dependencies.getInput(c)) as {
			id: string;
			jobId: string;
		};
		try {
			return c.json(
				await dependencies
					.getService()
					.cancel(dependencies.getActor(c), input.id, input.jobId),
				200,
			);
		} catch (error) {
			return studioFailure(c, error);
		}
	});

	app.post("/projects/:id/generated-media/jobs/:jobId/insertions", async (c) => {
		const input = (await dependencies.getInput(c)) as {
			id: string;
			jobId: string;
			body: GeneratedMediaEditorInsertionInput;
		};
		if (input.body.projectId !== input.id || input.body.jobId !== input.jobId) {
			return expectedFailure(c, "generated_media_insertion_not_found", 404);
		}
		try {
			return c.json(
				await dependencies.getService().insert(dependencies.getActor(c), input.body),
				200,
			);
		} catch (error) {
			return studioFailure(c, error);
		}
	});

	app.post("/projects/:id/generated-media/jobs/:jobId/brand-profile", async (c) => {
		const input = (await dependencies.getInput(c)) as {
			id: string;
			jobId: string;
		};
		try {
			return c.json(
				await dependencies
					.getService()
					.saveToActiveBrand(dependencies.getActor(c), input.id, input.jobId),
				200,
			);
		} catch (error) {
			return studioFailure(c, error);
		}
	});

	app.delete("/projects/:id/generated-media/jobs/:jobId/asset", async (c) => {
		const input = (await dependencies.getInput(c)) as {
			id: string;
			jobId: string;
		};
		try {
			return c.json(
				await dependencies
					.getService()
					.deleteAsset(dependencies.getActor(c), input.id, input.jobId),
				200,
			);
		} catch (error) {
			return studioFailure(c, error);
		}
	});

	return app;
}
