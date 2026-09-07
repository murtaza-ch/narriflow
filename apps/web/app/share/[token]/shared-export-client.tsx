"use client";

import { Box, Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { Check, Download, ShieldCheck } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { MediaWell } from "@narriflow/ui/components/media-well";
import type { ClipExportSnapshot } from "@narriflow/validators";
import { formatDateTime, formatDuration } from "@/lib/format";

export function SharedExportClient({ exported }: { exported: ClipExportSnapshot }) {
  const ready = exported.variants.filter(
    (variant) => variant.hasAsset && variant.downloadUrl,
  );
  const primary = ready[0]!;

  return (
    <Box minH="100dvh" bg="bg" layerStyle="blueprint">
      <Flex
        as="header"
        h="56px"
        align="center"
        justify="space-between"
        px={{ base: "4", md: "6" }}
        bg="bg.surface"
        borderBottomWidth="1px"
        borderColor="border"
      >
        <Text fontFamily="display" fontWeight="700" fontSize="15px">NARRIFLOW</Text>
        <Flex align="center" gap="2" color="fg.muted">
          <ShieldCheck size={14} />
          <Text fontSize="11px">Private delivery link</Text>
        </Flex>
      </Flex>

      <Grid
        maxW="1080px"
        mx="auto"
        px={{ base: "4", md: "6" }}
        py={{ base: "6", md: "10" }}
        templateColumns={{ base: "1fr", lg: "minmax(0, 1fr) 300px" }}
        gap="6"
      >
        <MediaWell
          ratio={
            primary.aspectRatio === "9:16"
              ? 9 / 16
              : primary.aspectRatio === "1:1"
                ? 1
                : primary.aspectRatio === "4:5"
                  ? 4 / 5
                  : 16 / 9
          }
          maxH="78dvh"
          mx="auto"
          w="full"
          timecode={primary.durationSec ? formatDuration(primary.durationSec) : undefined}
        >
          <Box asChild w="full" h="full" bg="studio.canvas">
            {/* biome-ignore lint/a11y/useMediaCaption: This is the final rendered export, which already burns the user's configured captions into the video. */}
            <video
              controls
              playsInline
              preload="metadata"
              src={primary.previewUrl ?? primary.downloadUrl ?? undefined}
              aria-label={`${primary.aspectRatio} shared video`}
            />
          </Box>
        </MediaWell>

        <Stack gap="4">
          <Box layerStyle="panel" p="5">
            <Text textStyle="eyebrow" color="fg.subtle">Shared export</Text>
            <Text fontFamily="display" fontSize="22px" fontWeight="600" mt="1">
              {exported.clipTitle}
            </Text>
            <Text fontSize="12px" color="fg.muted" mt="1">
              {exported.projectTitle} · {formatDateTime(exported.createdAt)}
            </Text>
            <Stack gap="2" mt="5">
              {ready.map((variant, index) => (
                <Button
                  key={variant.id}
                  asChild
                  variant={index === 0 ? "solid" : "outline"}
                  colorPalette={index === 0 ? "accent" : undefined}
                  w="full"
                >
                  <a
                    href={variant.downloadUrl ?? undefined}
                    download={`narriflow-${variant.aspectRatio.replace(":", "x")}.mp4`}
                  >
                    <Download size={14} /> Download {variant.aspectRatio} · {variant.resolution}
                  </a>
                </Button>
              ))}
            </Stack>
          </Box>
          <Flex layerStyle="well" p="4" gap="3" align="flex-start">
            <Check size={14} />
            <Box>
              <Text fontSize="12px" fontWeight="600">Version {exported.editorRevision}</Text>
              <Text fontSize="11px" color="fg.muted" mt="0.5">
                This link always delivers the exact version that was shared.
              </Text>
            </Box>
          </Flex>
        </Stack>
      </Grid>
    </Box>
  );
}
