"use client";

import { chakra } from "@chakra-ui/react";
import type { ReactNode } from "react";
import { useUpgrade, type UpgradePrompt } from "../../_components/upgrade";

/** An integration tile whose action the plan rules out: it opens the upgrade dialog instead of linking. */
export function UpgradeTileButton({
  prompt,
  label,
  children,
}: {
  prompt: UpgradePrompt;
  label?: string;
  children: ReactNode;
}) {
  const { openUpgrade } = useUpgrade();
  return (
    <chakra.button
      type="button"
      aria-label={label}
      aria-haspopup="dialog"
      onClick={() => openUpgrade(prompt)}
      display="flex"
      alignItems="center"
      gap="3"
      w="full"
      p="3.5"
      bg="bg.subtle"
      borderRadius="12px"
      textAlign="start"
      cursor="pointer"
      transition="background 120ms ease"
      _hover={{ bg: "bg.muted" }}
    >
      {children}
    </chakra.button>
  );
}
