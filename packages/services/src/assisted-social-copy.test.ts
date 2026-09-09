import { describe, expect, test } from "bun:test";
import {
	AssistedSocialCopyError,
	createAssistedSocialCopy,
	createInMemoryAssistedCopyStore,
	type AssistedCopyProvider,
} from "./assisted-social-copy";

const BASE_INPUT = {
	actorUserId: "00000000-0000-4000-8000-000000000001",
	workspaceId: "00000000-0000-4000-8000-000000000002",
	projectId: "00000000-0000-4000-8000-000000000003",
	clipId: "00000000-0000-4000-8000-000000000004",
	idempotencyKey: "00000000-0000-4000-8000-000000000005",
	platforms: ["youtube_shorts", "x"] as const,
	campaignNote: "Launch week. Keep the claim precise.",
};

function provider(
	generate: AssistedCopyProvider["generate"] = async ({ platforms }) => ({
		model: "copy-test-model",
		inputTokens: 120,
		outputTokens: 55,
		variants: platforms.map((platform) => ({
			platform,
			caption:
				platform === "x"
					? "A precise launch note."
					: "A precise launch note with context.",
			hashtags: ["#Narriflow"],
			title: platform === "youtube_shorts" ? "A precise launch" : null,
		})),
	}),
): AssistedCopyProvider {
	return { name: "test", modelAlias: "copy-test-model", generate };
}

function moduleWith(
	overrides: {
		provider?: AssistedCopyProvider;
		loadContext?: Parameters<typeof createAssistedSocialCopy>[0]["loadContext"];
		moderate?: Parameters<typeof createAssistedSocialCopy>[0]["moderate"];
		timeoutMs?: number;
	} = {},
) {
	let id = 0;
	return createAssistedSocialCopy({
		store: createInMemoryAssistedCopyStore(),
		provider: overrides.provider ?? provider(),
		authorize: async () => undefined,
		loadContext:
			overrides.loadContext ??
			(async () => ({
				clipTitle: "The launch",
				hook: "Most launch videos waste the opening second.",
				payoff: "Lead with the decision instead.",
				voiceGuidance: {
					audience: "independent creators",
					tone: ["direct", "calm"],
					preferredTerms: ["publish"],
					blockedTerms: ["game-changing"],
					hashtagGuidance: "Use one branded hashtag.",
				},
			})),
		moderate:
			overrides.moderate ?? (async () => ({ outcome: "approved" as const })),
		createId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
		now: () => new Date("2026-09-02T10:00:00.000Z"),
		timeoutMs: overrides.timeoutMs ?? 1_000,
	});
}

