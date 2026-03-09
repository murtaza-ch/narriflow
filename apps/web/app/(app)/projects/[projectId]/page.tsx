import { notFound } from "next/navigation";
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { Button } from "@narriflow/ui/components/button";
import { StatusBadge } from "@narriflow/ui/components/status-badge";
import { requireCurrentAppUser } from "@narriflow/auth";
import { projectService } from "@narriflow/services";
import { ProjectEvents } from "./project-events";
import { queueTranscriptionFormAction } from "../actions";
import { TranscriptPanel } from "./transcript-panel";
import { Stack, Box, Heading, Text, Flex } from "@chakra-ui/react";
import { ChevronRight } from "lucide-react";

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const appUser = await requireCurrentAppUser();
  const { projectId } = await params;
  const [snapshot, transcript] = await Promise.all([
    projectService.getProjectSnapshot(appUser.id, projectId),
    projectService.getTranscriptSnapshot(appUser.id, projectId),
  ]);

  if (!snapshot.project) {
    notFound();
  }

  const isIngestReady = snapshot.project.ingestStatus === "ready";
  const transcriptReady = transcript?.status === "completed";
  const transcriptInFlight =
    transcript?.status === "queued" || transcript?.status === "processing";

  return (
    <Stack gap="32px">
      {/* Breadcrumb */}
      <Flex align="center" gap="6px" fontSize="13px" color="fg.muted">
        <Link href="/projects">
          <Text _hover={{ color: "fg" }} transition="color 150ms ease">Projects</Text>
        </Link>
        <ChevronRight size={14} />
        <Text color="fg" fontWeight="500" truncate>{snapshot.project.title}</Text>
      </Flex>

      {/* Header */}
      <Stack gap="8px">
        <Flex align="center" gap="12px">
          <Heading size="xl" fontWeight="600" letterSpacing="-0.02em">
            {snapshot.project.title}
          </Heading>
          <StatusBadge
            status={snapshot.project.ingestStatus as "queued" | "processing" | "ready" | "failed"}
          />
        </Flex>
        <Text fontSize="13px" color="fg.muted">
          {snapshot.project.sourceMediaUrl}
        </Text>
        <Text fontSize="13px" color="fg.subtle">
          Source: {snapshot.project.sourceType}
        </Text>
        {snapshot.project.ingestErrorCode && (
          <Text fontSize="13px" color="danger.fg">
            Last ingest error: {snapshot.project.ingestErrorCode}
          </Text>
        )}
      </Stack>

      {/* Transcription card */}
      <form action={queueTranscriptionFormAction}>
        <Box
          borderRadius="12px"
          borderWidth="1px"
          borderColor="border"
          bg="bg.panel"
          p="20px"
        >
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="idempotencyKey" value={randomUUID()} />
          <Flex align="center" justify="space-between" gap="16px">
            <Box>
              <Text fontSize="14px" fontWeight="500" color="fg">
                AI Transcription
              </Text>
              <Text fontSize="13px" color="fg.muted" mt="2px">
                Queue the transcription workflow and persist subtitle exports.
              </Text>
              {!isIngestReady && (
                <Text mt="4px" fontSize="12px" color="warning.fg">
                  Transcription is disabled until ingest is ready.
                </Text>
              )}
            </Box>
            <Button
              disabled={!isIngestReady || transcriptReady || transcriptInFlight}
              type="submit"
              size="sm"
              flexShrink={0}
            >
              {transcriptReady
                ? "Transcript Ready"
                : transcriptInFlight
                  ? "Transcribing..."
                  : "Start Transcription"}
            </Button>
          </Flex>
        </Box>
      </form>

      <TranscriptPanel projectId={projectId} transcript={transcript} />

      <ProjectEvents projectId={projectId} initialSeq={snapshot.lastSeq} />
    </Stack>
  );
}
