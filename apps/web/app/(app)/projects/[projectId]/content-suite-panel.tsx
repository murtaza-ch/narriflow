"use client";

import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import { Box, Flex, Grid, Skeleton, Stack, Text } from "@chakra-ui/react";
import {
  AlertTriangle,
  AtSign,
  Check,
  Copy,
  FileText,
  MessageCircle,
  Newspaper,
  NotebookText,
  Quote,
  Repeat2,
  Send,
  Sparkles,
  ThumbsUp,
} from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Spinner } from "@narriflow/ui/components/spinner";
import {
  ALL_TEXT_OUTPUT_TYPES,
  TEXT_OUTPUT_TYPE_LABELS,
  type ContentAsset,
  type TextOutputType,
} from "@narriflow/validators";
import { PanelHeader } from "./panel-header";
import { PlanLimitNotice } from "../../_components/plan-limit-notice";
import { LockedButton, useUpgrade, type UpgradePrompt } from "../../_components/upgrade";
import { STALE_TIME, isApiError, scopedKey, type WorkspaceScope } from "@narriflow/api-client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { upgradePromptFromFailure } from "@/lib/authenticated-request-browser";
import { requireClipApi, useClipApi } from "@/lib/clip-media";
import { browserFailureFromApiError } from "@/lib/publishing-client";
import { clipActionErrorCopy } from "./clip-action-error-copy";

const NO_ASSETS: ContentAsset[] = [];

function contentSuiteKey(scope: WorkspaceScope, projectId: string) {
  return scopedKey(scope, "projects", "content-suite", projectId);
}

/** What each output is, shown before and while it is written. Each line states what the writer is asked for. */
const OUTPUT_DETAILS: Record<TextOutputType, { icon: ReactNode; description: string }> = {
  blog_post: {
    icon: <FileText size={16} />,
    description: "An article with a title and sections.",
  },
  x_thread: {
    icon: <AtSign size={16} />,
    description: "A numbered thread, one idea per post.",
  },
  newsletter_excerpt: {
    icon: <Newspaper size={16} />,
    description: "A short post that ends with a question.",
  },
  show_notes: {
    icon: <NotebookText size={16} />,
    description: "A summary, timestamps and key takeaways.",
  },
  quote_cards: {
    icon: <Quote size={16} />,
    description: "Three to five quotable lines.",
  },
};

/** The clip-tile gradients, reused for avatars and covers in the mockups. */
const COVER = "linear-gradient(140deg,#c1d2f2,#5c6c96)";
const QUOTE_FRONT = "linear-gradient(135deg,#8cace0,#31486f)";
const QUOTE_BACK = "linear-gradient(140deg,#c9bcf0,#74619e)";

function TypeTile({ type }: { type: string }) {
  return (
    <Flex
      boxSize="9"
      flexShrink={0}
      align="center"
      justify="center"
      borderRadius="full"
      bg="bg.soft"
      color="fg.muted"
      aria-hidden="true"
    >
      {OUTPUT_DETAILS[type as TextOutputType]?.icon ?? <FileText size={16} />}
    </Flex>
  );
}

/** A line of text inside a mockup: a darker headline or a lighter body line. */
function Line(props: { w: string; headline?: boolean }) {
  return (
    <Box
      h={props.headline ? "7px" : "5px"}
      w={props.w}
      borderRadius="full"
      bg={props.headline ? "fg" : "bg.muted"}
      opacity={props.headline ? 0.8 : 1}
      flexShrink={0}
    />
  );
}

/** The white page every text format is drawn on. */
function Page({ children }: { children: ReactNode }) {
  return (
    <Box h="full" bg="bg.panel" borderRadius="l2" p="3.5" overflow="hidden">
      {children}
    </Box>
  );
}

const THREAD_POSTS = [
  { n: 1, widths: ["100%", "72%"] },
  { n: 2, widths: ["96%", "58%"] },
  { n: 3, widths: ["100%", "66%"] },
] as const;

const SHOW_NOTE_MOMENTS = [
  { time: "00:14", w: "78%" },
  { time: "02:31", w: "64%" },
  { time: "05:08", w: "86%" },
] as const;

