import { expect, test } from "bun:test";
import {
  createOpenAiAssistedCopyModerator,
  createOpenAiAssistedCopyProvider,
} from "./openai-assisted-copy-provider";

const INPUT = {
  requestId: "00000000-0000-4000-8000-000000000001",
  platforms: ["youtube_shorts", "x"] as const,
  campaignNote: "Launch week",
  revisionInstruction: "Make it more direct",
  lockedPhrases: ["Launch week"],
  lockedHashtags: ["#Narriflow"],
  clip: { title: "A better hook", hook: "Start here", payoff: "Publish faster" },
  voiceGuidance: {
    audience: "creators",
    tone: ["direct"],
    preferredTerms: ["publish"],
    blockedTerms: ["magic"],
    hashtagGuidance: "Use one branded hashtag",
  },
  promptVersion: "assisted-social-copy-v1",
  signal: new AbortController().signal,
};

test("OpenAI assisted copy uses strict structured output without storing the request", async () => {
  let body: Record<string, unknown> | null = null;
  const provider = createOpenAiAssistedCopyProvider({
    apiKey: "test-key",
    model: "gpt-5.4-mini",
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        output: [{ content: [{ type: "output_text", text: JSON.stringify({
          variants: [
            { platform: "youtube_shorts", caption: "Launch week starts now.", hashtags: ["#Narriflow"], title: "Launch week" },
            { platform: "x", caption: "Launch week starts now.", hashtags: ["#Narriflow"], title: null },
          ],
        }) }] }],
        usage: { input_tokens: 150, output_tokens: 60 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const result = await provider.generate(INPUT);

  expect(result).toMatchObject({ model: "gpt-5.4-mini", inputTokens: 150, outputTokens: 60 });
  expect(result.variants).toHaveLength(2);
  expect(body).toMatchObject({ model: "gpt-5.4-mini", store: false });
  expect(JSON.stringify(body)).toContain("Launch week");
  expect(JSON.stringify(body)).not.toContain("transcript");
});

test("OpenAI moderation returns only an outcome and stable code", async () => {
  const moderator = createOpenAiAssistedCopyModerator({
    apiKey: "test-key",
    fetch: async () => new Response(JSON.stringify({
      results: [{ flagged: true }],
    }), { status: 200 }),
  });
  await expect(moderator({
    platform: "x",
    caption: "Unsafe result",
    hashtags: [],
    title: null,
    signal: new AbortController().signal,
  })).resolves.toEqual({ outcome: "rejected", code: "openai_moderation_flagged" });
});
