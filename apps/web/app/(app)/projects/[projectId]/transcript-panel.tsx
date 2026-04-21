import { Button } from "@narriflow/ui/components/button";
import { StatusBadge } from "@narriflow/ui/components/status-badge";
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
      <Box borderRadius="12px" borderWidth="1px" borderColor="border" bg="bg.panel" p="20px">
        <Text fontSize="14px" fontWeight="500" color="fg">Transcript</Text>
        <Text mt="4px" fontSize="13px" color="fg.muted">
          No transcript yet. Start transcription once ingest is ready.
        </Text>
      </Box>
    );
  }

  const isReady = transcript.status === "completed";
  const utterancesWithConfidence = transcript.utterances.filter(
    (utterance) => typeof utterance.confidence === "number",
  );
  const averageConfidence =
    utterancesWithConfidence.length > 0
      ? utterancesWithConfidence.reduce(
          (sum, utterance) => sum + (utterance.confidence ?? 0),
          0,
        ) / utterancesWithConfidence.length
      : null;
  const utterancesWithWords = transcript.utterances.filter(
    (utterance) => utterance.words.length > 0,
  ).length;
  const wordTimingHealth =
    transcript.utterances.length > 0
      ? Math.round((utterancesWithWords / transcript.utterances.length) * 100)
      : null;

  return (
    <Box borderRadius="12px" borderWidth="1px" borderColor="border" bg="bg.panel" p="20px">
      <Stack gap="16px">
        <Flex wrap="wrap" align="flex-start" justify="space-between" gap="12px">
          <Box>
            <Flex align="center" gap="8px">
              <Text fontSize="14px" fontWeight="500" color="fg">Transcript</Text>
              <StatusBadge status={transcript.status as "processing" | "completed" | "failed"} />
            </Flex>
            <Text mt="4px" fontSize="12px" color="fg.muted">
              {transcript.languageCode ? `Language: ${transcript.languageCode}` : ""}
              {typeof transcript.speakerCount === "number"
                ? ` · Speakers: ${transcript.speakerCount}`
                : ""}
              {averageConfidence !== null
                ? ` · Confidence: ${Math.round(averageConfidence * 100)}%`
                : ""}
              {wordTimingHealth !== null
                ? ` · Word timing: ${wordTimingHealth}%`
                : ""}
            </Text>
            {transcript.errorCode && (
              <Text mt="4px" fontSize="12px" color="danger.fg">
                Error: {transcript.errorCode}
              </Text>
            )}
          </Box>
          {isReady && (
            <Flex gap="6px">
              {["txt", "srt", "vtt"].map((format) => (
                <Button key={format} asChild size="sm" variant="outline">
                  <a href={`/api/projects/${projectId}/transcript/export?format=${format}`}>
                    {format.toUpperCase()}
                  </a>
                </Button>
              ))}
            </Flex>
          )}
        </Flex>

        {!isReady ? (
          <Text fontSize="13px" color="fg.muted">
            Preparing transcript with speaker labels and subtitle exports.
          </Text>
        ) : transcript.utterances.length > 0 ? (
          <Stack maxH="32rem" gap="0" overflowY="auto" borderRadius="8px" borderWidth="1px" borderColor="border">
            {transcript.utterances.map((utterance, index) => (
              <Box
                key={`${utterance.index}-${utterance.startSec}`}
                px="16px"
                py="12px"
                borderBottomWidth={index < transcript.utterances.length - 1 ? "1px" : "0"}
                borderColor="border"
              >
                <Flex gap="8px" align="center" mb="4px">
                  <Text fontSize="13px" fontWeight="500" color="fg">
                    {utterance.speakerLabel}
                  </Text>
                  <Text fontSize="11px" fontFamily="mono" color="fg.subtle">
                    {formatTimestamp(utterance.startSec)} - {formatTimestamp(utterance.endSec)}
                  </Text>
                </Flex>
                <Text fontSize="13px" lineHeight="1.6" color="fg">
                  {utterance.text}
                </Text>
              </Box>
            ))}
          </Stack>
        ) : (
          <Box
            as="pre"
            maxH="32rem"
            overflow="auto"
            borderRadius="8px"
            bg="bg.muted"
            p="16px"
            fontSize="13px"
            fontFamily="mono"
            lineHeight="1.6"
            whiteSpace="pre-wrap"
          >
            {transcript.text ?? "Transcript completed, but no utterances were returned."}
          </Box>
        )}
      </Stack>
    </Box>
  );
}
