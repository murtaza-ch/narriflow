import type {
  AssistedCopyContent,
  AssistedCopyProvider,
  AssistedCopyProviderOutcome,
  AssistedCopyProviderRequest,
} from "./assisted-copy.service";

export class AssistedCopyProviderConfigurationError extends Error {
  readonly code = "assisted_copy_provider_unconfigured";

  constructor() {
    super("Assisted copy requires OPENAI_API_KEY and OPENAI_COPY_MODEL");
    this.name = "AssistedCopyProviderConfigurationError";
  }
}

const COPY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    caption: { type: "string", minLength: 1, maxLength: 5_000 },
    hashtags: {
      type: "array",
      maxItems: 30,
      items: { type: "string", minLength: 1, maxLength: 100 },
    },
    title: { type: ["string", "null"], maxLength: 300 },
  },
  required: ["caption", "hashtags", "title"],
} as const;

function promptInput(request: AssistedCopyProviderRequest) {
  const facts = {
    title: request.context.title,
    hook: request.context.hook,
    payoff: request.context.payoff,
  };
  const voice = request.context.voiceGuidance;
  return [
    {
      role: "system",
      content: [
        {
          type: "input_text",
          text: [
            "Write publication-ready social copy from supplied facts only.",
            "Do not invent names, outcomes, quotations, numbers, or calls to action.",
            "Return one caption, a list of hashtags without # prefixes, and an optional title.",
            `Destination: ${request.platform}.`,
            `Tone: ${voice.tone}. Audience: ${voice.audience}.`,
            voice.preferredPhrases.length
              ? `Preferred phrases when accurate: ${voice.preferredPhrases.join(", ")}.`
              : "No preferred phrases were supplied.",
            voice.avoidedPhrases.length
              ? `Avoid these phrases: ${voice.avoidedPhrases.join(", ")}.`
              : "No avoided phrases were supplied.",
            voice.hashtagGuidance
              ? `Hashtag guidance: ${voice.hashtagGuidance}.`
              : "No brand-specific hashtag guidance was supplied.",
          ].join("\n"),
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: JSON.stringify({
            facts,
            campaignNote: request.campaignNote,
            lockedTerms: request.lockedTerms,
          }),
        },
      ],
    },
  ];
}

function outputText(payload: Record<string, unknown>) {
  if (typeof payload.output_text === "string") return payload.output_text;
  if (!Array.isArray(payload.output)) return null;
  for (const item of payload.output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (
        part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "output_text" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        return (part as { text: string }).text;
      }
    }
  }
  return null;
}

function parsedCopy(value: string): AssistedCopyContent | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      typeof parsed.caption !== "string" ||
      !parsed.caption.trim() ||
      parsed.caption.length > 5_000 ||
      !Array.isArray(parsed.hashtags) ||
      parsed.hashtags.length > 30 ||
      parsed.hashtags.some((tag) => typeof tag !== "string" || !tag.trim() || tag.length > 100) ||
      !(parsed.title === null || typeof parsed.title === "string")
    ) {
      return null;
    }
    return {
      caption: parsed.caption,
      hashtags: parsed.hashtags as string[],
      title: parsed.title as string | null,
    };
  } catch {
    return null;
  }
}

function usage(payload: Record<string, unknown>) {
  const raw = payload.usage;
  if (!raw || typeof raw !== "object") return { inputTokens: 0, outputTokens: 0 };
  const values = raw as Record<string, unknown>;
  return {
    inputTokens: typeof values.input_tokens === "number" ? values.input_tokens : 0,
    outputTokens: typeof values.output_tokens === "number" ? values.output_tokens : 0,
  };
}

function incompleteReason(payload: Record<string, unknown>) {
  const details = payload.incomplete_details;
  return details && typeof details === "object"
    ? (details as Record<string, unknown>).reason
    : null;
}

export function createOpenAiAssistedCopyProvider(options: {
  env?: Record<string, string | undefined>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
} = {}): AssistedCopyProvider {
  const env = options.env ?? process.env;
  const apiKey = env.OPENAI_API_KEY?.trim();
  const modelAlias = env.OPENAI_COPY_MODEL?.trim();
  if (!apiKey || !modelAlias) throw new AssistedCopyProviderConfigurationError();
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = Math.min(60_000, Math.max(1, options.timeoutMs ?? 20_000));

  return {
    async generate(request): Promise<AssistedCopyProviderOutcome> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            "idempotency-key": request.requestId,
          },
          body: JSON.stringify({
            model: modelAlias,
            store: false,
            input: promptInput(request),
            text: {
              format: {
                type: "json_schema",
                name: "narriflow_social_copy",
                strict: true,
                schema: COPY_SCHEMA,
              },
            },
          }),
          signal: controller.signal,
        });
        const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        const reason = incompleteReason(payload);
        if (
          reason === "content_filter" ||
          (!response.ok && JSON.stringify(payload).includes("content_policy"))
        ) {
          return {
            kind: "rejected",
            modelAlias,
            moderationOutcome: "rejected",
            errorCode: "assisted_copy_rejected",
            usage: usage(payload),
          };
        }
        if (!response.ok) {
          if (response.status >= 500) {
            return {
              kind: "unknown",
              modelAlias,
              moderationOutcome: "unknown",
              errorCode: "assisted_copy_provider_outcome_unknown",
              usage: usage(payload),
            };
          }
          return {
            kind: "failed",
            modelAlias,
            moderationOutcome: "unknown",
            errorCode:
              response.status === 429
                ? "assisted_copy_provider_rate_limited"
                : "assisted_copy_provider_failed",
            usage: usage(payload),
          };
        }
        if (payload.status !== "completed") {
          return {
            kind: "unknown",
            modelAlias,
            moderationOutcome: "unknown",
            errorCode: "assisted_copy_provider_outcome_unknown",
            usage: usage(payload),
          };
        }
        const text = outputText(payload);
        const content = text ? parsedCopy(text) : null;
        if (!content) {
          return {
            kind: "unknown",
            modelAlias,
            moderationOutcome: "unknown",
            errorCode: "assisted_copy_provider_outcome_unknown",
            usage: usage(payload),
          };
        }
        return {
          kind: "completed",
          modelAlias,
          moderationOutcome: "accepted",
          usage: usage(payload),
          content,
        };
      } catch {
        return {
          kind: "unknown",
          modelAlias,
          moderationOutcome: "unknown",
          errorCode: "assisted_copy_provider_outcome_unknown",
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
