import { Box } from "@chakra-ui/react";
import { SessionApiProvider } from "@/app/_components/workspace-query-gate";
import { AppShell } from "./_components/app-chrome";

// Data-free shell: the session, Workspace and credits are scoped API reads in
// the client `AppShell`, which also owns the sign-in, paused-Workspace and
// selection-changed recovery. Nothing here touches the database.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <Box minH="100dvh" bg="bg.sidebar" color="fg">
      <SessionApiProvider fallback={<Box minH="100dvh" bg="bg.sidebar" />}>
        <AppShell>{children}</AppShell>
      </SessionApiProvider>
    </Box>
  );
}
