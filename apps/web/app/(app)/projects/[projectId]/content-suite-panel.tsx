"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Box, Flex, Grid, Skeleton, Stack, Text } from "@chakra-ui/react";
import {
  AlertTriangle,
  AtSign,
  Check,
  Copy,
  FileText,
  Newspaper,
  NotebookText,
  Quote,
  Sparkles,
} from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Spinner } from "@narriflow/ui/components/spinner";
import {
  ALL_TEXT_OUTPUT_TYPES,
  TEXT_OUTPUT_TYPE_LABELS,
  userErrorMessage,
  type ContentAsset,
  type TextOutputType,
} from "@narriflow/validators";
import { PanelHeader } from "./panel-header";

/** What each output is, shown before and while it is written. */
const OUTPUT_DETAILS: Record<TextOutputType, { icon: ReactNode; description: string }> = {
  blog_post: {
    icon: <FileText size={16} />,
    description: "A full article written from the main points of the video.",
  },
  x_thread: {
    icon: <AtSign size={16} />,
    description: "A numbered thread, one point per post.",
  },
  newsletter_excerpt: {
    icon: <Newspaper size={16} />,
    description: "A LinkedIn or newsletter post that sends readers to the full video.",
  },
  show_notes: {
    icon: <NotebookText size={16} />,
    description: "A summary of the main moments for a video description or podcast feed.",
  },
  quote_cards: {
    icon: <Quote size={16} />,
    description: "Short lines that work as quote posts on their own.",
  },
};

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

/** Neutral bar used to sketch each format's shape. */
function Bar(props: { w: string; h?: string; accent?: boolean }) {
  return (
    <Box
      h={props.h ?? "1.5"}
      w={props.w}
      borderRadius="full"
      bg={props.accent ? "accent.muted" : "bg.softHover"}
      flexShrink={0}
    />
  );
}

/** A drawn sketch of what each output looks like — shape only, no content. */
function FormatSketch({ type }: { type: TextOutputType }) {
  switch (type) {
    case "blog_post":
      return (
        <Stack gap="2">
          <Box h="9" borderRadius="l1" bg="bg.soft" />
          <Bar w="78%" h="2" accent />
          <Bar w="100%" />
          <Bar w="92%" />
          <Bar w="60%" />
        </Stack>
      );
    case "x_thread":
      return (
        <Stack gap="2.5" position="relative">
          <Box position="absolute" left="7px" top="3" bottom="3" w="1px" bg="bg.softHover" />
          {(
            [
              ["90%", "64%"],
              ["82%", "48%"],
              ["70%", "55%"],
            ] as const
          ).map(([first, second]) => (
            <Flex key={first} gap="2.5" align="flex-start">
              <Box boxSize="4" borderRadius="full" bg="accent.muted" flexShrink={0} position="relative" />
              <Stack gap="1.5" flex="1" pt="0.5">
                <Bar w={first} />
                <Bar w={second} />
              </Stack>
            </Flex>
          ))}
        </Stack>
      );
    case "newsletter_excerpt":
      return (
        <Stack gap="2.5">
          <Flex gap="2" align="center">
            <Box boxSize="6" borderRadius="full" bg="accent.muted" />
            <Stack gap="1" flex="1">
              <Bar w="45%" h="2" />
              <Bar w="30%" />
            </Stack>
          </Flex>
          <Bar w="100%" />
          <Bar w="94%" />
          <Bar w="72%" />
          <Flex gap="1.5" pt="0.5">
            <Box boxSize="2.5" borderRadius="full" bg="bg.softHover" />
            <Box boxSize="2.5" borderRadius="full" bg="bg.softHover" />
            <Box boxSize="2.5" borderRadius="full" bg="bg.softHover" />
          </Flex>
        </Stack>
      );
    case "show_notes":
      return (
        <Stack gap="2.5">
          <Bar w="55%" h="2" accent />
          {["88%", "74%", "92%", "66%"].map((width) => (
            <Flex key={width} gap="2" align="center">
              <Box h="2" w="7" borderRadius="sm" bg="accent.muted" flexShrink={0} />
              <Bar w={width} />
            </Flex>
          ))}
        </Stack>
      );
    case "quote_cards":
      return (
        <Stack
          gap="2"
          align="center"
          justify="center"
          h="full"
          px="3"
          py="2.5"
          borderRadius="l1"
          bg="bg.soft"
        >
          <Box color="accent.fg" opacity={0.8}>
            <Quote size={16} />
          </Box>
          <Bar w="88%" h="2" />
          <Bar w="70%" h="2" />
          <Bar w="30%" />
        </Stack>
      );
  }
}

