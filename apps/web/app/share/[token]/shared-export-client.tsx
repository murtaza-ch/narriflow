"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createGuestReviewsClient, reviewQueries } from "@narriflow/api-client/reviews";
import { ReviewQueryProvider, useReviewTokenDigest, reviewApiOrigin, useExpiringReviewGrant } from "../../review/[token]/review-client-model";
import { ReviewPending, ReviewPlaybackVideo } from "../../review/[token]/review-client";
import SharedClipUnavailable from "./not-found";
import { Box, Flex, Heading, Stack, Text } from "@chakra-ui/react";
import { Download, Lock } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Logo } from "@narriflow/ui/components/logo";
import type { ClipExportSnapshot } from "@narriflow/validators";
import type { ReviewMediaGrant } from "@narriflow/validators/api/reviews";
import { formatDate, formatDuration } from "@/lib/format";

export function SharedExportPageClient({ token }: { token: string }) {
  const digest = useReviewTokenDigest(token);
  return <ReviewQueryProvider>{digest ? <SharedExportQuery key={digest} token={token} digest={digest} /> : <ReviewPending />}</ReviewQueryProvider>;
}

function SharedExportQuery({ token, digest }: { token: string; digest: string }) {
  const queryClient = useQueryClient();
  const client = useMemo(() => createGuestReviewsClient({ baseUrl: reviewApiOrigin(), getSession: () => null }), []);
  const options = reviewQueries.share(client, token, digest);
  const query = useQuery(options);
  useExpiringReviewGrant(query.data?.expiresAt, query.refetch);
  if (query.isPending) return <ReviewPending />;
  if (!query.data) return <SharedClipUnavailable />;
  return <SharedExportClient exported={query.data} refreshExport={(force) => queryClient.fetchQuery<SharedExport>({ ...options, ...(force ? { staleTime: 0 } : {}) })} />;
}

function formatBytes(value: number | null): string | null {
  if (value === null || value <= 0) return null;
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / (1024 * 1024)).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function aspectNumber(label: string) {
  const [width, height] = label.split(":").map(Number);
  return width && height ? width / height : 16 / 9;
}

/** One fact about the video as a soft chip. */
function Fact({ children }: { children: string }) {
  return (
    <Flex align="center" h="6" px="2.5" borderRadius="full" bg="bg.soft" color="fg.muted" fontSize="12px" fontVariantNumeric="tabular-nums">
      {children}
    </Flex>
  );
}

type SharedExport = ClipExportSnapshot & { expiresAt: string };

