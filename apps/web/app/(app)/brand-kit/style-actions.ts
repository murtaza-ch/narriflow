"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  executeWorkspaceAction,
  executeWorkspaceActionWithInput,
} from "@/lib/authenticated-request-action";
import { brandTemplateService } from "@narriflow/services";
import {
  brandTemplateInputSchema,
  brandTemplateUpdateSchema,
  type BrandTemplateInput,
  type BrandTemplateUpdate,
} from "@narriflow/validators";

export async function createBrandTemplateAction(input: BrandTemplateInput) {
  return executeWorkspaceActionWithInput("brand.manage", input, brandTemplateInputSchema, async (appUser, parsed) => {
    const template = await brandTemplateService.create(appUser, parsed);
    revalidatePath("/brand-kit", "layout");
    return template;
  });
}

export async function updateBrandTemplateAction(
  id: string,
  input: BrandTemplateUpdate,
) {
  return executeWorkspaceActionWithInput("brand.manage", input, brandTemplateUpdateSchema, async (appUser, parsed) => {
    const template = await brandTemplateService.update(appUser, id, parsed);
    revalidatePath("/brand-kit", "layout");
    return template;
  });
}

export async function deleteBrandTemplateAction(id: string) {
  return executeWorkspaceAction("brand.manage", async (appUser) => {
    await brandTemplateService.softDelete(appUser, id);
    revalidatePath("/brand-kit", "layout");
  });
}

export async function setDefaultBrandTemplateAction(id: string) {
  return executeWorkspaceAction("workspace.manage", async (appUser) => {
    await brandTemplateService.setDefault(appUser, id);
    revalidatePath("/brand-kit", "layout");
  });
}

export async function duplicateBrandTemplateAction(
  id: string,
  newName?: string,
) {
  return executeWorkspaceAction("brand.manage", async (appUser) => {
    const template = await brandTemplateService.duplicate(appUser, id, newName);
    revalidatePath("/brand-kit", "layout");
    redirect(`/brand-kit/styles/${template.id}`);
  });
}
