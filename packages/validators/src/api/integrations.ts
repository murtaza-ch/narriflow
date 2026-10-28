import { z } from "zod";
import type { buildGenerationContext } from "../integration";
import type { mcpPrepareSocialPostSchema } from "../mcp";

const continuation = z.string().min(1).max(32_768);
export const mcpPreparationQuerySchema = z.object({ token: continuation });
export const mcpUploadHandoffQuerySchema = z.object({ intent: continuation });
export const mcpConfirmationSchema = z.object({ token: continuation, decision: z.enum(["confirm", "decline"]) });
export type McpConfirmationInput = z.infer<typeof mcpConfirmationSchema>;
export type McpPreparationData = {
  workspaceId: string;
  workspaceName: string;
  destinationAccount: string;
  expiresAt: string;
  intent: z.infer<typeof mcpPrepareSocialPostSchema>;
};
export type McpUploadHandoffData = {
  workspaceId: string;
  clientIdempotencyKey: string;
  title?: string;
  brandProfileId?: string;
  recipeId?: string;
  recipeName: string | null;
  resumeOnly: boolean;
  generationContext?: ReturnType<typeof buildGenerationContext>;
};
