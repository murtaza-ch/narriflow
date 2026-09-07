import { redirect } from "next/navigation";
import { Stack } from "@chakra-ui/react";
import { admitSignedInPage } from "@/lib/authenticated-request-page";
import { AuthShell, AuthHeader } from "../components/auth-shell";
import { OnboardingForm } from "./onboarding-form";

export default async function OnboardingPage() {
  const appUser = await admitSignedInPage("/onboarding");

  if (appUser.onboardingCompletedAt) {
    redirect("/home");
  }

  return (
    <AuthShell maxW="420px">
      <Stack gap="7">
        <AuthHeader
          eyebrow="First run"
          title={appUser.firstName ? `Welcome, ${appUser.firstName}` : "Welcome to Narriflow"}
        />

        <OnboardingForm
          defaultFirstName={appUser.firstName ?? ""}
          defaultLastName={appUser.lastName ?? ""}
        />

      </Stack>
    </AuthShell>
  );
}
