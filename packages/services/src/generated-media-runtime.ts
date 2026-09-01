import { randomUUID } from "node:crypto";

import type { BrandActorScope } from "./brand-ownership";
import { isR2Configured } from "./r2-storage";
import { createProductionGeneratedMediaAnalyticsSink } from "./generated-media-analytics";
import {
	generatedMediaConfigFromEnv,
	generatedMediaUsageLimitsFromEnv,
} from "./generated-media-config";
import {
	generatedMediaAssetIngestor,
	createGeneratedMediaProviderResultStore,
	reconcileGeneratedMediaOrphans,
	r2GeneratedMediaObjectStorage,
	type GeneratedMediaObjectStorage,
} from "./generated-media-ingestion";
import { createPrismaGeneratedMediaStore } from "./generated-media-prisma";
import {
	GeneratedMediaService,
	GeneratedMediaWorker,
	createGeneratedMediaPromptProtection,
	type GeneratedMediaAssetIngestor,
	type GeneratedMediaConfig,
	type GeneratedMediaEventSink,
	type GeneratedMediaProvider,
	type GeneratedMediaStore,
} from "./generated-media";
import { generationUsageWindow } from "./generation-usage";
import {
	createOpenAiImageProvider,
	type GeneratedMediaProviderResultStore,
} from "./openai-image-provider";

type Environment = Readonly<Record<string, string | undefined>>;

function required(env: Environment, name: string) {
	const value = env[name]?.trim();
	if (!value) throw new Error(`${name} is required when generated media is enabled`);
	return value;
}

function requiredPromptSecret(env: Environment, name: string) {
	const value = required(env, name);
	if (value.length < 32) {
		throw new Error(`${name} must contain at least 32 characters`);
	}
	return value;
}

function promptEncryptionKeys(
	env: Environment,
	activeKeyVersion: string,
	activeKey: string,
) {
	const configured = env.GENERATED_MEDIA_PROMPT_DECRYPTION_KEYS_JSON?.trim();
	let previous: Record<string, string> = {};
	if (configured) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(configured);
		} catch {
			throw new Error("GENERATED_MEDIA_PROMPT_DECRYPTION_KEYS_JSON must be valid JSON");
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(
				"GENERATED_MEDIA_PROMPT_DECRYPTION_KEYS_JSON must be a key-version object",
			);
		}
		previous = Object.fromEntries(
			Object.entries(parsed).map(([version, value]) => {
				if (typeof value !== "string" || value.length < 32) {
					throw new Error(
						`Generated media prompt decryption key ${version} must contain at least 32 characters`,
					);
				}
				return [version, value];
			}),
		);
	}
	if (previous[activeKeyVersion] && previous[activeKeyVersion] !== activeKey) {
		throw new Error("Active generated media prompt key version has conflicting keys");
	}
	return { ...previous, [activeKeyVersion]: activeKey };
}

function hasCompleteProviderContract(
	provider: GeneratedMediaProvider | undefined,
	alias: string,
) {
	return Boolean(
		provider &&
			provider.alias === alias &&
			typeof provider.submit === "function" &&
			typeof provider.poll === "function" &&
			typeof provider.cancel === "function" &&
			typeof provider.retrieve === "function",
	);
}

function generatedMediaLeaseMs(value: string | undefined) {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 3 * 60_000 && parsed <= 60 * 60_000
		? parsed
		: 15 * 60_000;
}

