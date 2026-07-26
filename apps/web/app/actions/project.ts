import { revalidatePath } from "next/cache";
import { actionClient } from "./safe-action";
import { createProjectSchema } from "@narriflow/validators";
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
