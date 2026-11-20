"use client";

import { Flex } from "@chakra-ui/react";
import { Copy } from "lucide-react";
import { toaster } from "@narriflow/ui/components/toaster";

/** Copies credit text, saying so; a blocked clipboard says that instead. */
export async function copyCredit(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toaster.create({ type: "success", title: "Credit copied", description: "Paste it into your video description." });
  } catch {
    toaster.create({ type: "error", title: "Couldn't copy the credit", description: "Select the text and copy it instead." });
  }
}

/** A soft pill button that copies `text`. */
export function CopyCreditButton({ text, label }: { text: string; label: string }) {
  return (
    <Flex
      as="button"
      aria-label={label}
      minH="28px"
      minW="24px"
      px="3"
      align="center"
      gap="1.5"
      flexShrink={0}
      borderRadius="8px"
      bg="studio.raised"
      color="studio.fg"
      fontSize="12px"
      fontWeight="500"
      cursor="pointer"
      _hover={{ bg: "studio.borderStrong" }}
      onClick={() => void copyCredit(text)}
    >
      <Copy size={12} />
      {label}
    </Flex>
  );
}