export function createGeneratedMediaRuntime(input: {
	env?: Environment;
	store?: GeneratedMediaStore;
	ingestor?: GeneratedMediaAssetIngestor;
	resultStore?: GeneratedMediaProviderResultStore;
	objectStorage?: GeneratedMediaObjectStorage;
	videoProviders?: ReadonlyMap<string, GeneratedMediaProvider>;
	events?: GeneratedMediaEventSink;
	workerId?: string;
} = {}) {
	const env = input.env ?? process.env;
	const configured = generatedMediaConfigFromEnv(env);
	const usageLimits = generatedMediaUsageLimitsFromEnv(env);
	const configuredVideoProvider = configured.video.enabled
		? input.videoProviders?.get(configured.video.provider)
		: undefined;
	const config = {
		...configured,
		video:
			configured.video.enabled &&
			!hasCompleteProviderContract(
				configuredVideoProvider,
				configured.video.provider,
			)
				? ({
						enabled: false,
						reason: "video_provider_adapter_missing",
					} as const)
				: configured.video,
	} satisfies GeneratedMediaConfig;
	let resolvedStore = input.store;
	const store = () => {
		resolvedStore ??= createPrismaGeneratedMediaStore();
		return resolvedStore;
	};
	const objectStorage =
		input.objectStorage ?? (isR2Configured() ? r2GeneratedMediaObjectStorage : null);
	const maintenance = async (signal?: AbortSignal) => {
		const maintenanceStore = store();
		const promptsPurged = await maintenanceStore.purgeExpiredPrompts(new Date(), 100);
		if (!objectStorage) {
			return { promptsPurged, objectsDeleted: 0, objectFailures: 0 };
		}
		const minimumAgeMs = 24 * 60 * 60 * 1000;
		const [providerResults, assets] = await Promise.all([
			reconcileGeneratedMediaOrphans({
				storage: objectStorage,
				store: maintenanceStore,
				prefix: "generated-media/provider-results/",
				now: new Date(),
				minimumAgeMs,
				limit: 100,
				signal,
			}),
			reconcileGeneratedMediaOrphans({
				storage: objectStorage,
				store: maintenanceStore,
				prefix: "generated-media/assets/",
				now: new Date(),
				minimumAgeMs,
				limit: 100,
				signal,
			}),
		]);
		return {
			promptsPurged,
			objectsDeleted: providerResults.deleted + assets.deleted,
			objectFailures: providerResults.failed + assets.failed,
		};
	};
	const usageSummary = (scope: BrandActorScope) => {
		const now = new Date();
		return store().usageSummary(scope, {
			image: generationUsageWindow({
				tier: scope.pricingTier,
				kind: "image",
				usageUnits: usageLimits.image.usageUnits,
				dailyLimitUnits: usageLimits.image.dailyUsageLimit,
				dailyAbuseLimitUnits: usageLimits.image.dailyAbuseLimit,
				now,
			}),
			video: generationUsageWindow({
				tier: scope.pricingTier,
				kind: "video",
				usageUnits: usageLimits.video.usageUnits,
				dailyLimitUnits: usageLimits.video.dailyUsageLimit,
				dailyAbuseLimitUnits: usageLimits.video.dailyAbuseLimit,
				now,
			}),
		});
	};
	const enabled = config.image.enabled || config.video.enabled;
	if (!enabled) {
		return {
			available: false as const,
			config,
			service: null,
			worker: null,
			async processNext() {
				return 0 as const;
			},
			maintenance,
			usageSummary,
		};
	}

	const encryptionKey = requiredPromptSecret(
		env,
		"GENERATED_MEDIA_PROMPT_ENCRYPTION_KEY",
	);
	const activeKeyVersion = required(
		env,
		"GENERATED_MEDIA_PROMPT_ACTIVE_KEY_VERSION",
	);
	const fingerprintKey = requiredPromptSecret(
		env,
		"GENERATED_MEDIA_PROMPT_FINGERPRINT_KEY",
	);
	const encryptionKeys = promptEncryptionKeys(
		env,
		activeKeyVersion,
		encryptionKey,
	);
	if (Object.values(encryptionKeys).includes(fingerprintKey)) {
		throw new Error("Generated media prompt protection keys must be independent");
	}
	const promptProtection = createGeneratedMediaPromptProtection({
		activeKeyVersion,
		encryptionKeys,
		fingerprintKey,
	});
	const runtimeStore = store();
	if (
		(!input.ingestor ||
			!input.objectStorage ||
			(config.image.enabled && !input.resultStore)) &&
		!isR2Configured()
	) {
		throw new Error("R2 configuration is required when generated media is enabled");
	}
	const ingestor = input.ingestor ?? generatedMediaAssetIngestor;
	if (!objectStorage) {
		throw new Error("R2 configuration is required when generated media is enabled");
	}
	const events = input.events ?? createProductionGeneratedMediaAnalyticsSink();
	const providers = new Map<string, GeneratedMediaProvider>(input.videoProviders);
	if (config.image.enabled) {
		const resultStore =
			input.resultStore ?? createGeneratedMediaProviderResultStore(objectStorage);
		const provider = createOpenAiImageProvider({
			apiKey: required(env, "OPENAI_API_KEY"),
			model: config.image.model,
			resultStore,
			maxResponseBytes: Math.ceil(config.image.maxOutputBytes * 1.5) + 1024 * 1024,
		});
		providers.set(provider.alias, provider);
	}
	const service = new GeneratedMediaService({
		store: runtimeStore,
		providers,
		config,
		promptProtection,
		events,
	});
	const worker = new GeneratedMediaWorker({
		store: runtimeStore,
		providers,
		config,
		promptProtection,
		ingestor,
		events,
		leaseMs: generatedMediaLeaseMs(env.GENERATED_MEDIA_LEASE_MS),
		workerId:
			input.workerId ??
			env.GENERATED_MEDIA_WORKER_ID?.trim() ??
			env.HOSTNAME?.trim() ??
			randomUUID(),
	});
	return {
		available: true as const,
		config,
		service,
		worker,
		processNext(signal?: AbortSignal) {
			return worker.processNext(signal);
		},
		maintenance,
		usageSummary,
	};
}

let productionRuntime: ReturnType<typeof createGeneratedMediaRuntime> | null = null;

export function getGeneratedMediaRuntime() {
	productionRuntime ??= createGeneratedMediaRuntime();
	return productionRuntime;
}