/** A small mockup of what each output looks like when it is written. */
function FormatSketch({ type }: { type: TextOutputType }) {
  switch (type) {
    case "blog_post":
      return (
        <Page>
          <Stack gap="2">
            <Box h="46px" borderRadius="l1" background={COVER} />
            <Line w="86%" headline />
            <Stack gap="1.5" pt="0.5">
              <Line w="100%" />
              <Line w="94%" />
              <Line w="68%" />
            </Stack>
          </Stack>
        </Page>
      );
    case "x_thread":
      return (
        <Page>
          <Stack gap="0">
            {THREAD_POSTS.map((post, index) => (
              <Flex key={post.n} gap="2.5">
                <Flex direction="column" align="center" flexShrink={0}>
                  <Box boxSize="5" borderRadius="full" background={COVER} />
                  {index < THREAD_POSTS.length - 1 ? <Box flex="1" w="1.5px" my="1" bg="accent.muted" /> : null}
                </Flex>
                <Stack gap="1.5" flex="1" minW="0" pt="0.5" pb={index < THREAD_POSTS.length - 1 ? "2.5" : "0"}>
                  <Flex align="center" gap="1.5">
                    <Text
                      fontSize="10px"
                      fontWeight="600"
                      lineHeight="1"
                      color="accent.fg"
                      fontVariantNumeric="tabular-nums"
                    >
                      {post.n}/
                    </Text>
                    <Line w="40%" headline />
                  </Flex>
                  {post.widths.map((width) => (
                    <Line key={width} w={width} />
                  ))}
                </Stack>
              </Flex>
            ))}
          </Stack>
        </Page>
      );
    case "newsletter_excerpt":
      return (
        <Page>
          <Stack gap="2.5">
            <Flex gap="2" align="center">
              <Box boxSize="6" borderRadius="full" background={COVER} flexShrink={0} />
              <Stack gap="1.5" flex="1">
                <Line w="48%" headline />
                <Line w="30%" />
              </Stack>
            </Flex>
            <Stack gap="1.5">
              <Line w="100%" />
              <Line w="96%" />
              <Line w="82%" />
              <Line w="54%" />
            </Stack>
            <Flex gap="3.5" align="center" color="fg.subtle" pt="0.5">
              <Box color="accent.fg">
                <ThumbsUp size={12} />
              </Box>
              <MessageCircle size={12} />
              <Repeat2 size={13} />
              <Send size={12} />
            </Flex>
          </Stack>
        </Page>
      );
    case "show_notes":
      return (
        <Page>
          <Stack gap="2.5">
            <Line w="52%" headline />
            <Stack gap="1.5">
              <Line w="100%" />
              <Line w="82%" />
            </Stack>
            <Stack gap="2">
              {SHOW_NOTE_MOMENTS.map((moment) => (
                <Flex key={moment.time} align="center" gap="2">
                  <Text
                    textStyle="data"
                    fontSize="9.5px"
                    lineHeight="1"
                    px="1.5"
                    py="1"
                    borderRadius="sm"
                    bg="accent.subtle"
                    color="accent.fg"
                  >
                    {moment.time}
                  </Text>
                  <Line w={moment.w} />
                </Flex>
              ))}
            </Stack>
          </Stack>
        </Page>
      );
    case "quote_cards":
      return (
        <Box position="relative" h="full">
          <Box
            position="absolute"
            top="3"
            bottom="0"
            insetStart="9"
            insetEnd="0"
            borderRadius="l2"
            background={QUOTE_BACK}
          />
          <Flex
            position="absolute"
            top="0"
            bottom="3"
            insetStart="0"
            insetEnd="9"
            direction="column"
            justify="space-between"
            px="3.5"
            py="3"
            borderRadius="l2"
            background={QUOTE_FRONT}
            color="white"
          >
            <Text aria-hidden="true" fontSize="44px" fontWeight="700" lineHeight="0.8" opacity={0.85}>
              &ldquo;
            </Text>
            <Stack gap="1.5">
              <Box h="8px" w="92%" borderRadius="full" bg="white" opacity={0.92} />
              <Box h="8px" w="64%" borderRadius="full" bg="white" opacity={0.92} />
              <Box h="4px" w="32%" mt="1" borderRadius="full" bg="white" opacity={0.5} />
            </Stack>
          </Flex>
        </Box>
      );
  }
}

