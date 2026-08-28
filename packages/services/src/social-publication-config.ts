export class SocialPublicationConfigurationError extends Error {
	readonly code = "social_publication_configuration_invalid";

	constructor(message: string) {
		super(message);
		this.name = "SocialPublicationConfigurationError";
	}
}

function integer(
	environment: Record<string, string | undefined>,
	name: string,
	fallback: number,
	minimum: number,
	maximum: number,
) {
	const raw = environment[name];
	const value = raw === undefined ? fallback : Number(raw);
	if (!Number.isFinite(value) || !Number.isInteger(value)) {
		throw new SocialPublicationConfigurationError(
			`${name} must be a finite integer`,
		);
	}
	if (value < minimum || value > maximum) {
		throw new SocialPublicationConfigurationError(
			`${name} must be between ${minimum} and ${maximum}`,
		);
	}
	return value;
}

export const SOCIAL_PUBLICATION_CAPABILITY_VERSIONS = {
	instagram_reels: "v24.0",
	linkedin: "202608",
} as const;

function supportedVersion(
	environment: Record<string, string | undefined>,
	name: string,
	supported: string,
) {
	const value =
		environment[name] === undefined ? supported : environment[name]!.trim();
	if (value !== supported) {
		throw new SocialPublicationConfigurationError(
			`${name} must be ${supported}; publication capability versions are a shared web/worker contract`,
		);
	}
	return supported;
}

function webhookConfiguration(environment: Record<string, string | undefined>) {
	const rawUrl = environment.SOCIAL_PUBLISH_WEBHOOK_URL?.trim();
	if (!rawUrl) return null;
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new SocialPublicationConfigurationError(
			"SOCIAL_PUBLISH_WEBHOOK_URL must be an absolute URL",
		);
	}
	const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
	if (
		(url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
		url.username ||
		url.password ||
		url.hash
	) {
		throw new SocialPublicationConfigurationError(
			"SOCIAL_PUBLISH_WEBHOOK_URL must use HTTPS without credentials or a fragment",
		);
	}
	const secret = environment.SOCIAL_PUBLISH_WEBHOOK_SECRET?.trim() ?? "";
	if (secret.length < 32 || secret.length > 512) {
		throw new SocialPublicationConfigurationError(
			"SOCIAL_PUBLISH_WEBHOOK_SECRET must contain between 32 and 512 characters",
		);
	}
	const redirectPolicy =
		environment.SOCIAL_PUBLISH_WEBHOOK_REDIRECT_POLICY?.trim() || "error";
	if (redirectPolicy !== "error") {
		throw new SocialPublicationConfigurationError(
			"SOCIAL_PUBLISH_WEBHOOK_REDIRECT_POLICY must be error",
		);
	}
	return {
		url: url.toString(),
		signingSecret: secret,
		deadlineMs: integer(
			environment,
			"SOCIAL_PUBLISH_WEBHOOK_DEADLINE_MS",
			10_000,
			1_000,
			60_000,
		),
		maxResponseBytes: integer(
			environment,
			"SOCIAL_PUBLISH_WEBHOOK_MAX_RESPONSE_BYTES",
			65_536,
			1_024,
			1_048_576,
		),
		redirectPolicy: "error" as const,
		reconciliationMaxMs: integer(
			environment,
			"SOCIAL_PUBLISH_WEBHOOK_RECONCILIATION_MAX_MS",
			3_600_000,
			60_000,
			7 * 24 * 60 * 60_000,
		),
	};
}

export function parseSocialPublicationConfig(
	environment: Record<string, string | undefined>,
) {
	const leaseMs = integer(
		environment,
		"SOCIAL_PUBLISH_LEASE_MS",
		60_000,
		15_000,
		15 * 60_000,
	);
	const heartbeatMs = integer(
		environment,
		"SOCIAL_PUBLISH_HEARTBEAT_MS",
		15_000,
		1_000,
		5 * 60_000,
	);
	if (heartbeatMs * 2 >= leaseMs) {
		throw new SocialPublicationConfigurationError(
			"SOCIAL_PUBLISH_HEARTBEAT_MS must be less than half SOCIAL_PUBLISH_LEASE_MS",
		);
	}
	const checkpointKey = environment.SOCIAL_PUBLICATION_CHECKPOINT_KEY?.trim();
	if (!checkpointKey || checkpointKey.length < 32) {
		throw new SocialPublicationConfigurationError(
			"SOCIAL_PUBLICATION_CHECKPOINT_KEY must contain at least 32 characters",
		);
	}
	const retryBaseMs = integer(
		environment,
		"SOCIAL_PUBLISH_RETRY_BASE_MS",
		30_000,
		1_000,
		60 * 60_000,
	);
	const retryMaxMs = integer(
		environment,
		"SOCIAL_PUBLISH_RETRY_MAX_MS",
		15 * 60_000,
		retryBaseMs,
		24 * 60 * 60_000,
	);
	return {
		worker: {
			batchSize: integer(environment, "SOCIAL_PUBLISH_BATCH_SIZE", 20, 1, 100),
			concurrency: integer(environment, "SOCIAL_PUBLISH_CONCURRENCY", 4, 1, 20),
			leaseMs,
			heartbeatMs,
			providerDeadlineMs: integer(
				environment,
				"SOCIAL_PUBLISH_PROVIDER_DEADLINE_MS",
				5 * 60_000,
				1_000,
				10 * 60_000,
			),
			providerCallBudget: integer(
				environment,
				"SOCIAL_PUBLISH_PROVIDER_CALL_BUDGET",
				100,
				1,
				100,
			),
			processingDeadlineMs: integer(
				environment,
				"SOCIAL_PUBLISH_PROCESSING_DEADLINE_MS",
				24 * 60 * 60_000,
				60_000,
				7 * 24 * 60 * 60_000,
			),
			reconciliationDeadlineMs: integer(
				environment,
				"SOCIAL_PUBLISH_RECONCILIATION_DEADLINE_MS",
				24 * 60 * 60_000,
				60_000,
				7 * 24 * 60 * 60_000,
			),
		},
		retry: {
			maxAttempts: integer(
				environment,
				"SOCIAL_PUBLISH_MAX_ATTEMPTS",
				4,
				1,
				10,
			),
			maxElapsedMs: integer(
				environment,
				"SOCIAL_PUBLISH_MAX_ELAPSED_MS",
				24 * 60 * 60_000,
				60_000,
				7 * 24 * 60 * 60_000,
			),
			baseDelayMs: retryBaseMs,
			maxDelayMs: retryMaxMs,
			jitterRatio: 0.2,
		},
		checkpointKey,
		providers: {
			metaGraphVersion: supportedVersion(
				environment,
				"META_GRAPH_VERSION",
				SOCIAL_PUBLICATION_CAPABILITY_VERSIONS.instagram_reels,
			),
			linkedInVersion: supportedVersion(
				environment,
				"LINKEDIN_API_VERSION",
				SOCIAL_PUBLICATION_CAPABILITY_VERSIONS.linkedin,
			),
		},
		webhook: webhookConfiguration(environment),
	};
}
