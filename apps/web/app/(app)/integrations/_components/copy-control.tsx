"use client";

import { useState } from "react";
import { Box, Flex, Text } from "@chakra-ui/react";
import { Check, Copy } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";

export function CopyControl({
  value,
  label = "Copy",
  multiline = false,
}: {
  value: string;
  label?: string;
  multiline?: boolean;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");

  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(value);
      setStatus("copied");
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      setStatus(copied ? "copied" : "error");
    }
    window.setTimeout(() => setStatus("idle"), 1800);
  }

  return (
    <Flex
      align={multiline ? "flex-start" : "center"}
      gap="2"
      direction={{ base: multiline ? "column" : "row", sm: "row" }}
    >
      <Box
        as={multiline ? "pre" : "code"}
        layerStyle="well"
        flex="1"
        minW="0"
        w="full"
        px="3"
        py={multiline ? "3" : "2.5"}
        fontFamily="mono"
        fontSize="12.5px"
        lineHeight="1.6"
        whiteSpace={multiline ? "pre-wrap" : "nowrap"}
        overflowX="auto"
        color="fg"
      >
        {value}
      </Box>
      <Button
        type="button"
        variant="outline"
        size="sm"
        flexShrink={0}
        onClick={() => void copy()}
        aria-label={`${status === "copied" ? "Copied" : status === "error" ? "Copy failed" : label}: ${value}`}
      >
        {status === "copied" ? <Check size={14} /> : <Copy size={14} />}
        {status === "copied" ? "Copied" : status === "error" ? "Copy failed" : label}
      </Button>
      <Text srOnly aria-live="polite">
        {status === "copied" ? "Copied to clipboard" : status === "error" ? "Could not copy to clipboard" : ""}
      </Text>
    </Flex>
  );
}
