import { redirect } from "next/navigation";
import { getCurrentAppUser } from "@narriflow/auth";
import { Box } from "@chakra-ui/react";
import { AppChrome } from "./_components/app-chrome";
import { getCachedDashboardStats } from "./_components/usage";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const appUser = await getCurrentAppUser();

  if (!appUser) {
    redirect("/sign-in");
  }

  if (!appUser.onboardingCompletedAt) {
    redirect("/onboarding");
  }

  const stats = await getCachedDashboardStats(appUser.id);

  return (
    <Box minH="100dvh" bg="bg" color="fg">
      {/* AppChrome (client) owns the sidebar/offset/mobile-nav vs. /upload
          funnel split — see its own comment for why that needs to be one
          pathname check rather than each piece hiding itself. */}
      <AppChrome
        email={appUser.primaryEmail}
        firstName={appUser.firstName}
        imageUrl={appUser.imageUrl}
        lastName={appUser.lastName}
        usedMinutes={stats.usedMinutes}
        limitMinutes={stats.limitMinutes}
      >
        {children}
      </AppChrome>
    </Box>
  );
}