describe("assisted social copy", () => {
	test("uses clip facts, campaign note, platform, and frozen voice guidance", async () => {
		const seen: unknown[] = [];
		const copy = moduleWith({
			provider: provider(async (input) => {
				seen.push(input);
				return provider().generate(input);
			}),
		});

		const result = await copy.generate(BASE_INPUT);

		expect(result.skippedGuidance).toEqual([]);
		expect(result.variants.map((variant) => variant.platform)).toEqual([
			"youtube_shorts",
			"x",
		]);
		expect(seen).toEqual([
			expect.objectContaining({
				campaignNote: BASE_INPUT.campaignNote,
				platforms: ["youtube_shorts", "x"],
				clip: {
					title: "The launch",
					hook: "Most launch videos waste the opening second.",
					payoff: "Lead with the decision instead.",
				},
				voiceGuidance: expect.objectContaining({ tone: ["direct", "calm"] }),
			}),
		]);
	});

	test("falls back to neutral guidance and reports what was skipped", async () => {
		let guidance: unknown;
		const copy = moduleWith({
			loadContext: async () => ({
				clipTitle: "The launch",
				hook: null,
				payoff: null,
				voiceGuidance: { tone: "not-an-array" },
			}),
			provider: provider(async (input) => {
				guidance = input.voiceGuidance;
				return provider().generate(input);
			}),
		});

		const result = await copy.generate(BASE_INPUT);

		expect(guidance).toBeNull();
		expect(result.skippedGuidance).toEqual(["brand_voice"]);
	});

	test("rejects the whole generation when moderation rejects one result", async () => {
		const copy = moduleWith({
			moderate: async ({ platform }) => ({
				outcome:
					platform === "x" ? ("rejected" as const) : ("approved" as const),
				code: platform === "x" ? "policy" : undefined,
			}),
		});

		await expect(copy.generate(BASE_INPUT)).rejects.toMatchObject({
			code: "assisted_copy_moderation_rejected",
		});
	});

	test("bounds provider latency and records a stable timeout failure", async () => {
		const copy = moduleWith({
			timeoutMs: 10,
			provider: provider(async () => new Promise(() => undefined)),
		});

		await expect(copy.generate(BASE_INPUT)).rejects.toMatchObject({
			code: "assisted_copy_provider_timeout",
		});
	});

	test("validates the project-scoped clip before persisting a generation", async () => {
		let reads = 0;
		const copy = moduleWith({
			loadContext: async () => {
				reads += 1;
				throw new AssistedSocialCopyError("assisted_copy_clip_not_found");
			},
		});

		await expect(copy.generate(BASE_INPUT)).rejects.toMatchObject({
			code: "assisted_copy_clip_not_found",
		});
		await expect(copy.generate(BASE_INPUT)).rejects.toMatchObject({
			code: "assisted_copy_clip_not_found",
		});
		expect(reads).toBe(2);
	});

	test("regeneration must preserve every locked phrase and hashtag", async () => {
		const copy = moduleWith({
			provider: provider(
				async ({ platforms, lockedPhrases, lockedHashtags }) => ({
					model: "copy-test-model",
					inputTokens: 80,
					outputTokens: 40,
					variants: platforms.map((platform) => ({
						platform,
						caption: `Keep ${lockedPhrases.join(" ")} intact.`,
						hashtags: [...lockedHashtags],
						title:
							platform === "youtube_shorts" ? lockedPhrases.join(" ") : null,
					})),
				}),
			),
		});

		const result = await copy.generate({
			...BASE_INPUT,
			idempotencyKey: "00000000-0000-4000-8000-000000000006",
			lockedPhrases: ["Launch week"],
			lockedHashtags: ["#KeepThis"],
		});

		expect(result.variants[0]?.caption).toContain("Launch week");
		expect(result.variants[0]?.hashtags).toContain("#KeepThis");

		const invalid = moduleWith({
			provider: provider(async ({ platforms }) => ({
				model: "copy-test-model",
				inputTokens: 1,
				outputTokens: 1,
				variants: platforms.map((platform) => ({
					platform,
					caption: "The model dropped the phrase.",
					hashtags: [],
					title: null,
				})),
			})),
		});
		await expect(
			invalid.generate({
				...BASE_INPUT,
				lockedPhrases: ["Launch week"],
			}),
		).rejects.toMatchObject({ code: "assisted_copy_locked_content_missing" });
	});

	test("keeps generated provenance immutable and validates its destination ownership", async () => {
		const copy = moduleWith();
		const generated = await copy.generate({
			...BASE_INPUT,
			campaignNote: undefined,
		});
		const variant = generated.variants[0]!;
		const provenance = {
			workspaceId: BASE_INPUT.workspaceId,
			projectId: BASE_INPUT.projectId,
			clipId: BASE_INPUT.clipId,
			platform: variant.platform,
			variantId: variant.id,
		};
		await expect(copy.requireProvenance(provenance)).resolves.toBeDefined();
		await expect(
			copy.requireProvenance({ ...provenance, clipId: "another-clip" }),
		).rejects.toMatchObject({ code: "assisted_copy_variant_not_found" });
		expect(
			(await copy.generate({ ...BASE_INPUT, campaignNote: undefined }))
				.variants[0],
		).toEqual(variant);
	});

	test("replays duplicate submission and rejects key reuse with new input", async () => {
		let calls = 0;
		const copy = moduleWith({
			provider: provider(async (input) => {
				calls += 1;
				return provider().generate(input);
			}),
		});

		const first = await copy.generate(BASE_INPUT);
		const replay = await copy.generate(BASE_INPUT);

		expect(replay.id).toBe(first.id);
		expect(replay.replayed).toBe(true);
		expect(calls).toBe(1);
		await expect(
			copy.generate({ ...BASE_INPUT, campaignNote: "Different" }),
		).rejects.toBeInstanceOf(AssistedSocialCopyError);
	});

	test("validates the composed caption and scopes provenance to the project", async () => {
		const copy = moduleWith({
			provider: provider(async () => ({
				model: "copy-test-model",
				inputTokens: 1,
				outputTokens: 1,
				variants: [
					{
						platform: "x",
						caption: "x".repeat(270),
						hashtags: ["#Narriflow"],
						title: null,
					},
				],
			})),
		});
		await expect(
			copy.generate({ ...BASE_INPUT, platforms: ["x"] }),
		).rejects.toMatchObject({ code: "assisted_copy_provider_output_invalid" });

		const valid = moduleWith();
		const generation = await valid.generate(BASE_INPUT);
		await expect(
			valid.requireProvenance({
				actorUserId: BASE_INPUT.actorUserId,
				workspaceId: BASE_INPUT.workspaceId,
				projectId: "00000000-0000-4000-8000-000000000099",
				variantId: generation.variants[0]!.id,
				clipId: BASE_INPUT.clipId,
				platform: "youtube_shorts",
			}),
		).rejects.toMatchObject({ code: "assisted_copy_variant_not_found" });
	});
});
