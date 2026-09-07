import type { AssistedCopyProvider } from "./assisted-social-copy";
import { AssistedSocialCopyError } from "./assisted-social-copy";
import { readResponseBodyBounded } from "./url-guard";

const RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";
const MODERATIONS_ENDPOINT = "https://api.openai.com/v1/moderations";

type ProviderOptions = {
  apiKey: string;
  model: string;
  fetch?: typeof globalThis.fetch;
};

function systemPrompt() {
  return [
    "You write concise social copy for reviewed short-form video exports.",
    "Return one distinct variant for every requested platform.",
    "Use only the supplied clip facts. Do not invent claims, people, numbers, or outcomes.",
    "Follow the supplied brand voice when present. Avoid every blocked term.",
    "Keep locked phrases verbatim and include every locked hashtag.",
    "Caption contains prose only. Return hashtags separately without duplicates.",
    "Use a title only when the destination supports it.",
  ].join("\n");
}

function userPrompt(input: Parameters<AssistedCopyProvider["generate"]>[0]) {
  return JSON.stringify({
    promptVersion: input.promptVersion,
    platforms: input.platforms,
    clip: input.clip,
    campaignNote: input.campaignNote,
    revisionInstruction: input.revisionInstruction,
    lockedPhrases: input.lockedPhrases,
    lockedHashtags: input.lockedHashtags,
    brandVoice: input.voiceGuidance,
  });
}

function responseText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as {
    output_text?: string;
    output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  };
  if (record.output_text) return record.output_text;
  for (const item of record.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && content.text) return content.text;
    }
  }
  return null;
}

async function jsonResponse(response: Response, maxBytes = 256 * 1024) {
  const bytes = await readResponseBodyBounded(response, maxBytes);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new AssistedSocialCopyError("assisted_copy_provider_output_invalid");
  }
}

export function createOpenAiAssistedCopyProvider(options: ProviderOptions): AssistedCopyProvider {
  const apiKey = options.apiKey.trim();
  const model = options.model.trim();
  if (!apiKey || !model) {
    throw new AssistedSocialCopyError("assisted_copy_provider_not_configured");
  }
  const request = options.fetch ?? globalThis.fetch;
  return {
    name: "openai",
    modelAlias: model,
    async generate(input) {
      let response: Response;
      try {
        response = await request(RESPONSES_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": input.requestId,
          },
          body: JSON.stringify({
            model,
            store: false,
            input: [
              { role: "system", content: systemPrompt() },
              { role: "user", content: userPrompt(input) },
            ],
            text: {
              format: {
                type: "json_schema",
                name: "assisted_social_copy",
                strict: true,
                schema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["variants"],
                  properties: {
                    variants: {
                      type: "array",
                      minItems: input.platforms.length,
                      maxItems: input.platforms.length,
                      items: {
                        type: "object",
                        additionalProperties: false,
                        required: ["platform", "caption", "hashtags", "title"],
                        properties: {
                          platform: { type: "string", enum: input.platforms },
                          caption: { type: "string" },
                          hashtags: {
                            type: "array",
                            maxItems: 30,
                            items: { type: "string" },
                          },
                          title: { type: ["string", "null"] },
                        },
                      },
                    },
                  },
                },
              },
            },
          }),
          signal: input.signal,
        });
      } catch (error) {
        if (input.signal.aborted) throw error;
        throw new AssistedSocialCopyError("assisted_copy_provider_unavailable");
      }
      const payload = await jsonResponse(response);
      if (!response.ok) {
        throw new AssistedSocialCopyError(
          response.status === 429
            ? "assisted_copy_provider_rate_limited"
            : response.status >= 500
              ? "assisted_copy_provider_unavailable"
              : "assisted_copy_provider_rejected",
        );
      }
      const text = responseText(payload);
      if (!text) throw new AssistedSocialCopyError("assisted_copy_provider_output_invalid");
      let parsed: {
        variants?: Array<{
          platform?: unknown;
          caption?: unknown;
          hashtags?: unknown;
          title?: unknown;
        }>;
      };
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new AssistedSocialCopyError("assisted_copy_provider_output_invalid");
      }
      if (!Array.isArray(parsed.variants)) {
        throw new AssistedSocialCopyError("assisted_copy_provider_output_invalid");
      }
      const variants = parsed.variants.map((variant) => {
        if (
          typeof variant.platform !== "string" ||
          typeof variant.caption !== "string" ||
          !Array.isArray(variant.hashtags) ||
          variant.hashtags.some((value) => typeof value !== "string") ||
          !(typeof variant.title === "string" || variant.title === null)
        ) {
          throw new AssistedSocialCopyError("assisted_copy_provider_output_invalid");
        }
        return {
          platform: variant.platform as (typeof input.platforms)[number],
          caption: variant.caption,
          hashtags: variant.hashtags as string[],
          title: variant.title,
        };
      });
      const usage = (payload as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
      return {
        model,
        inputTokens: Number.isSafeInteger(usage?.input_tokens) ? usage!.input_tokens! : 0,
        outputTokens: Number.isSafeInteger(usage?.output_tokens) ? usage!.output_tokens! : 0,
        variants,
      };
    },
  };
}

export function createOpenAiAssistedCopyModerator(options: Omit<ProviderOptions, "model">) {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new AssistedSocialCopyError("assisted_copy_provider_not_configured");
  const request = options.fetch ?? globalThis.fetch;
  return async (input: {
    caption: string;
    hashtags: string[];
    title: string | null;
    signal: AbortSignal;
  }) => {
    const response = await request(MODERATIONS_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "omni-moderation-latest",
        input: [input.title, input.caption, input.hashtags.join(" ")].filter(Boolean).join("\n"),
      }),
      signal: input.signal,
    });
    const payload = await jsonResponse(response, 128 * 1024) as {
      results?: Array<{ flagged?: boolean }>;
    };
    if (!response.ok || payload.results?.length !== 1) {
      throw new AssistedSocialCopyError(
        response.status === 429
          ? "assisted_copy_moderation_rate_limited"
          : "assisted_copy_moderation_unavailable",
      );
    }
    return payload.results[0]!.flagged
      ? { outcome: "rejected" as const, code: "openai_moderation_flagged" }
      : { outcome: "approved" as const };
  };
}
