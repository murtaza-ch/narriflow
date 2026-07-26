"use client";

import { Box } from "@chakra-ui/react";

/**
 * Studio chrome is permanently graphite (mode-invariant): the `dark` class
 * pins Chakra's semantic tokens to their dark values, and studio.* static
 * tokens carry the chrome mapping.
 */
export default function StudioLayout({ children }: { children: React.ReactNode }) {
  return (
    <Box
      className="dark"
      data-theme="dark"
      position="fixed"
      inset="0"
      zIndex={200}
      bg="studio.canvas"
      color="studio.fg"
      overflow="hidden"
    >
      {children}
    </Box>
  );
}
