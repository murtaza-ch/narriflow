"use client";

import { ColorModeProvider } from "@narriflow/ui/components/color-mode";
import { Box } from "@chakra-ui/react";

export default function StudioLayout({ children }: { children: React.ReactNode }) {
  return (
    <ColorModeProvider forcedTheme="dark">
      <Box
        position="fixed"
        inset="0"
        zIndex={200}
        bg="#0c0c0c"
        color="#EDEDED"
        overflow="hidden"
      >
        {children}
      </Box>
    </ColorModeProvider>
  );
}
