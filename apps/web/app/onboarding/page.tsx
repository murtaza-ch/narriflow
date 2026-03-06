import { redirect } from "next/navigation";
import { Button } from "@narriflow/ui/components/button";
import { getCurrentAppUser } from "@narriflow/auth";
import { completeOnboardingAction } from "../actions/onboarding";

export default async function OnboardingPage() {
  const appUser = await getCurrentAppUser();

  if (!appUser) {
    redirect("/sign-in");
  }

  if (appUser.onboardingCompletedAt) {
    redirect("/dashboard");
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col justify-center gap-8 px-6 py-16">
      <div className="space-y-3">
        <h1 className="text-4xl font-semibold tracking-tight">Finish onboarding</h1>
        <p className="text-muted-foreground">
          Your workspace is ready. Complete onboarding to unlock project creation and workflow generation.
        </p>
      </div>

      <section className="rounded-xl border border-border p-6">
        <h2 className="text-lg font-semibold">What happens next</h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-muted-foreground">
          <li>Your account is linked to your workspace and usage tracking.</li>
          <li>New projects are scoped securely to your user identity.</li>
          <li>Generation APIs enforce authenticated ownership checks.</li>
        </ul>

        <form action={completeOnboardingAction} className="mt-6">
          <Button type="submit">Complete Onboarding</Button>
        </form>
      </section>
    </main>
  );
}
