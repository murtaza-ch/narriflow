import { Box } from "@chakra-ui/react";
import { InlineScript } from "@/app/_components/inline-script";
import { SessionApiProvider } from "@/app/_components/workspace-query-gate";
import { CHROME_LAYOUT_SCRIPT } from "@/lib/chrome-layout-hint";
import { AppShell } from "./_components/app-chrome";

// Data-free shell: the session, Workspace and credits are scoped API reads in
// the client `AppShell`, which also owns the sign-in, paused-Workspace and
// selection-changed recovery. Nothing here touches the database or the
// request, so the chrome and each route's skeleton prerender as static HTML.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <Box minH="100dvh" bg="bg.sidebar" color="fg">
      {/* Ahead of the chrome in the HTML, so the placeholders have their sizes
          before the first paint. `next/script` would queue it until the bundle boots. */}
      <InlineScript html={CHROME_LAYOUT_SCRIPT} />
      <SessionApiProvider renderWhilePending>
        <AppShell>{children}</AppShell>
      </SessionApiProvider>
    </Box>
  );
}
