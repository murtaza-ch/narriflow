"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { completeUserOnboarding, requireCurrentAppUser } from "@narriflow/auth";

export async function completeOnboardingAction() {
  const appUser = await requireCurrentAppUser();

  await completeUserOnboarding(appUser.id);

  revalidatePath("/dashboard");
  redirect("/dashboard");
}