/** One card per output format — before generation, and while it is written. */
function FormatCard({ type, writing }: { type: TextOutputType; writing: boolean }) {
  return (
    <Stack gap="3" bg="bg.subtle" borderRadius="l3" p="3" transition="background 120ms ease" _hover={{ bg: "bg.muted" }}>
      <Box position="relative" h="156px">
        <Box h="full" animation={writing ? "pulse" : undefined}>
          <FormatSketch type={type} />
        </Box>
        {writing ? (
          <Flex
            position="absolute"
            top="2"
            insetEnd="2"
            align="center"
            gap="1.5"
            px="2"
            py="1"
            borderRadius="full"
            bg="accent.subtle"
            color="accent.fg"
            fontSize="11px"
          >
            <Spinner size="xs" />
            Writing…
          </Flex>
        ) : null}
      </Box>
      <Stack gap="1" px="2" pb="1.5">
        <Flex align="center" gap="2">
          <Box color="fg.muted" aria-hidden="true">
            {OUTPUT_DETAILS[type].icon}
          </Box>
          <Text fontSize="14px" fontWeight="550" color="fg">
            {TEXT_OUTPUT_TYPE_LABELS[type]}
          </Text>
        </Flex>
        <Text fontSize="13px" color="fg.muted" lineHeight="1.5">
          {OUTPUT_DETAILS[type].description}
        </Text>
      </Stack>
    </Stack>
  );
}

const FORMAT_COLUMNS = {
  base: "1fr",
  sm: "repeat(2, minmax(0, 1fr))",
  lg: "repeat(3, minmax(0, 1fr))",
  xl: "repeat(5, minmax(0, 1fr))",
} as const;

function labelFor(type: string): string {
  return (
    TEXT_OUTPUT_TYPE_LABELS[type as TextOutputType] ??
    type.replace(/_/g, " ")
  );
}

function AssetRow({ asset }: { asset: ContentAsset }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(asset.body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — ignore */
    }
  }, [asset.body]);

  const wordCount = asset.body.split(/\s+/).filter(Boolean).length;

  return (
    <Stack gap="4" p="5" bg="bg.subtle" borderRadius="l3">
      <Flex align="center" justify="space-between" gap="3">
        <Flex align="center" gap="3" minW="0">
          <TypeTile type={asset.type} />
          <Box minW="0">
            <Text textStyle="eyebrow" color="fg.muted">
              {labelFor(asset.type)}
            </Text>
            <Text fontSize="14px" fontWeight="550" color="fg" truncate>
              {asset.title}
            </Text>
          </Box>
        </Flex>
        <Button
          size="sm"
          variant="subtle"
          onClick={copy}
          flexShrink={0}
          aria-live="polite"
          bg={copied ? "accent.subtle" : undefined}
          color={copied ? "accent.fg" : undefined}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </Flex>
      <Box
        flex="1"
        maxH="300px"
        overflowY="auto"
        borderRadius="l2"
        bg="bg.panel"
        px="4"
        py="3.5"
        fontSize="13px"
        color="fg.muted"
        lineHeight="1.65"
        whiteSpace="pre-wrap"
        css={{ fontVariantLigatures: "none" }}
      >
        {asset.body}
      </Box>
      <Text fontSize="12px" fontVariantNumeric="tabular-nums" color="fg.subtle">
        {wordCount.toLocaleString()} words
      </Text>
    </Stack>
  );
}

