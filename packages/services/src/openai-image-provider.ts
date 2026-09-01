import {
  GeneratedMediaProviderError,
  type GeneratedImageAspectRatio,
  type GeneratedImageProvider,
  type GeneratedImageStyle,
} from "./generated-media";
import { readResponseBodyBounded } from "./url-guard";

export { GeneratedMediaProviderError } from "./generated-media";

const OPENAI_IMAGE_ENDPOINT = "https://api.openai.com/v1/images/generations";

interface OpenAiImageProviderOptions {
  apiKey: string;
  model: string;
  quality?: "low" | "medium" | "high";
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  maxOutputBytes?: number;
}

const SIZE_BY_ASPECT_RATIO: Record<GeneratedImageAspectRatio, string> = {
  "9:16": "1024x1536",
  "16:9": "1536x1024",
  "1:1": "1024x1024",
};

const STYLE_DIRECTION: Record<GeneratedImageStyle, string> = {
  editorial: "Editorial documentary photography, natural light, purposeful composition, believable details, no text or watermark.",
  cinematic: "Cinematic production still, motivated lighting, dimensional depth, restrained color grade, no text or watermark.",
  photoreal: "Photorealistic commercial photography, true-to-life materials and anatomy, no text or watermark.",
  illustration: "Polished editorial illustration, intentional shapes and visual hierarchy, no text or watermark.",
};

function retryAfterMs(response: Response) {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function normalizedProviderError(status: number, providerCode: string | null, retryMs?: number) {
  if (providerCode === "content_policy_violation" || providerCode === "moderation_blocked") {
    return new GeneratedMediaProviderError("generated_media_safety_rejected");
  }
  if (status === 429) {
    return new GeneratedMediaProviderError("generated_media_provider_rate_limited", {
      retryable: true,
      retryAfterMs: retryMs,
    });
  }
  if (status >= 500) {
    return new GeneratedMediaProviderError("generated_media_provider_unavailable", {
      retryable: true,
      retryAfterMs: retryMs,
    });
  }
  return new GeneratedMediaProviderError("generated_media_provider_validation");
}

export function createOpenAiImageProvider(options: OpenAiImageProviderOptions): GeneratedImageProvider {
  const apiKey = options.apiKey.trim();
  const model = options.model.trim();
  if (!apiKey || !model) {
    throw new GeneratedMediaProviderError("generated_media_provider_not_configured");
  }
  const request = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 90_000;
  const maxOutputBytes = options.maxOutputBytes ?? 20 * 1024 * 1024;
  const maxResponseBytes = Math.ceil(maxOutputBytes * 4 / 3) + 64 * 1024;

  return {
    name: "openai",
    modelAlias: model,

    async submit(input) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await request(OPENAI_IMAGE_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": input.requestId,
          },
          body: JSON.stringify({
            model,
            prompt: `${input.prompt.trim()}\n\nVisual direction: ${STYLE_DIRECTION[input.style]}`,
            n: 1,
            size: SIZE_BY_ASPECT_RATIO[input.aspectRatio],
            quality: options.quality ?? "medium",
            output_format: "png",
            moderation: "auto",
          }),
          signal: controller.signal,
        });
        let payload: {
          data?: Array<{ b64_json?: string }>;
          error?: { code?: string };
        } | null = null;
        try {
          const body = await readResponseBodyBounded(response, maxResponseBytes);
          payload = JSON.parse(new TextDecoder().decode(body));
        } catch (error) {
          if ((error as { code?: string }).code === "remote_response_too_large") {
            throw new GeneratedMediaProviderError("generated_media_provider_output_too_large");
          }
        }
        if (!response.ok) {
          throw normalizedProviderError(
            response.status,
            payload?.error?.code ?? null,
            retryAfterMs(response),
          );
        }
        const encoded = payload?.data?.[0]?.b64_json;
        if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
          throw new GeneratedMediaProviderError("generated_media_provider_malformed_output");
        }
        if (encoded.length > Math.ceil(maxOutputBytes * 4 / 3) + 4) {
          throw new GeneratedMediaProviderError("generated_media_provider_output_too_large");
        }
        const bytes = Uint8Array.from(Buffer.from(encoded, "base64"));
        if (bytes.length === 0) {
          throw new GeneratedMediaProviderError("generated_media_provider_malformed_output");
        }
        if (bytes.length > maxOutputBytes) {
          throw new GeneratedMediaProviderError("generated_media_provider_output_too_large");
        }
        return {
          kind: "completed" as const,
          providerRef: response.headers.get("x-request-id") ?? `openai:${input.requestId}`,
          usage: { images: 1 },
          result: { contentType: "image/png" as const, bytes },
        };
      } catch (error) {
        if (error instanceof GeneratedMediaProviderError) throw error;
        if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
          throw new GeneratedMediaProviderError("generated_media_provider_outcome_unknown", {
            outcomeUnknown: true,
          });
        }
        throw new GeneratedMediaProviderError("generated_media_provider_outcome_unknown", {
          outcomeUnknown: true,
        });
      } finally {
        clearTimeout(timeout);
      }
    },

    async poll(providerRef) {
      return {
        kind: "failed" as const,
        code: providerRef.startsWith("openai:")
          ? "generated_media_provider_outcome_unknown"
          : "generated_media_provider_reference_invalid",
        retryable: false,
      };
    },

    async cancel() {
      return { kind: "cancelled" as const };
    },

    async result() {
      throw new GeneratedMediaProviderError("generated_media_provider_result_unavailable", {
        outcomeUnknown: true,
      });
    },
  };
}

export function openAiImageProviderFromEnv(environment: NodeJS.ProcessEnv = process.env) {
  const parsedMaxBytes = Number(environment.GENERATED_IMAGE_MAX_OUTPUT_BYTES);
  return createOpenAiImageProvider({
    apiKey: environment.OPENAI_API_KEY ?? "",
    model: environment.OPENAI_IMAGE_MODEL ?? "",
    quality: environment.OPENAI_IMAGE_QUALITY === "high"
      ? "high"
      : environment.OPENAI_IMAGE_QUALITY === "low"
        ? "low"
        : "medium",
    maxOutputBytes: Number.isSafeInteger(parsedMaxBytes) && parsedMaxBytes >= 1_000_000 && parsedMaxBytes <= 100_000_000
      ? parsedMaxBytes
      : 20 * 1024 * 1024,
  });
}
