"use client";

import { useCallback, useEffect, useState } from "react";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { AlertTriangle, Sparkles, Copy, Check, FileText } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Spinner } from "@narriflow/ui/components/spinner";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import {
  TEXT_OUTPUT_TYPE_LABELS,
  userErrorMessage,
  type ContentAsset,
  type TextOutputType,
} from "@narriflow/validators";

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

  return (
    <Box borderBottomWidth="1px" borderColor="border.subtle" py="3">
      <Flex align="center" justify="space-between" gap="3" mb="2">
        <Flex align="center" gap="2" minW="0">
          <Box color="fg.subtle" flexShrink={0}>
            <FileText size={14} aria-hidden />
          </Box>
          <Box minW="0">
            <Text textStyle="eyebrow" color="fg.subtle">
              {labelFor(asset.type)}
            </Text>
            <Text fontSize="sm" fontWeight="600" color="fg" truncate>
              {asset.title}
            </Text>
          </Box>
        </Flex>
        <Button size="xs" variant="outline" onClick={copy} flexShrink={0}>
          {copied ? <Check size={12} /> : <Copy size={12} />}
          <Text ms="1.5">{copied ? "Copied" : "Copy"}</Text>
        </Button>
      </Flex>
      <Box
        maxH="280px"
        overflowY="auto"
        borderRadius="l1"
        borderWidth="1px"
        borderColor="border"
        bg="bg.subtle"
        px="4"
        py="3"
        fontSize="13px"
        color="fg.muted"
        lineHeight="1.6"
        whiteSpace="pre-wrap"
        css={{ fontVariantLigatures: "none" }}
      >
        {asset.body}
      </Box>
    </Box>
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

  return (
    <Box layerStyle="band">
      <Stack gap="4">
        <Flex align="flex-start" justify="space-between" gap="4" wrap="wrap">
          <Box minW="0">
            <Text textStyle="eyebrow" color="fg.subtle">
              Repurpose
            </Text>
            <Text mt="0.5" fontSize="xs" color="fg.muted">
              Turn the transcript into a blog post, X thread, LinkedIn post,
              show notes and quote cards.
            </Text>
          </Box>
          <Button
            size="sm"
            variant="outline"
            onClick={generate}
            disabled={generating}
            flexShrink={0}
          >
            {generating ? <Spinner size="xs" /> : <Sparkles size={13} />}
            <Text ms="1.5">
              {generating
                ? "Generating…"
                : assets.length > 0
                  ? "Regenerate"
                  : "Generate assets"}
            </Text>
          </Button>
        </Flex>

        {error ? (
          <Flex
            align="center"
            gap="2"
            borderRadius="l1"
            borderWidth="1px"
            borderColor="danger.muted"
            bg="danger.subtle"
            px="3.5"
            py="2.5"
            color="danger.fg"
          >
            <AlertTriangle size={14} aria-hidden />
            <Text fontSize="13px">{error}</Text>
          </Flex>
        ) : null}

        {!loading && assets.length === 0 && !generating ? (
          <EmptyState
            icon={<FileText size={22} aria-hidden />}
            title="No repurposed content yet"
            description="Turn your transcript into posts, show notes, and quote cards."
          />
        ) : null}

        {generating && assets.length === 0 ? (
          <Flex
            align="center"
            justify="center"
            gap="2"
            py="7"
            borderTopWidth="1px"
            borderBottomWidth="1px"
            borderColor="border.subtle"
          >
            <Box w="6px" h="6px" borderRadius="2px" bg="accent.solid" />
            <Text fontSize="13px" color="fg.muted">
              Writing your blog post, thread, LinkedIn post, show notes and quote
              cards…
            </Text>
          </Flex>
        ) : null}

        {assets.length > 0 ? (
          <Stack gap="0" borderTopWidth="1px" borderColor="border.subtle">
            {assets.map((asset) => (
              <AssetRow key={asset.id} asset={asset} />
            ))}
          </Stack>
        ) : null}
      </Stack>
    </Box>
  );
}
