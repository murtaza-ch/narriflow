import { brandProfileService } from "./brand-profile.service";
import { generatedMediaConfigFromEnv } from "./generated-media-config";
import { GeneratedMediaInsertionService } from "./generated-media-insertion";
import { createPrismaGeneratedMediaInsertionStore } from "./generated-media-insertion.prisma";
import { createPrismaGeneratedMediaStore } from "./generated-media-prisma";
import {
	GeneratedMediaStudioError,
	GeneratedMediaStudioService,
} from "./generated-media-studio";
import { createPrismaGeneratedMediaStudioLibrary } from "./generated-media-studio.prisma";
import { getGeneratedMediaRuntime } from "./generated-media-runtime";

function availableWriteConfig() {
	const configured = generatedMediaConfigFromEnv();
	if (!configured.image.enabled && !configured.video.enabled) return configured;
	try {
		return getGeneratedMediaRuntime().config;
	} catch {
		return {
			image: configured.image.enabled
				? { enabled: false as const, reason: "generated_media_runtime_incomplete" }
				: configured.image,
			video: configured.video.enabled
				? { enabled: false as const, reason: "generated_media_runtime_incomplete" }
				: configured.video,
			terminalPromptRetentionMs: configured.terminalPromptRetentionMs,
		};
	}
}

export function createProductionGeneratedMediaStudioService() {
	return new GeneratedMediaStudioService({
		store: createPrismaGeneratedMediaStore(),
		library: createPrismaGeneratedMediaStudioLibrary(),
		brandProfiles: brandProfileService,
		insertion: new GeneratedMediaInsertionService({
			store: createPrismaGeneratedMediaInsertionStore(),
		}),
		async submit(scope, input) {
			const runtime = getGeneratedMediaRuntime();
			if (!runtime.available || !runtime.service) {
				throw new GeneratedMediaStudioError("generated_media_not_configured");
			}
			return runtime.service.submit(scope, input);
		},
		usageSummary(scope) {
			return getGeneratedMediaRuntime().usageSummary(scope);
		},
		writeCapabilities: availableWriteConfig,
	});
}

let productionService: GeneratedMediaStudioService | null = null;

export function getGeneratedMediaStudioService() {
	productionService ??= createProductionGeneratedMediaStudioService();
	return productionService;
}
