"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireWorkspaceAppUser as requireCurrentAppUser } from "@/lib/workspace";
import { brandTemplateService } from "@narriflow/services";
import {
  brandTemplateInputSchema,
  brandTemplateUpdateSchema,
  type BrandTemplateInput,
  type BrandTemplateUpdate,
} from "@narriflow/validators";

export async function createBrandTemplateAction(input: BrandTemplateInput) {
  const appUser = await requireCurrentAppUser("brand.manage");
  const parsed = brandTemplateInputSchema.parse(input);
  const template = await brandTemplateService.create(appUser.id, parsed, { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId });
  revalidatePath("/brand-kit");
  return template;
}

export async function updateBrandTemplateAction(
  id: string,
  input: BrandTemplateUpdate,
) {
  const appUser = await requireCurrentAppUser("brand.manage");
  const parsed = brandTemplateUpdateSchema.parse(input);
  const template = await brandTemplateService.update(appUser.id, id, parsed, { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId });
  revalidatePath("/brand-kit");
  return template;
}

export async function deleteBrandTemplateAction(id: string) {
  const appUser = await requireCurrentAppUser("brand.manage");
  await brandTemplateService.softDelete(appUser.id, id, { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId });
  revalidatePath("/brand-kit");
}

export async function setDefaultBrandTemplateAction(id: string) {
  const appUser = await requireCurrentAppUser("workspace.manage");
  await brandTemplateService.setDefault(appUser.id, id, { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId });
  revalidatePath("/brand-kit");
}

export async function duplicateBrandTemplateAction(
  id: string,
  newName?: string,
) {
  const appUser = await requireCurrentAppUser("brand.manage");
  const template = await brandTemplateService.duplicate(
    appUser.id,
    id,
    newName,
    { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId },
  );
  revalidatePath("/brand-kit");
  redirect(`/brand-kit/${template.id}`);
}