/** One card per output format — before generation, and while it is written. */
function FormatCard({ type, writing }: { type: TextOutputType; writing: boolean }) {
  return (
    <Stack
      gap="0"
      bg="bg.panel"
      borderWidth="1px"
      borderColor="border.card"
      borderRadius="l3"
      overflow="hidden"
    >
      <Box position="relative" h="148px" p="5" bg="bg.subtle">
        <Box h="full" animation={writing ? "pulse" : undefined}>
          <FormatSketch type={type} />
        </Box>
        {writing ? (
          <Flex
            position="absolute"
            top="3"
            insetEnd="3"
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
      <Stack gap="1" p="4">
        <Flex align="center" gap="2">
          <Box color="fg.muted" aria-hidden="true">
            {OUTPUT_DETAILS[type].icon}
          </Box>
          <Text fontSize="14px" fontWeight="550" color="fg">
            {TEXT_OUTPUT_TYPE_LABELS[type]}
          </Text>
        </Flex>
        <Text fontSize="13px" color="fg.muted" lineHeight="1.55">
          {OUTPUT_DETAILS[type].description}
        </Text>
      </Stack>
    </Stack>
  );
}

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
    <Stack
      gap="4"
      p="5"
      bg="bg.panel"
      borderWidth="1px"
      borderColor="border.card"
      borderRadius="l3"
    >
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
        <Button size="sm" variant="subtle" onClick={copy} flexShrink={0}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </Flex>
      <Box
        flex="1"
        maxH="300px"
        overflowY="auto"
        borderRadius="l2"
        bg="bg.soft"
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
}: {
  projectId: string;
  transcriptReady: boolean;
}) {
  const [assets, setAssets] = useState<ContentAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!transcriptReady) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/content-suite`);
        const json = (await res.json().catch(() => ({}))) as {
          assets?: ContentAsset[];
          message?: string;
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok) {
          setError(
            json.message ??
              userErrorMessage(json.error) ??
              "Could not load repurposed content.",
          );
          return;
        }
        if (json.assets) setAssets(json.assets);
      } catch (err) {
        console.warn(JSON.stringify({ level: "error", message: "content_suite_load_failed", errorName: err instanceof Error ? err.name : "UnknownError" }));
        if (!cancelled) setError("Could not load repurposed content.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, transcriptReady]);

  const generate = useCallback(async () => {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/content-suite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = (await res.json().catch(() => ({}))) as {
        assets?: ContentAsset[];
        message?: string;
        error?: string;
      };
      if (!res.ok || !json.assets) {
        throw new Error(
          json.message ??
            userErrorMessage(json.error) ??
            "Could not generate repurposed content.",
        );
      }
      setAssets(json.assets);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setGenerating(false);
    }
  }, [projectId]);

  if (!transcriptReady) return null;

  const showFormats = !loading && assets.length === 0;

  return (
    <Stack gap="6">
      <PanelHeader
        icon={<Sparkles size={20} />}
        title="Repurpose"
        description="Write a blog post, an X thread, a LinkedIn post, show notes and quote cards from this transcript in one go."
        actions={
          <Button
            size="sm"
            variant={assets.length > 0 ? "subtle" : "solid"}
            onClick={generate}
            disabled={generating || loading}
          >
            {generating ? <Spinner size="xs" /> : <Sparkles size={14} />}
            {generating
              ? "Generating…"
              : assets.length > 0
                ? "Regenerate"
                : "Generate assets"}
          </Button>
        }
      />

      {error ? (
        <Flex
          role="alert"
          align="center"
          gap="2"
          color="danger.fg"
          borderStartWidth="3px"
          borderColor="danger.solid"
          ps="3"
          py="2"
        >
          <AlertTriangle size={14} aria-hidden />
          <Text fontSize="sm">{error}</Text>
        </Flex>
      ) : null}

      {loading ? (
        <Grid templateColumns={{ base: "1fr", md: "repeat(2, minmax(0, 1fr))", xl: "repeat(3, minmax(0, 1fr))" }} gap="4">
          {ALL_TEXT_OUTPUT_TYPES.slice(0, 3).map((type) => (
            <Skeleton key={type} variant="pulse" bg="bg.muted" h="40" borderRadius="l3" />
          ))}
        </Grid>
      ) : null}

      {showFormats ? (
        <Grid
          templateColumns={{
            base: "1fr",
            sm: "repeat(2, minmax(0, 1fr))",
            lg: "repeat(3, minmax(0, 1fr))",
            xl: "repeat(5, minmax(0, 1fr))",
          }}
          gap="4"
        >
          {ALL_TEXT_OUTPUT_TYPES.map((type) => (
            <FormatCard key={type} type={type} writing={generating} />
          ))}
        </Grid>
      ) : null}

      {assets.length > 0 ? (
        <Grid templateColumns={{ base: "1fr", xl: "repeat(2, minmax(0, 1fr))" }} gap="4" alignItems="stretch">
          {assets.map((asset) => (
            <AssetRow key={asset.id} asset={asset} />
          ))}
        </Grid>
      ) : null}
    </Stack>
  );
}
