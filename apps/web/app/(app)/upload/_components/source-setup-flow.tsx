"use client";

import { useRef, useState, type ReactNode } from "react";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { ArrowRight, Play, X } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Input } from "@narriflow/ui/components/input";
import type { ContentPack, GenerationMode } from "@narriflow/validators";

type AspectRatio = ContentPack["defaultAspectRatio"];

/** File and RSS setup stays in the browser until the final upload action. */
export function SourceSetupFlow({
  title,
  onTitleChange,
  sourceLabel,
  sourcePreview,
  sourcePicker,
  metadata,
  mode,
  canContinue,
  locked,
  onChangeSource,
  configuration,
  actions,
}: {
  title: string;
  onTitleChange: (value: string) => void;
  sourceLabel: string;
  sourcePreview: ReactNode;
  sourcePicker?: ReactNode;
  metadata: ReactNode;
  mode: GenerationMode;
  canContinue: boolean;
  locked: boolean;
  onChangeSource: () => void;
  configuration: (
    ratio: AspectRatio,
    onRatioChange: (ratio: AspectRatio) => void,
  ) => ReactNode;
  actions: (ratio: AspectRatio) => ReactNode;
}) {
  const previewRef = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState<2 | 3>(2);
  const [expandedPreview, setExpandedPreview] = useState(false);
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("9:16");
  function changeStep(next: 2 | 3) {
    previewRef.current?.querySelector("video")?.pause();
    setExpandedPreview(false);
    setStep(next);
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  return (
    <Stack gap="5" maxW={step === 2 ? "640px" : "860px"} mx="auto">
      <Stack
        gap="4"
        bg={step === 2 ? "bg.panel" : "bg.subtle"}
        p={{ base: "4", md: step === 2 ? "5" : "3" }}
        rounded="2xl"
      >
        <Flex
          display={step === 2 ? "flex" : "none"}
          justify="space-between"
          align="center"
          gap="2"
        >
          <Text fontSize="12px" color="fg.muted">
            {sourceLabel}
          </Text>
          <Button
            size="sm"
            variant="ghost"
            disabled={locked}
            onClick={step === 2 ? onChangeSource : () => changeStep(2)}
          >
            {step === 2 ? "Change source" : "Edit details"}
          </Button>
        </Flex>
        <Flex
          direction={expandedPreview ? "column" : "row"}
          align={expandedPreview ? "stretch" : "center"}
          gap="3"
        >
          <Box
            ref={previewRef}
            inert={!expandedPreview || undefined}
            w={
              expandedPreview
                ? "full"
                : step === 3
                  ? "88px"
                  : { base: "90px", sm: "120px" }
            }
            flexShrink="0"
            pointerEvents={expandedPreview ? "auto" : "none"}
            overflow="hidden"
            rounded="lg"
          >
            {sourcePreview}
          </Box>
          <Stack gap="2" minW="0" flex="1">
            {step === 2 ? (
              <Input
                aria-label="Project title"
                placeholder="Give your project a name"
                value={title}
                disabled={locked}
                onChange={(event) => onTitleChange(event.target.value)}
                size="sm"
              />
            ) : (
              <Text fontSize="13px" fontWeight="550" truncate>
                {title}
              </Text>
            )}
            <Button
              alignSelf="start"
              h={step === 3 ? "24px" : undefined}
              size="sm"
              variant="ghost"
              onClick={() => {
                if (expandedPreview)
                  previewRef.current?.querySelector("video")?.pause();
                setExpandedPreview(!expandedPreview);
              }}
              color="fg.muted"
            >
              {expandedPreview ? <X size={13} /> : <Play size={13} />}
              {expandedPreview ? "Close preview" : "Preview video"}
            </Button>
          </Stack>
          {step === 3 && !expandedPreview && (
            <Button
              size="sm"
              variant="ghost"
              disabled={locked}
              onClick={() => changeStep(2)}
            >
              Edit details
            </Button>
          )}
        </Flex>
        {step === 2 && (
          <>
            {sourcePicker}
            {metadata}
            <Button
              h="46px"
              rounded="xl"
              bg="accent.solid"
              color="accent.contrast"
              disabled={!canContinue || locked}
              onClick={() => changeStep(3)}
            >
              Continue to{" "}
              {mode === "clip" ? "clip settings" : "caption settings"}
              <ArrowRight size={16} />
            </Button>
            <Text fontSize="11px" color="fg.muted" textAlign="center">
              Your upload starts after you confirm your settings.
            </Text>
          </>
        )}
      </Stack>
      {step === 3 && (
        <>
          <fieldset
            disabled={locked}
            inert={locked || undefined}
            style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}
          >
            {configuration(aspectRatio, setAspectRatio)}
          </fieldset>
          <Stack
            gap="3"
            position="sticky"
            bottom="0"
            zIndex="10"
            bg="bg"
            py="4"
            borderTopWidth="1px"
            borderColor="border.subtle"
          >
            {actions(aspectRatio)}
          </Stack>
        </>
      )}
    </Stack>
  );
}
