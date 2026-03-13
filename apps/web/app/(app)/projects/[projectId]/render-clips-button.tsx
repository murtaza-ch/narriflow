"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@narriflow/ui/components/button";
import {
  clipAspectRatioOptions,
  type ClipAspectRatio,
} from "@narriflow/validators";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { Check, ChevronDown, Loader } from "lucide-react";

const defaultSelection: Record<ClipAspectRatio, boolean> = {
  "9:16": true,
  "1:1": false,
  "16:9": false,
  "4:5": false,
};

export function RenderClipsButton({
  projectId,
  disabled,
  buttonLabel,
}: {
  projectId: string;
  disabled: boolean;
  buttonLabel: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [isOpen, setIsOpen] = useState(false);
  const [selection, setSelection] =
    useState<Record<ClipAspectRatio, boolean>>(defaultSelection);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    function handleClickOutside(event: MouseEvent) {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  const selectedAspectRatios = clipAspectRatioOptions
    .filter((option) => selection[option.value])
    .map((option) => option.value);

  async function handleRender() {
    if (selectedAspectRatios.length === 0) {
      return;
    }

    const response = await fetch(`/api/projects/${projectId}/clips/render`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        aspectRatios: selectedAspectRatios,
      }),
    });

    if (!response.ok) {
      return;
    }

    setIsOpen(false);
    startTransition(() => {
      router.refresh();
    });
  }

  return (
    <Box position="relative" ref={popoverRef}>
      <Button
        size="sm"
        disabled={disabled || isPending}
        onClick={() => setIsOpen((open) => !open)}
      >
        {isPending ? <Loader size={12} className="animate-spin" /> : null}
        <Text ml={isPending ? "4px" : "0"}>{buttonLabel}</Text>
        <ChevronDown size={12} />
      </Button>

      {isOpen ? (
        <Box
          position="absolute"
          top="calc(100% + 8px)"
          right="0"
          zIndex="20"
          minW="220px"
          borderRadius="12px"
          borderWidth="1px"
          borderColor="border"
          bg="bg.panel"
          p="12px"
          shadow="lg"
        >
          <Stack gap="10px">
            <Box>
              <Text fontSize="12px" fontWeight="600" color="fg">
                Render formats
              </Text>
              <Text fontSize="11px" color="fg.muted" mt="2px">
                Choose which variants to queue across all clips.
              </Text>
            </Box>

            <Stack gap="6px">
              {clipAspectRatioOptions.map((option) => {
                const checked = selection[option.value];

                return (
                  <Flex
                    key={option.value}
                    as="label"
                    align="center"
                    gap="8px"
                    px="8px"
                    py="6px"
                    borderRadius="8px"
                    borderWidth="1px"
                    borderColor={checked ? "border.emphasized" : "border"}
                    cursor="pointer"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(event) =>
                        setSelection((current) => ({
                          ...current,
                          [option.value]: event.target.checked,
                        }))
                      }
                    />
                    <Box>
                      <Text fontSize="12px" color="fg">
                        {option.label}
                      </Text>
                      <Text fontSize="10px" color="fg.muted">
                        {option.width}x{option.height}
                      </Text>
                    </Box>
                  </Flex>
                );
              })}
            </Stack>

            <Flex justify="space-between" align="center" gap="8px">
              <Text fontSize="11px" color="fg.muted">
                {selectedAspectRatios.length} format
                {selectedAspectRatios.length === 1 ? "" : "s"} selected
              </Text>
              <Button
                size="xs"
                disabled={selectedAspectRatios.length === 0 || isPending}
                onClick={handleRender}
              >
                {isPending ? <Loader size={12} className="animate-spin" /> : <Check size={12} />}
                <Text ml="4px">Queue Render</Text>
              </Button>
            </Flex>
          </Stack>
        </Box>
      ) : null}
    </Box>
  );
}
