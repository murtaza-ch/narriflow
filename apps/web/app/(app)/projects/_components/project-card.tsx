"use client";

import Link from "next/link";
import { Box, Flex, HStack, Separator, Text } from "@chakra-ui/react";
import {
  Clock3,
  Film,
  Languages,
  TrendingUp,
  UsersRound,
} from "lucide-react";
import type { ProjectListItem } from "@narriflow/services";
import { ProjectThumbnail } from "./project-thumbnail";
import { formatDuration } from "../_lib/format";

interface ProjectCardProps {
  project: ProjectListItem;
}

interface StatusConfigEntry {
  label: string;
  dot: string;
  text: string;
  pulse?: boolean;
}

const STATUS_CONFIG: Record<string, StatusConfigEntry> = {
  ready: { label: "Ready", dot: "success.solid", text: "success.fg" },
  processing: {
    label: "Processing",
    dot: "accent.solid",
    text: "accent.fg",
    pulse: true,
  },
  queued: { label: "Queued", dot: "fg.subtle", text: "fg.muted" },
  pending: { label: "Pending", dot: "fg.subtle", text: "fg.muted" },
  uploading: {
    label: "Uploading",
    dot: "accent.solid",
    text: "accent.fg",
    pulse: true,
  },
  downloading: {
    label: "Downloading",
    dot: "accent.solid",
    text: "accent.fg",
    pulse: true,
  },
  normalizing: {
    label: "Normalizing",
    dot: "accent.solid",
    text: "accent.fg",
    pulse: true,
  },
  failed: { label: "Failed", dot: "danger.solid", text: "danger.fg" },
};

export function ProjectCard({ project }: ProjectCardProps) {
  const status =
    STATUS_CONFIG[project.ingestStatus] ?? STATUS_CONFIG.queued!;

  const transcriptMeta = buildTranscriptMeta(project);
  const scoreColor = scoreColorFor(project.avgViralityScore);

  return (
    <Link
      href={`/projects/${project.id}`}
      style={{ textDecoration: "none", display: "block" }}
      className="project-card-link"
    >
      <Box
        position="relative"
        overflow="hidden"
        borderRadius="14px"
        borderWidth="1px"
        borderColor="border"
        bg="bg.panel"
        css={{
          "&:hover .project-thumb-img": {
            transform: "scale(1.04)",
          },
        }}
      >
        <ProjectThumbnail project={project} />

        <Box p="16px">
          <HStack gap="6px" mb="10px">
            <Box
              w="6px"
              h="6px"
              borderRadius="full"
              bg={status.dot}
              flexShrink={0}
              animation={
                status.pulse ? "pulse 2s ease-in-out infinite" : undefined
              }
            />
            <Text
              fontFamily="mono"
              fontSize="10px"
              fontWeight="500"
              letterSpacing="0.1em"
              textTransform="uppercase"
              color={status.text}
            >
              {status.label}
            </Text>
          </HStack>

          <Text
            fontSize="15px"
            fontWeight="600"
            color="fg"
            letterSpacing="-0.01em"
            lineHeight="1.35"
            css={{
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
              minHeight: "2.7em",
            }}
          >
            {project.title}
          </Text>

          <Box mt="10px" minH="18px">
            {transcriptMeta.kind === "ready" ? (
              <HStack gap="10px" color="fg.subtle">
                {transcriptMeta.language ? (
                  <MetaIcon
                    icon={<Languages size={11} strokeWidth={2} />}
                    label={transcriptMeta.language}
                  />
                ) : null}
                {transcriptMeta.speakers ? (
                  <MetaIcon
                    icon={<UsersRound size={11} strokeWidth={2} />}
                    label={transcriptMeta.speakers}
                  />
                ) : null}
                {transcriptMeta.duration ? (
                  <MetaIcon
                    icon={<Clock3 size={11} strokeWidth={2} />}
                    label={transcriptMeta.duration}
                  />
                ) : null}
              </HStack>
            ) : (
              <Text
                fontFamily="mono"
                fontSize="11px"
                color="fg.subtle"
                letterSpacing="0.02em"
                truncate
              >
                {transcriptMeta.text}
              </Text>
            )}
          </Box>

          <Separator my="14px" borderColor="border.subtle" />

          <Flex align="center" justify="space-between">
            <HStack gap="6px" color="fg.muted">
              <Film size={12} strokeWidth={2} />
              <Text fontSize="12px" color="fg.muted">
                {project.clipCount === 0
                  ? "No clips yet"
                  : `${project.clipCount} ${project.clipCount === 1 ? "clip" : "clips"}`}
              </Text>
            </HStack>

            {project.avgViralityScore !== null ? (
              <HStack gap="5px">
                <Box color="var(--chakra-colors-fg-muted)">
                  <TrendingUp size={12} strokeWidth={2} />
                </Box>
                <Text
                  fontFamily="mono"
                  fontSize="11px"
                  fontWeight="600"
                  color={scoreColor}
                  letterSpacing="0.02em"
                >
                  avg {Math.round(project.avgViralityScore)}
                </Text>
              </HStack>
            ) : (
              <Text fontFamily="mono" fontSize="11px" color="fg.subtle">
                —
              </Text>
            )}
          </Flex>
        </Box>
      </Box>
    </Link>
  );
}

function MetaIcon({
  icon,
  label,
}: {
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <HStack gap="4px">
      {icon}
      <Text
        fontFamily="mono"
        fontSize="11px"
        color="fg.subtle"
        letterSpacing="0.02em"
        lineHeight="1"
      >
        {label}
      </Text>
    </HStack>
  );
}

type TranscriptMeta =
  | {
      kind: "ready";
      language: string | null;
      speakers: string | null;
      duration: string | null;
    }
  | { kind: "text"; text: string };

function buildTranscriptMeta(project: ProjectListItem): TranscriptMeta {
  const transcript = project.transcript;
  const fallbackDuration = formatDuration(project.sourceDurationSeconds);

  if (!transcript || transcript.status !== "completed") {
    if (transcript?.status === "processing") {
      return { kind: "text", text: "Transcribing…" };
    }
    if (transcript?.status === "queued") {
      return { kind: "text", text: "Transcript queued" };
    }
    if (transcript?.status === "failed") {
      return { kind: "text", text: "Transcript failed" };
    }
    if (fallbackDuration) {
      return { kind: "text", text: `Awaiting transcript · ${fallbackDuration}` };
    }
    return { kind: "text", text: "Awaiting transcript" };
  }

  const language = transcript.languageCode
    ? transcript.languageCode.toUpperCase()
    : null;
  const speakers =
    typeof transcript.speakerCount === "number" && transcript.speakerCount > 0
      ? `${transcript.speakerCount}`
      : null;
  const duration =
    formatDuration(transcript.durationSeconds) ?? fallbackDuration;

  if (!language && !speakers && !duration) {
    return { kind: "text", text: "Transcript ready" };
  }

  return { kind: "ready", language, speakers, duration };
}

function scoreColorFor(score: number | null): string {
  if (score === null) return "fg.muted";
  const rounded = Math.round(score);
  if (rounded >= 80) return "success.fg";
  if (rounded >= 60) return "fg";
  return "fg.muted";
}
