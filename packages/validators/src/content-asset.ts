import { z } from "zod";
import { outputTypeSchema } from "./output-type";

/** The transcript-derived text outputs the content suite can generate. */
export const textOutputTypeSchema = z.enum([
  "blog_post",
  "x_thread",
  "newsletter_excerpt",
  "show_notes",
  "quote_cards",
]);
export type TextOutputType = z.infer<typeof textOutputTypeSchema>;

export const ALL_TEXT_OUTPUT_TYPES: TextOutputType[] = [
  "blog_post",
  "x_thread",
  "newsletter_excerpt",
  "show_notes",
  "quote_cards",
];

export const TEXT_OUTPUT_TYPE_LABELS: Record<TextOutputType, string> = {
  blog_post: "Blog post",
  x_thread: "X / Twitter thread",
  newsletter_excerpt: "LinkedIn / newsletter post",
  show_notes: "Show notes",
  quote_cards: "Quote cards",
};

/** A stored, repurposed content asset (project snapshot shape). */
export const contentAssetSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  type: outputTypeSchema,
  title: z.string(),
  body: z.string(),
  createdAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime().nullable(),
});
export type ContentAsset = z.infer<typeof contentAssetSchema>;

export const generateContentSuiteRequestSchema = z.object({
  types: z
    .array(textOutputTypeSchema)
    .min(1)
    .refine((types) => new Set(types).size === types.length, {
      message: "Content asset types must be unique",
    })
    .default(ALL_TEXT_OUTPUT_TYPES),
});
export type GenerateContentSuiteRequest = z.infer<
  typeof generateContentSuiteRequestSchema
>;

/** Shape returned by the LLM for one generated asset. */
export const contentSuiteLlmItemSchema = z.object({
  type: textOutputTypeSchema,
  title: z.string().min(1),
  body: z.string().min(1),
});

export const contentSuiteLlmResponseSchema = z.object({
  assets: z.array(contentSuiteLlmItemSchema),
});

/** Requires exactly one returned asset for every requested type. */
export function contentSuiteLlmResponseSchemaForTypes(
  requestedTypes: readonly TextOutputType[],
) {
  const requested = new Set(requestedTypes);

  return contentSuiteLlmResponseSchema.superRefine(({ assets }, context) => {
    if (requested.size !== requestedTypes.length) {
      context.addIssue({
        code: "custom",
        path: ["assets"],
        message: "Requested content asset types must be unique",
      });
      return;
    }

    if (assets.length !== requestedTypes.length) {
      context.addIssue({
        code: "custom",
        path: ["assets"],
        message: "Response must contain exactly one asset per requested type",
      });
    }

    const returned = new Set<TextOutputType>();
    for (const [index, asset] of assets.entries()) {
      if (returned.has(asset.type)) {
        context.addIssue({
          code: "custom",
          path: ["assets", index, "type"],
          message: `Duplicate content asset type: ${asset.type}`,
        });
      }
      returned.add(asset.type);

      if (!requested.has(asset.type)) {
        context.addIssue({
          code: "custom",
          path: ["assets", index, "type"],
          message: `Unrequested content asset type: ${asset.type}`,
        });
      }
    }

    for (const type of requested) {
      if (!returned.has(type)) {
        context.addIssue({
          code: "custom",
          path: ["assets"],
          message: `Missing requested content asset type: ${type}`,
        });
      }
    }
  });
}
export type ContentSuiteLlmResponse = z.infer<
  typeof contentSuiteLlmResponseSchema
>;
