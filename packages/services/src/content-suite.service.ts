import { getPrismaClient } from "@narriflow/db/client";
import {
  ALL_TEXT_OUTPUT_TYPES,
  contentSuiteLlmResponseSchemaForTypes,
  resolvePricingTier,
  TEXT_OUTPUT_TYPE_LABELS,
  type ContentAsset,
  type TextOutputType,
} from "@narriflow/validators";
import { workspaceService } from "./workspace.service";

export class ContentSuiteError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ContentSuiteError";
  }
}

function requirePrisma() {
  const prisma = getPrismaClient();
  if (!prisma) {
    throw new ContentSuiteError(
      "database_unavailable",
      "Database client unavailable",
    );
  }
  return prisma;
}

// Bound the prompt size so a very long transcript can't blow the token budget.
const MAX_TRANSCRIPT_CHARS = 48_000;
const TRANSCRIPT_SECTION_MARKER = "\n\n[... transcript section ...]\n\n";

/** Deterministic head/middle/tail coverage for transcripts over the prompt cap. */
export function selectTranscriptExcerpt(transcriptText: string): string {
  if (transcriptText.length <= MAX_TRANSCRIPT_CHARS) return transcriptText;

  const markerLength = TRANSCRIPT_SECTION_MARKER.length * 2;
  const available = MAX_TRANSCRIPT_CHARS - markerLength;
  const headLength = Math.ceil(available / 3);
  const middleLength = Math.floor(available / 3);
  const tailLength = available - headLength - middleLength;
  const middleStart = Math.floor((transcriptText.length - middleLength) / 2);

  return [
    transcriptText.slice(0, headLength),
    transcriptText.slice(middleStart, middleStart + middleLength),
    transcriptText.slice(-tailLength),
  ].join(TRANSCRIPT_SECTION_MARKER);
}

const FORMAT_GUIDE: Record<TextOutputType, string> = {
  blog_post:
    "A complete, SEO-aware blog article in Markdown: an H1 title, a hook intro, 3-6 H2 sections with substance drawn from the transcript, and a short conclusion. 600-1000 words.",
  x_thread:
    "An X/Twitter thread as a numbered Markdown list (1/, 2/ …) of 6-10 tweets. Open with a scroll-stopping hook, one idea per tweet, ≤270 chars each, end with a CTA.",
  newsletter_excerpt:
    "A professional LinkedIn / newsletter post in Markdown: a strong first line, short punchy paragraphs and bullet points, an insight-driven body, and an engagement question to close. 150-300 words.",
  show_notes:
    "Podcast-style show notes in Markdown: a 2-3 sentence summary, then a 'Timestamps' section as a bullet list of the key moments, then 'Key takeaways' as bullets.",
  quote_cards:
    "3-5 of the most quotable, punchy lines from the speaker, as a Markdown list. Keep each quote verbatim or lightly tightened, ≤200 chars, attribution-ready.",
};

function buildSystemPrompt() {
  return [
    "You are an expert content strategist and ghostwriter who repurposes long-form video/podcast transcripts into platform-native written content.",
    "Write in the speaker's voice. Be specific and substantive — pull real details, examples and phrasing from the transcript. Never invent facts that aren't supported by the transcript.",
    "Keep every user-facing asset in the transcript's source language unless a target language is explicitly supplied. Preserve script, proper and product names, numbers, quotations, and intentional code-switching.",
    "Return ONLY the requested asset types. Each asset's `body` must be Markdown.",
  ].join(" ");
}

function buildUserPrompt(
  title: string,
  transcriptText: string,
  types: TextOutputType[],
  sourceLanguageCode: string | null,
) {
  const excerpt = selectTranscriptExcerpt(transcriptText);

  const requested = types
    .map(
      (type) =>
        `- ${type} (${TEXT_OUTPUT_TYPE_LABELS[type]}): ${FORMAT_GUIDE[type]}`,
    )
    .join("\n");

  return [
    `Source title: ${title || "Untitled"}`,
    `Source language: ${
      sourceLanguageCode
        ? `provider language code ${sourceLanguageCode}`
        : "unknown; infer it from the transcript and stay consistent"
    }`,
    "",
    "Generate exactly these assets (one object per type, set `type` to the exact key):",
    requested,
    "",
    "Give each asset a short human title.",
    "No target language is supplied. Write titles and bodies in the source language, preserving its script, names, products, numbers, quotations, and intentional code-switching.",
    "",
    "Transcript:",
    '"""',
    excerpt,
    '"""',
  ].join("\n");
}

