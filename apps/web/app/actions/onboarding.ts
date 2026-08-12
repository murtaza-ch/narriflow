"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { clerkClient } from "@clerk/nextjs/server";
import { completeUserOnboarding, requireCurrentAppUser } from "@narriflow/auth";

export async function completeOnboardingAction(formData: FormData) {
  const appUser = await requireCurrentAppUser();

  // Names moved off the sign-up card and are collected here instead.
  const firstName = String(formData.get("firstName") ?? "").trim().slice(0, 100);
  const lastName = String(formData.get("lastName") ?? "").trim().slice(0, 100);

  if (firstName || lastName) {
    try {
      const client = await clerkClient();
      await client.users.updateUser(appUser.clerkId, {
        ...(firstName ? { firstName } : {}),
        ...(lastName ? { lastName } : {}),
      });
    } catch (error) {
      // Names are optional profile data — never block workspace entry on them.
      // (getCurrentAppUser re-syncs from Clerk when name fields are missing.)
      console.warn(
        JSON.stringify({
          level: "warn",
          message: "onboarding.name_update_failed",
          userId: appUser.id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  await completeUserOnboarding(appUser.id);

  revalidatePath("/home");
  redirect("/home");
}