export function ContentSuitePanel({
  projectId,
  transcriptReady,
  planRequirement,
  upgrade,
  canEdit,
}: {
  projectId: string;
  transcriptReady: boolean;
  /** Why the plan can't generate, computed server-side; `null` when it can. */
  planRequirement: string | null;
  /** The plan that unlocks generation; `null` when the plan already allows it. */
  upgrade: UpgradePrompt | null;
  /** Role and workspace status allow generating; otherwise written assets are read-only. */
  canEdit: boolean;
}) {
  const { openUpgrade } = useUpgrade();
  const api = useClipApi();
  const [error, setError] = useState<string | null>(null);

  // Written assets of this Project; the generate command replaces them wholesale.
  const key = api ? contentSuiteKey(api.scope, projectId) : null;
  const list = useQuery({
    queryKey: key ?? ["nf", "content-suite", "no-workspace"],
    enabled: transcriptReady && api !== null,
    staleTime: STALE_TIME.default,
    queryFn: async ({ signal }) => {
      const { projects } = requireClipApi(api);
      const response = await projects.projects[":id"]["content-suite"].$get(
        { param: { id: projectId } },
        { init: { signal } },
      );
      return (await response.json()).assets as ContentAsset[];
    },
  });
  const assets = list.data ?? NO_ASSETS;
  const loading = transcriptReady && list.isPending;
  const loadError = list.isError ? "Could not load repurposed content." : null;

  const generate = useMutation({
    mutationFn: async () => {
      const { projects, queryClient, scope } = requireClipApi(api);
      const response = await projects.projects[":id"]["content-suite"].$post({ param: { id: projectId }, json: {} });
      const written = (await response.json()).assets as ContentAsset[];
      queryClient.setQueryData(contentSuiteKey(scope, projectId), written);
    },
    onMutate: () => setError(null),
    onError: (failure) => {
      if (isApiError(failure) && failure.status === 402) {
        const prompt = upgradePromptFromFailure(browserFailureFromApiError(failure));
        if (prompt) openUpgrade(prompt);
      }
      setError(clipActionErrorCopy(failure, "Could not generate repurposed content."));
    },
  });
  const generating = generate.isPending;
  const shownError = error ?? loadError;

  if (!transcriptReady) return null;

  const showFormats = !loading && assets.length === 0;

  return (
    <Stack gap="6">
      <PanelHeader
        icon={<Sparkles size={20} />}
        title="Repurpose"
        description="Five written formats from the transcript, generated together."
        actions={
          !canEdit ? null : planRequirement !== null && upgrade?.tier ? (
            <LockedButton size="sm" variant={assets.length > 0 ? "subtle" : "solid"} prompt={upgrade}>
              <Sparkles size={14} />
              {assets.length > 0 ? "Regenerate" : "Generate assets"}
            </LockedButton>
          ) : (
            <Button
              size="sm"
              variant={assets.length > 0 ? "subtle" : "solid"}
              onClick={() => generate.mutate()}
              disabled={generating || loading || planRequirement !== null}
            >
              {generating ? <Spinner size="xs" /> : <Sparkles size={14} />}
              {generating
                ? "Generating…"
                : assets.length > 0
                  ? "Regenerate"
                  : "Generate assets"}
            </Button>
          )
        }
      />

      {canEdit ? <PlanLimitNotice message={planRequirement} upgrade={upgrade} /> : null}

      {shownError ? (
        <Flex
          role="alert"
          align="center"
          gap="2.5"
          bg="danger.subtle"
          color="danger.fg"
          borderRadius="l2"
          px="4"
          py="3"
        >
          <AlertTriangle size={15} aria-hidden />
          <Text fontSize="13px">{shownError}</Text>
        </Flex>
      ) : null}

      {loading ? (
        <Grid templateColumns={FORMAT_COLUMNS} gap="4">
          {ALL_TEXT_OUTPUT_TYPES.map((type) => (
            <Skeleton key={type} variant="pulse" bg="bg.subtle" h="64" borderRadius="l3" />
          ))}
        </Grid>
      ) : null}

      {showFormats ? (
        <Grid templateColumns={FORMAT_COLUMNS} gap="4">
          {ALL_TEXT_OUTPUT_TYPES.map((type) => (
            <FormatCard key={type} type={type} writing={generating} />
          ))}
        </Grid>
      ) : null}

      {assets.length > 0 ? (
        <Grid
          templateColumns={{ base: "1fr", xl: "repeat(2, minmax(0, 1fr))" }}
          gap="4"
          alignItems="stretch"
          opacity={generating ? 0.55 : 1}
          transition="opacity 160ms ease"
        >
          {assets.map((asset) => (
            <AssetRow key={asset.id} asset={asset} />
          ))}
        </Grid>
      ) : null}
    </Stack>
  );
}
