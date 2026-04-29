"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireCurrentAppUser } from "@narriflow/auth";
import { brandTemplateService } from "@narriflow/services";
import {
  brandTemplateInputSchema,
  brandTemplateUpdateSchema,
  type BrandTemplateInput,
  type BrandTemplateUpdate,
} from "@narriflow/validators";

export async function createBrandTemplateAction(input: BrandTemplateInput) {
  const appUser = await requireCurrentAppUser();
  const parsed = brandTemplateInputSchema.parse(input);
  const template = await brandTemplateService.create(appUser.id, parsed);
  revalidatePath("/settings/brand-templates");
  return template;
}

export async function updateBrandTemplateAction(
  id: string,
  input: BrandTemplateUpdate,
) {
  const appUser = await requireCurrentAppUser();
  const parsed = brandTemplateUpdateSchema.parse(input);
  const template = await brandTemplateService.update(appUser.id, id, parsed);
  revalidatePath("/settings/brand-templates");
  return template;
}

export async function deleteBrandTemplateAction(id: string) {
  const appUser = await requireCurrentAppUser();
  await brandTemplateService.softDelete(appUser.id, id);
  revalidatePath("/settings/brand-templates");
}

export async function setDefaultBrandTemplateAction(id: string) {
  const appUser = await requireCurrentAppUser();
  await brandTemplateService.setDefault(appUser.id, id);
  revalidatePath("/settings/brand-templates");
}

export async function duplicateBrandTemplateAction(
  id: string,
  newName?: string,
) {
  const appUser = await requireCurrentAppUser();
  const template = await brandTemplateService.duplicate(
    appUser.id,
    id,
    newName,
  );
  revalidatePath("/settings/brand-templates");
  redirect(`/settings/brand-templates/${template.id}`);
}
