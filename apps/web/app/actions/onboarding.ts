"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { clerkClient } from "@clerk/nextjs/server";
import { completeUserOnboarding } from "@narriflow/auth";
import { onboardingProfileActionSchema } from "@narriflow/validators";
import { executeSignedInActionWithInput } from "@/lib/authenticated-request-action";

export async function completeOnboardingAction(formData: FormData) {
  return executeSignedInActionWithInput(
    Object.fromEntries(formData.entries()),
    onboardingProfileActionSchema,
    async (appUser, input) => {
      const { firstName, lastName } = input;

      if (firstName || lastName) {
        try {
          const client = await clerkClient();
          await client.users.updateUser(appUser.clerkId, {
            ...(firstName ? { firstName } : {}),
            ...(lastName ? { lastName } : {}),
          });
        } catch {
          // Names are optional profile data — never block workspace entry on them.
          // (authenticated actor resolution re-syncs from Clerk when name fields are missing.)
          console.warn(
            JSON.stringify({
              level: "warn",
              message: "onboarding.name_update_failed",
              userId: appUser.actorUserId,
              errorCode: "clerk_profile_update_failed",
            }),
          );
        }
      }

      await completeUserOnboarding(appUser.actorUserId);

      revalidatePath("/home");
      redirect("/home");
    },
  );
}