export function SharedExportClient({ exported, refreshExport }: { exported: SharedExport; refreshExport: (force?: boolean) => Promise<SharedExport> }) {
  const [error, setError] = useState<string | null>(null);
  const ready = exported.variants.filter(
    (variant) => variant.hasAsset && variant.downloadUrl,
  );
  const primary = ready[0];
  if (!primary) return <SharedClipUnavailable />;
  const playbackGrant: ReviewMediaGrant = { url: primary.previewUrl ?? primary.downloadUrl!, expiresAt: exported.expiresAt };
  const ratio = aspectNumber(primary.aspectRatio);
  const facts = [
    primary.aspectRatio,
    primary.resolution,
    primary.durationSec ? formatDuration(primary.durationSec) : null,
    formatBytes(primary.sizeBytes),
  ].filter((fact): fact is string => Boolean(fact));
  const panelRadius = { base: "0", md: "12px" } as const;

  return (
    <Flex direction="column" minH="100dvh" h={{ lg: "100dvh" }} bg="bg.sidebar" p={{ base: "0", md: "2" }} gap="2" as="main">
      <Flex flex="1" minH="0" gap="2" direction={{ base: "column", lg: "row" }}>
        {/* The clip, at its own shape, as large as the screen allows. */}
        <Flex flex="1" minW="0" align="center" justify="center" p={{ base: "4", md: "8" }} bg="bg" borderRadius={panelRadius}>
          <Flex flex={{ lg: "1" }} minH="0" w="full" h={{ lg: "full" }} maxH={{ lg: "860px" }} justify="center">
            <Box
              aspectRatio={ratio}
              h={{ base: "auto", lg: "full" }}
              w={{ base: "full", lg: "auto" }}
              maxW={{ base: ratio < 1 ? "420px" : "full", lg: "full" }}
              borderRadius="l3"
              overflow="hidden"
              bg="studio.canvas"
            >
              <Box asChild w="full" h="full">
                <ReviewPlaybackVideo
                  key={`${exported.id}:${primary.id}:preview`}
                  controls
                  controlsList="nodownload"
                  playsInline
                  preload="metadata"
                  grant={playbackGrant}
                  refreshGrant={async (force) => {
                    const fresh = await refreshExport(force);
                    const variant = fresh.variants.find((entry) => entry.id === primary.id);
                    const url = variant?.previewUrl ?? variant?.downloadUrl;
                    if (!url) throw new Error("This shared video is unavailable.");
                    return { url, expiresAt: fresh.expiresAt };
                  }}
                  onGrantError={() => setError("This video could not be loaded. Try opening the link again.")}
                  aria-label={`${primary.aspectRatio} shared video`}
                />
              </Box>
            </Box>
          </Flex>
        </Flex>

        <Flex w={{ base: "full", lg: "380px" }} flexShrink={0} direction="column" gap="6" p={{ base: "5", md: "6" }} bg="bg" borderRadius={panelRadius} overflowY="auto">
          <Stack gap="2">
            {error ? <Text role="alert" fontSize="13px" color="danger.fg">{error}</Text> : null}
            <Heading as="h1" textStyle="title" fontSize="22px" overflowWrap="anywhere">
              {exported.clipTitle}
            </Heading>
            <Text fontSize="13px" color="fg.muted">
              {exported.projectTitle} · {formatDate(exported.createdAt)}
            </Text>
          </Stack>

          <Flex gap="1.5" wrap="wrap">
            {facts.map((fact) => (
              <Fact key={fact}>{fact}</Fact>
            ))}
          </Flex>

          <Stack gap="2">
            {ready.map((variant, index) => (
              <Button
                key={variant.id}
                asChild
                size={index === 0 ? "lg" : "md"}
                variant={index === 0 ? "solid" : "subtle"}
                w="full"
              >
                <a
                  href={variant.downloadUrl ?? undefined}
                  download={`narriflow-${variant.aspectRatio.replace(":", "x")}.mp4`}
                  onClick={(event) => {
                    setError(null);
                    if (Date.parse(exported.expiresAt) > Date.now() + 30_000) return;
                    event.preventDefault();
                    void refreshExport().then((fresh) => {
                      const url = fresh.variants.find((entry) => entry.id === variant.id)?.downloadUrl;
                      if (!url) throw new Error("This download is unavailable. Try opening the link again.");
                      if (!(Date.parse(fresh.expiresAt) > Date.now())) throw new Error("This download link has expired. Try downloading again.");
                      window.location.assign(url);
                    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "This download could not be refreshed. Try again."));
                  }}
                >
                  <Download size={index === 0 ? 17 : 15} /> Download {variant.aspectRatio} · {variant.resolution}
                </a>
              </Button>
            ))}
          </Stack>

          <Flex gap="2" color="fg.subtle" align="flex-start">
            <Box mt="0.5" flexShrink={0}>
              <Lock size={13} aria-hidden />
            </Box>
            <Text fontSize="12px">
              Version {exported.editorRevision}. This link always shows exactly the version that was shared.
            </Text>
          </Flex>

          <Flex mt="auto" pt="2" align="center" gap="2" color="fg.subtle">
            <Text fontSize="12px">Made with</Text>
            <Link href="/" target="_blank" rel="noopener" aria-label="Narriflow">
              <Logo size="sm" />
            </Link>
          </Flex>
        </Flex>
      </Flex>
    </Flex>
  );
}
