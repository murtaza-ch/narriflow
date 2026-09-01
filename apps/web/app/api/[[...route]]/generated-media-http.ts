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

function studioFailure(c: Context, error: unknown) {
	if (error instanceof ZodError) {
		return c.json({ error: "validation_failed", issues: error.issues }, 400);
	}
	if (error instanceof GeneratedMediaStudioError) {
		if (error.code === "generated_media_studio_forbidden") {
			return c.json({ error: error.code }, 403);
		}
		if (error.code === "generated_media_studio_not_found") {
			return c.json({ error: error.code }, 404);
		}
		if (error.code === "generated_media_not_configured") {
			return c.json({ error: error.code }, 503);
		}
		if (error.code === "generated_media_prompt_source_invalid") {
			return c.json({ error: error.code }, 422);
		}
		if (error.code === "generated_media_prompt_source_revision_conflict") {
			return c.json(
				{
					error: error.code,
					...(error.currentRevision === undefined
						? {}
						: { currentRevision: error.currentRevision }),
				},
				409,
			);
		}
		return c.json({ error: error.code }, 409);
	}
	if (error instanceof GeneratedMediaError) {
		if (error.code === "generated_media_forbidden") {
			return c.json({ error: error.code }, 403);
		}
		if (error.code === "generated_media_not_entitled") {
			return c.json({ error: error.code }, 402);
		}
		if (error.code === "generated_media_usage_exhausted") {
			return c.json({ error: error.code }, 429);
		}
		if (error.code === "generated_media_not_found") {
			return c.json({ error: error.code }, 404);
		}
		if (error.code === "generated_media_idempotency_conflict") {
			return c.json({ error: error.code }, 409);
		}
		return c.json({ error: error.code }, 503);
	}
	if (error instanceof GeneratedMediaInsertionError) {
		if (error.code === "generated_media_insertion_forbidden") {
			return c.json({ error: error.code }, 403);
		}
		if (error.code === "generated_media_insertion_not_found") {
			return c.json({ error: error.code }, 404);
		}
		if (error.code === "generated_media_insertion_revision_conflict") {
			return c.json(
				{
					error: error.code,
					...(error.currentRevision === undefined
						? {}
						: { currentRevision: error.currentRevision }),
				},
				409,
			);
		}
		if (error.code === "generated_media_insertion_idempotency_conflict") {
			return c.json({ error: error.code }, 409);
		}
		if (error.code === "generated_media_insertion_scene_entitlement_required") {
			return c.json({ error: error.code }, 402);
		}
		return c.json({ error: error.code }, 422);
	}
	if (error instanceof ProgramWriteDisabledError) {
		return c.json({ error: error.code, message: error.message }, 503);
	}
	return c.json(
		{
			error: "generated_media_unavailable",
			message: "Generated media is temporarily unavailable.",
		},
		503,
	);
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
			return c.json({ error: "generated_media_studio_not_found" }, 404);
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
			return c.json({ error: "generated_media_insertion_not_found" }, 404);
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
