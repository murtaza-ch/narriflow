import { describe, expect, test } from "bun:test";

import {
  AssistedCopyError,
  createAssistedCopyService,
  createInMemoryAssistedCopyStore,
  type AssistedCopyProvider,
} from "./assisted-copy.service";

const scope = {
  actorUserId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  projectId: "00000000-0000-4000-8000-000000000003",
};

const input = {
  idempotencyKey: "00000000-0000-4000-8000-000000000004",
  clipId: "00000000-0000-4000-8000-000000000005",
  platform: "linkedin" as const,
  campaignNote: "Focus on the practical takeaway.",
  lockedTerms: ["Readiness Score"],
};

function completedProvider(counter: { calls: number }): AssistedCopyProvider {
  return {
    async generate(request) {
      counter.calls += 1;
      expect(request.context.title).toBe("Recovery before symptoms");
      expect(request.context.voiceGuidance.tone).toBe("measured");
      return {
        kind: "completed",
        modelAlias: "copy-test",
        moderationOutcome: "accepted",
        usage: { inputTokens: 120, outputTokens: 42 },
        content: {
          caption: "Your recovery data often moves before you notice the symptoms.",
          hashtags: ["recovery", "wearables"],
          title: null,
        },
      };
    },
  };
}

function service(provider: AssistedCopyProvider, diagnostics: unknown[] = []) {
  return createAssistedCopyService({
    store: createInMemoryAssistedCopyStore({
      context: {
        clipId: input.clipId,
        title: "Recovery before symptoms",
        hook: "The score dropped first",
        payoff: "The wearer got sick hours later",
        brandProfileId: "00000000-0000-4000-8000-000000000006",
        brandProfileRevision: 3,
        voiceGuidance: {
          tone: "measured",
          audience: "performance coaches",
          preferredPhrases: ["Readiness Score"],
          avoidedPhrases: [],
        },
      },
    }),
    provider,
    authorize: async () => undefined,
    diagnostics: (event) => diagnostics.push(event),
    now: () => new Date("2026-08-31T10:00:00.000Z"),
  });
}

