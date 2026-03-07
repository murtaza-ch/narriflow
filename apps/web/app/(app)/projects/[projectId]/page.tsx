import { notFound } from "next/navigation";
import { randomUUID } from "node:crypto";
import { Button } from "@narriflow/ui/components/button";
import { requireCurrentAppUser } from "@narriflow/auth";
import { projectService } from "@narriflow/services";
import { ProjectEvents } from "./project-events";
import { queueTranscriptionFormAction } from "../actions";
import { TranscriptPanel } from "./transcript-panel";
import { Stack, Box, Heading, Text, Flex } from "@chakra-ui/react";

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
    <Box as="section">
      <Stack gap="8">
        <Stack gap="2">
          <Heading size="xl" fontWeight="semibold" letterSpacing="tight">
            {snapshot.project.title}
          </Heading>
          <Text textStyle="sm" color="fg.muted">
            {snapshot.project.sourceMediaUrl}
          </Text>
          <Text textStyle="sm" color="fg.muted">
            Source: {snapshot.project.sourceType} - Ingest status:{" "}
            {snapshot.project.ingestStatus}
          </Text>
          {snapshot.project.ingestErrorCode ? (
            <Text textStyle="sm" color="red.500">
              Last ingest error: {snapshot.project.ingestErrorCode}
            </Text>
          ) : null}
        </Stack>

        <form action={queueTranscriptionFormAction}>
          <Box
            rounded="xl"
            borderWidth="1px"
            borderColor="border"
            p="6"
          >
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="idempotencyKey" value={randomUUID()} />
            <Flex align="center" justify="space-between" gap="4">
              <Box>
                <Text textStyle="sm" fontWeight="medium">AI Transcription</Text>
                <Text textStyle="xs" color="fg.muted">
                  Queue the `stt` workflow stage and persist a read-only transcript
                  with subtitle exports.
                </Text>
                {!isIngestReady ? (
                  <Text mt="1" textStyle="xs" color="orange.500">
                    Transcription is disabled until ingest is ready.
                  </Text>
                ) : null}
              </Box>
              <Button
                disabled={!isIngestReady || transcriptReady || transcriptInFlight}
                type="submit"
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
    </Box>
  );
}
