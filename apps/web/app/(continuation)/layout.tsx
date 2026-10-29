import { Box } from "@chakra-ui/react";
import { SessionApiProvider } from "@/app/_components/workspace-query-gate";
import { ContinuationShell } from "./continuation-shell";

// Signed-in continuations from an assistant (publication confirmation, upload
// handoff). They carry their own signed Workspace, so unlike `(app)` this layout
// never admits the person's selected Workspace: a restricted or unavailable
// selection must not block them. Data-free; the shell only reads identity.
export default function ContinuationLayout({ children }: { children: React.ReactNode }) {
  return (
    <Box minH="100dvh" bg="bg.sidebar" color="fg">
      <SessionApiProvider fallback={<Box minH="100dvh" bg="bg.sidebar" />}>
        <ContinuationShell>{children}</ContinuationShell>
      </SessionApiProvider>
    </Box>
  );
}