function jsonSchemaForTypes(types: TextOutputType[]) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      assets: {
        type: "array",
        minItems: types.length,
        maxItems: types.length,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: { type: "string", enum: types },
            title: { type: "string" },
            body: { type: "string" },
          },
          required: ["type", "title", "body"],
        },
      },
    },
    required: ["assets"],
  };
}

function extractResponseText(payload: unknown): string | null {
  const response = payload as {
    output_text?: unknown;
    output?: Array<{ content?: Array<{ text?: unknown }> }>;
  };
  if (typeof response.output_text === "string") return response.output_text;
  const parts =
    response.output
      ?.flatMap((item) => item.content ?? [])
      .map((content) => content.text)
      .filter((text): text is string => typeof text === "string") ?? [];
  return parts.length > 0 ? parts.join("") : null;
}

function toSnapshot(row: {
  id: string;
  projectId: string;
  type: string;
  title: string;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}): ContentAsset {
  return {
    id: row.id,
    projectId: row.projectId,
    type: row.type as ContentAsset["type"],
    title: row.title,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class ContentSuiteService {
  async list(userId: string, projectId: string): Promise<ContentAsset[]> {
    const prisma = requirePrisma();
    const project = await prisma.project.findFirst({
      where: { id: projectId, userId },
      select: { id: true },
    });
    if (!project) throw new ContentSuiteError("not_found", "Project not found");

    const rows = await prisma.contentAsset.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toSnapshot);
  }

  async generate(
    userId: string,
    workspaceId: string,
    projectId: string,
    types: TextOutputType[] = ALL_TEXT_OUTPUT_TYPES,
  ): Promise<ContentAsset[]> {
    const prisma = requirePrisma();
    const actor = await workspaceService.requireActor(
      userId,
      workspaceId,
      "processing.consume",
    );

    if (types.length === 0 || new Set(types).size !== types.length) {
      throw new ContentSuiteError(
        "invalid_request",
        "Content asset types must be non-empty and unique",
      );
    }

    const project = await prisma.project.findFirst({
      where: { id: projectId, workspaceId },
      select: {
        id: true,
        title: true,
        transcript: { select: { text: true, status: true, languageCode: true } },
      },
    });
    if (!project) throw new ContentSuiteError("not_found", "Project not found");

    const tier = resolvePricingTier(actor.pricingTier);
    if (tier === "free") {
      throw new ContentSuiteError(
        "requires_creator_plan",
        "Content-suite repurposing is available on Creator and Pro plans.",
      );
    }

    const transcript = project.transcript;
    if (!transcript || transcript.status !== "completed" || !transcript.text) {
      throw new ContentSuiteError(
        "transcript_not_ready",
        "A completed transcript is required before repurposing.",
      );
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new ContentSuiteError(
        "openai_not_configured",
        "OPENAI_API_KEY is not configured",
      );
    }

    const model = process.env.OPENAI_CONTENT_MODEL ?? process.env.OPENAI_CLIP_MODEL ?? "gpt-5.4-mini";

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: [
          { role: "system", content: buildSystemPrompt() },
          {
            role: "user",
            content: buildUserPrompt(
              project.title,
              transcript.text,
              types,
              transcript.languageCode,
            ),
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "content_suite",
            strict: true,
            schema: jsonSchemaForTypes(types),
          },
        },
      }),
    });

    const payload = (await response.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    if (!response.ok || !payload) {
      throw new ContentSuiteError(
        "openai_request_failed",
        (payload as { error?: { message?: string } } | null)?.error?.message ??
          `OpenAI request failed with status ${response.status}`,
      );
    }

    const content = extractResponseText(payload);
    if (!content) {
      throw new ContentSuiteError(
        "openai_request_failed",
        "Empty response from OpenAI",
      );
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(content);
    } catch {
      throw new ContentSuiteError(
        "openai_bad_output",
        "Model returned invalid JSON",
      );
    }

    const parsed = contentSuiteLlmResponseSchemaForTypes(types).safeParse(
      parsedJson,
    );
    if (!parsed.success) {
      throw new ContentSuiteError(
        "openai_bad_output",
        "Model output did not match the expected shape",
      );
    }

    // Upsert one row per type (regenerating replaces the previous asset).
    const rows = await prisma.$transaction(
      parsed.data.assets.map((asset) =>
        prisma.contentAsset.upsert({
          where: {
            projectId_type: { projectId, type: asset.type },
          },
          create: {
            projectId,
            type: asset.type,
            title: asset.title,
            body: asset.body,
          },
          update: { title: asset.title, body: asset.body },
        }),
      ),
    );

    return rows.map(toSnapshot);
  }
}

export const contentSuiteService = new ContentSuiteService();
