import { revalidatePath } from "next/cache";
import { actionClient } from "./safe-action";
import { createProjectSchema, generateProjectRequestSchema } from "@narriflow/validators";
import { projectService } from "@narriflow/services";

const safeActionClient: any = actionClient;

export const createProjectAction = (
  safeActionClient.inputSchema?.(createProjectSchema) ?? safeActionClient.schema(createProjectSchema)
).action(async ({ parsedInput }: { parsedInput: unknown }) => {
  const validatedInput = createProjectSchema.parse(parsedInput);
  const project = await projectService.createProject(validatedInput);
  revalidatePath("/");
  return project;
});

export const generateProjectAction = (
  safeActionClient.inputSchema?.(generateProjectRequestSchema) ??
  safeActionClient.schema(generateProjectRequestSchema)
).action(
  async ({ parsedInput }: { parsedInput: unknown }) => {
    const validatedInput = generateProjectRequestSchema.parse(parsedInput);
    const placeholderProjectId = crypto.randomUUID();
    const generated = await projectService.triggerGeneration(
      placeholderProjectId,
      validatedInput,
      crypto.randomUUID(),
    );
    return generated;
  },
);

export async function createProjectFormAction(formData: FormData) {
  "use server";

  const title = String(formData.get("title") ?? "");
  const sourceMediaUrl = String(formData.get("sourceMediaUrl") ?? "");

  await projectService.createProject({
    title,
    sourceMediaUrl,
  });

  revalidatePath("/");
}