describe("Assisted Copy", () => {
  test("generates one durable draft and replays duplicate submission", async () => {
    const counter = { calls: 0 };
    const copy = service(completedProvider(counter));

    const first = await copy.generate(scope, input);
    const replay = await copy.generate(scope, input);

    expect(first.status).toBe("completed");
    expect(first.content?.hashtags).toEqual(["recovery", "wearables"]);
		expect(first).toMatchObject({
		modelAlias: "copy-test",
		promptVersion: "assisted-copy-v1",
	});
    expect(replay.id).toBe(first.id);
    expect(replay.replayed).toBe(true);
    expect(counter.calls).toBe(1);
  });

	test("replays a durable duplicate before initializing the provider", async () => {
		const store = createInMemoryAssistedCopyStore({
			context: {
				clipId: input.clipId,
				title: "Recovery before symptoms",
				hook: "The score dropped first",
				payoff: "The wearer got sick hours later",
				brandProfileId: null,
				brandProfileRevision: null,
				voiceGuidance: null,
			},
		});
		const writer = createAssistedCopyService({
			store,
			provider: completedProvider({ calls: 0 }),
			authorize: async () => undefined,
		});
		const original = await writer.generate(scope, input);
		let providerFactories = 0;
		const replayOnly = createAssistedCopyService({
			store,
			provider: () => {
				providerFactories += 1;
				throw new Error("provider temporarily unavailable");
			},
			authorize: async () => undefined,
		});

		await expect(replayOnly.generate(scope, input)).resolves.toEqual({
			...original,
			replayed: true,
		});
		expect(providerFactories).toBe(0);
	});

	test("settles provider initialization failure instead of stranding a generating draft", async () => {
		const copy = createAssistedCopyService({
			store: createInMemoryAssistedCopyStore({
				context: {
					clipId: input.clipId,
					title: "Recovery before symptoms",
					hook: null,
					payoff: null,
					brandProfileId: null,
					brandProfileRevision: null,
					voiceGuidance: null,
				},
			}),
			provider: () => {
				throw new Error("provider configuration unavailable");
			},
			authorize: async () => undefined,
		});

		expect(await copy.generate(scope, input)).toMatchObject({
			status: "failed",
			errorCode: "assisted_copy_provider_failed",
		});
	});

  test("rejects reuse of an idempotency key with different prompt inputs", async () => {
    const copy = service(completedProvider({ calls: 0 }));
    await copy.generate(scope, input);

    await expect(
      copy.generate(scope, { ...input, campaignNote: "A different campaign." }),
    ).rejects.toMatchObject({ code: "assisted_copy_idempotency_conflict" });
  });

  test("keeps moderation rejection and unknown provider outcomes explicit", async () => {
    const rejected = service({
      async generate() {
        return {
          kind: "rejected",
          modelAlias: "copy-test",
          moderationOutcome: "rejected",
          errorCode: "assisted_copy_rejected",
        };
      },
    });
    const unknown = service({
      async generate() {
        return {
          kind: "unknown",
          modelAlias: "copy-test",
          moderationOutcome: "unknown",
          errorCode: "assisted_copy_provider_outcome_unknown",
        };
      },
    });

    expect((await rejected.generate(scope, input)).status).toBe("rejected");
    expect((await unknown.generate(scope, input)).status).toBe("unknown");
  });

  test("uses neutral guidance when the frozen Brand Profile has no valid voice guidance", async () => {
    let observedTone = "";
    const copy = createAssistedCopyService({
      store: createInMemoryAssistedCopyStore({
        context: {
          clipId: input.clipId,
          title: "Recovery before symptoms",
          hook: "The score dropped first",
          payoff: null,
          brandProfileId: null,
          brandProfileRevision: null,
          voiceGuidance: null,
        },
      }),
      authorize: async () => undefined,
      provider: {
        async generate(request) {
          observedTone = request.context.voiceGuidance.tone;
          expect(request.guidanceSkipped).toBe(true);
          return {
            kind: "completed",
            modelAlias: "copy-test",
            moderationOutcome: "accepted",
            usage: { inputTokens: 10, outputTokens: 10 },
            content: { caption: "Draft", hashtags: [], title: null },
          };
        },
      },
    });

    expect(await copy.generate(scope, input)).toMatchObject({
      status: "completed",
      guidanceSkipped: true,
    });
    expect(observedTone).toBe("clear and direct");
  });

  test("settles malformed provider copy instead of leaving a generation running", async () => {
    const copy = service({
      async generate() {
        return {
          kind: "completed",
          modelAlias: "copy-test",
          moderationOutcome: "accepted",
          usage: { inputTokens: 10, outputTokens: 10 },
          content: { caption: "", hashtags: [], title: null },
        };
      },
    });

    expect(await copy.generate(scope, input)).toMatchObject({
      status: "unknown",
      errorCode: "assisted_copy_provider_outcome_unknown",
    });
  });

	test("rejects an oversized provider title before persisting the draft", async () => {
		const copy = service({
			async generate() {
				return {
					kind: "completed",
					modelAlias: "copy-test",
					moderationOutcome: "accepted",
					usage: { inputTokens: 10, outputTokens: 10 },
					content: {
						caption: "Bounded caption.",
						hashtags: [],
						title: "x".repeat(301),
					},
				};
			},
		});

		expect(await copy.generate(scope, input)).toMatchObject({
			status: "unknown",
			content: null,
			errorCode: "assisted_copy_provider_outcome_unknown",
		});
	});

  test("requires explicit editor confirmation before a draft is publishable", async () => {
    const copy = service(completedProvider({ calls: 0 }));
    const draft = await copy.generate(scope, input);

    expect(draft.confirmed).toBe(false);
    const confirmed = await copy.confirm(scope, draft.id, {
      expectedRevision: draft.revision,
      content: {
        caption: "Edited by the editor.",
        hashtags: ["recovery"],
        title: "What readiness data catches first",
      },
    });

    expect(confirmed.confirmed).toBe(true);
    expect(confirmed.revision).toBe(draft.revision + 1);
    expect(confirmed.content?.caption).toBe("Edited by the editor.");
  });

  test("regeneration preserves only editor-locked terms", async () => {
    const requests: Array<{ lockedTerms: string[]; sourceDraftId: string | null }> = [];
    const copy = service({
      async generate(request) {
        requests.push({
          lockedTerms: request.lockedTerms,
          sourceDraftId: request.sourceDraftId,
        });
        return {
          kind: "completed",
          modelAlias: "copy-test",
          moderationOutcome: "accepted",
          usage: { inputTokens: 10, outputTokens: 10 },
          content: { caption: "Draft", hashtags: [], title: null },
        };
      },
    });
    const first = await copy.generate(scope, input);
    const next = await copy.generate(scope, {
      ...input,
      idempotencyKey: "00000000-0000-4000-8000-000000000007",
      sourceDraftId: first.id,
      lockedTerms: ["Readiness Score", "coaches"],
    });

    expect(next.sourceDraftId).toBe(first.id);
    expect(requests[1]).toEqual({
      lockedTerms: ["Readiness Score", "coaches"],
      sourceDraftId: first.id,
    });
  });

  test("diagnostics contain identifiers and outcomes but no generated copy", async () => {
    const diagnostics: unknown[] = [];
    const copy = service(completedProvider({ calls: 0 }), diagnostics);
    await copy.generate(scope, input);

    const serialized = JSON.stringify(diagnostics);
    expect(serialized).toContain("assisted_copy_completed");
    expect(serialized).not.toContain("Your recovery data");
    expect(serialized).not.toContain(input.campaignNote);
    expect(serialized).not.toContain("Readiness Score");
  });

  test("cannot confirm a rejected draft", async () => {
    const copy = service({
      async generate() {
        return {
          kind: "rejected",
          modelAlias: "copy-test",
          moderationOutcome: "rejected",
          errorCode: "assisted_copy_rejected",
        };
      },
    });
    const draft = await copy.generate(scope, input);

    await expect(
      copy.confirm(scope, draft.id, {
        expectedRevision: draft.revision,
        content: { caption: "No", hashtags: [], title: null },
      }),
    ).rejects.toBeInstanceOf(AssistedCopyError);
  });

  test("reads a durable draft without exposing provider prompt inputs", async () => {
    const copy = service(completedProvider({ calls: 0 }));
    const generated = await copy.generate(scope, input);

    expect(await copy.get(scope, generated.id)).toEqual(generated);
    await expect(
      copy.get(scope, "10000000-0000-4000-8000-000000000099"),
    ).rejects.toMatchObject({ code: "assisted_copy_not_found" });
  });

  test("lists only the latest durable draft for each clip and platform", async () => {
    const copy = service(completedProvider({ calls: 0 }));
    const first = await copy.generate(scope, input);
    const latest = await copy.generate(scope, {
      ...input,
      idempotencyKey: "00000000-0000-4000-8000-000000000008",
      sourceDraftId: first.id,
    });

    expect(await copy.listLatest(scope, input.platform)).toEqual([latest]);
    expect(await copy.listLatest(scope, "tiktok")).toEqual([]);
  });

  test("keeps durable reads available when new assisted-copy writes are disabled", async () => {
    const store = createInMemoryAssistedCopyStore({
      context: {
        clipId: input.clipId,
        title: "Recovery before symptoms",
        hook: "The score dropped first",
        payoff: null,
        brandProfileId: null,
        brandProfileRevision: null,
        voiceGuidance: null,
      },
    });
    const writer = createAssistedCopyService({
      store,
      provider: completedProvider({ calls: 0 }),
      authorize: async () => undefined,
    });
    const durable = await writer.generate(scope, input);
    let providerFactories = 0;
    const rolledBack = createAssistedCopyService({
      store,
      provider: () => {
        providerFactories += 1;
        throw new Error("provider configuration is disabled");
      },
      authorize: async () => {
        throw new AssistedCopyError(
          "program_write_disabled",
          "New assisted-copy writes are disabled",
        );
      },
      authorizeRead: async () => undefined,
    });

    await expect(rolledBack.get(scope, durable.id)).resolves.toEqual(durable);
    await expect(rolledBack.listLatest(scope, input.platform)).resolves.toEqual([
      durable,
    ]);
    await expect(rolledBack.generate(scope, {
      ...input,
      idempotencyKey: "00000000-0000-4000-8000-000000000099",
    })).rejects.toMatchObject({ code: "program_write_disabled" });
    expect(providerFactories).toBe(0);
  });

  test("reconciles an overdue generation on reopen without a provider retry", async () => {
    let currentTime = new Date("2026-08-31T10:00:00.000Z");
    let releaseProvider!: (outcome: Awaited<ReturnType<AssistedCopyProvider["generate"]>>) => void;
    let providerCalls = 0;
    const providerStarted = Promise.withResolvers<void>();
    const store = createInMemoryAssistedCopyStore({
      context: {
        clipId: input.clipId,
        title: "Recovery before symptoms",
        hook: "The score dropped first",
        payoff: null,
        brandProfileId: null,
        brandProfileRevision: null,
        voiceGuidance: null,
      },
    });
    const copy = createAssistedCopyService({
      store,
      provider: {
        generate: async () => {
          providerCalls += 1;
          providerStarted.resolve();
          return new Promise((resolve) => {
            releaseProvider = resolve;
          });
        },
      },
      authorize: async () => undefined,
      now: () => currentTime,
    });
    const pending = copy.generate(scope, input);
    await providerStarted.promise;
    currentTime = new Date("2026-08-31T10:00:31.000Z");

    const reopened = await copy.listLatest(scope, input.platform);
    expect(reopened).toEqual([
      expect.objectContaining({
        status: "unknown",
        errorCode: "assisted_copy_provider_outcome_unknown",
      }),
    ]);
    expect(await copy.generate(scope, input)).toMatchObject({
      status: "unknown",
      replayed: true,
    });
    expect(providerCalls).toBe(1);

    releaseProvider({
      kind: "completed",
      modelAlias: "late-response",
      moderationOutcome: "accepted",
      usage: { inputTokens: 10, outputTokens: 10 },
      content: { caption: "Late result", hashtags: [], title: null },
    });
    expect(await pending).toMatchObject({
      status: "unknown",
      content: null,
      errorCode: "assisted_copy_provider_outcome_unknown",
    });
  });

  test("allows an explicit new regeneration after the prior outcome becomes unknown", async () => {
    let currentTime = new Date("2026-08-31T10:00:00.000Z");
    let releaseFirst!: (outcome: Awaited<ReturnType<AssistedCopyProvider["generate"]>>) => void;
    const firstStarted = Promise.withResolvers<void>();
    let calls = 0;
    const store = createInMemoryAssistedCopyStore({
      context: {
        clipId: input.clipId,
        title: "Recovery before symptoms",
        hook: null,
        payoff: null,
        brandProfileId: null,
        brandProfileRevision: null,
        voiceGuidance: null,
      },
    });
    const copy = createAssistedCopyService({
      store,
      provider: {
        async generate() {
          calls += 1;
          if (calls === 1) {
            firstStarted.resolve();
            return new Promise((resolve) => {
              releaseFirst = resolve;
            });
          }
          return {
            kind: "completed",
            modelAlias: "copy-test",
            moderationOutcome: "accepted",
            usage: { inputTokens: 10, outputTokens: 10 },
            content: { caption: "Fresh result", hashtags: [], title: null },
          };
        },
      },
      authorize: async () => undefined,
      now: () => currentTime,
    });
    const abandoned = copy.generate(scope, input);
    await firstStarted.promise;
    currentTime = new Date("2026-08-31T10:00:31.000Z");
    expect(await copy.listLatest(scope, input.platform)).toEqual([
      expect.objectContaining({ status: "unknown" }),
    ]);
    const regenerated = await copy.generate(scope, {
      ...input,
      idempotencyKey: "00000000-0000-4000-8000-000000000099",
    });
    expect(regenerated).toMatchObject({ status: "completed", content: { caption: "Fresh result" } });
    expect(calls).toBe(2);

    releaseFirst({
      kind: "unknown",
      modelAlias: "copy-test",
      moderationOutcome: "unknown",
      errorCode: "assisted_copy_provider_outcome_unknown",
    });
    await abandoned;
  });
});
