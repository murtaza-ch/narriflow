import { Button } from "@narriflow/ui/components/button";
import type { TranscriptSnapshot } from "@narriflow/validators";
import { Stack, Box, Flex, Heading, Text } from "@chakra-ui/react";

function formatTimestamp(totalSeconds: number) {
  const safeSeconds = Math.max(0, totalSeconds);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = Math.floor(safeSeconds % 60);

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function TranscriptPanel({
  projectId,
  transcript,
}: {
  projectId: string;
  transcript: TranscriptSnapshot | null;
}) {
  if (!transcript) {
    return (
      <Box as="section" rounded="xl" borderWidth="1px" borderColor="border" p="6">
        <Heading as="h2" size="lg" fontWeight="semibold">Transcript</Heading>
        <Text mt="2" textStyle="sm" color="fg.muted">
          No transcript has been generated yet. Start transcription once ingest
          is ready.
        </Text>
      </Box>
    );
  }

  const isReady = transcript.status === "completed";

  return (
    <Box as="section" rounded="xl" borderWidth="1px" borderColor="border" p="6">
      <Stack gap="4">
        <Flex wrap="wrap" align="flex-start" justify="space-between" gap="3">
          <Box>
            <Heading as="h2" size="lg" fontWeight="semibold">Transcript</Heading>
            <Text mt="1" textStyle="sm" color="fg.muted">
              Status: {transcript.status}
              {transcript.languageCode
                ? ` \u00b7 Language: ${transcript.languageCode}`
                : ""}
              {typeof transcript.speakerCount === "number"
                ? ` \u00b7 Speakers: ${transcript.speakerCount}`
                : ""}
            </Text>
            {transcript.errorCode ? (
              <Text mt="1" textStyle="sm" color="red.500">
                Last transcription error: {transcript.errorCode}
              </Text>
            ) : null}
          </Box>
          {isReady ? (
            <Flex wrap="wrap" gap="2">
              <Button asChild size="sm" variant="outline">
                <a
                  href={`/api/projects/${projectId}/transcript/export?format=txt`}
                >
                  TXT
                </a>
              </Button>
              <Button asChild size="sm" variant="outline">
                <a
                  href={`/api/projects/${projectId}/transcript/export?format=srt`}
                >
                  SRT
                </a>
              </Button>
              <Button asChild size="sm" variant="outline">
                <a
                  href={`/api/projects/${projectId}/transcript/export?format=vtt`}
                >
                  VTT
                </a>
              </Button>
            </Flex>
          ) : null}
        </Flex>

        {!isReady ? (
          <Text textStyle="sm" color="fg.muted">
            Narriflow is preparing a read-only transcript with speaker labels and
            export-ready subtitles.
          </Text>
        ) : transcript.utterances.length > 0 ? (
          <Stack maxH="32rem" gap="3" overflowY="auto" pr="2">
            {transcript.utterances.map((utterance) => (
              <Box
                as="article"
                key={`${utterance.index}-${utterance.startSec}`}
                rounded="lg"
                borderWidth="1px"
                borderColor="border"
                p="4"
              >
                <Flex wrap="wrap" align="center" gap="2" textStyle="xs" color="fg.muted">
                  <Text as="span" fontWeight="medium" color="fg">
                    {utterance.speakerLabel}
                  </Text>
                  <Text as="span">{formatTimestamp(utterance.startSec)}</Text>
                  <Text as="span">-</Text>
                  <Text as="span">{formatTimestamp(utterance.endSec)}</Text>
                </Flex>
                <Text mt="2" textStyle="sm" lineHeight="tall">{utterance.text}</Text>
              </Box>
            ))}
          </Stack>
        ) : (
          <Box as="pre" maxH="32rem" overflow="auto" rounded="lg" bg="bg.muted" p="4" textStyle="sm" lineHeight="tall" whiteSpace="pre-wrap">
            {transcript.text ??
              "Transcript completed, but no utterances were returned."}
          </Box>
        )}
      </Stack>
    </Box>
  );
}
