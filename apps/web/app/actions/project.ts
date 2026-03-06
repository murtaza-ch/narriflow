import { revalidatePath } from "next/cache";
import { actionClient } from "./safe-action";
import { createProjectSchema, generateProjectRequestSchema } from "@narriflow/validators";
import { projectService } from "@narriflow/services";
import { requireCurrentAppUser } from "@narriflow/auth";

const safeActionClient: any = actionClient;

export const createProjectAction = (
  safeActionClient.inputSchema?.(createProjectSchema) ?? safeActionClient.schema(createProjectSchema)
).action(async ({ parsedInput }: { parsedInput: unknown }) => {
  const appUser = await requireCurrentAppUser();
  const validatedInput = createProjectSchema.parse(parsedInput);
  const project = await projectService.createProject(appUser.id, validatedInput);
  revalidatePath("/");
  return project;
});

export const generateProjectAction = (
  safeActionClient.inputSchema?.(generateProjectRequestSchema) ??
  safeActionClient.schema(generateProjectRequestSchema)
).action(
  async ({ parsedInput }: { parsedInput: unknown }) => {
    const appUser = await requireCurrentAppUser();
    const validatedInput = generateProjectRequestSchema.parse(parsedInput);
    const placeholderProjectId = crypto.randomUUID();
    const generated = await projectService.triggerGeneration(
      appUser.id,
      placeholderProjectId,
      validatedInput,
      crypto.randomUUID(),
    );
    return generated;
  },
);

export async function createProjectFormAction(formData: FormData) {
  "use server";
  const appUser = await requireCurrentAppUser();

  const title = String(formData.get("title") ?? "");
  const sourceMediaUrl = String(formData.get("sourceMediaUrl") ?? "");

  await projectService.createProject(appUser.id, {
    title,
    sourceMediaUrl,
  });

  revalidatePath("/");
}
