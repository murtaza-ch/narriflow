import { AlertTriangle, FileText } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { StatusBadge } from "@narriflow/ui/components/status-badge";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { userErrorMessage, type TranscriptSnapshot } from "@narriflow/validators";
import { Stack, Box, Flex, Text } from "@chakra-ui/react";
import { formatTimecode } from "@/lib/format";

export function TranscriptPanel({
  projectId,
  transcript,
}: {
  projectId: string;
  transcript: TranscriptSnapshot | null;
}) {
  if (!transcript) {
    return (
      <EmptyState
        icon={<FileText size={22} aria-hidden />}
        title="No transcript yet"
        description="Transcribe your video to view and export subtitles."
      />
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
  const transcriptMetadata = [
    transcript.languageCode ? `Language: ${transcript.languageCode}` : null,
    typeof transcript.languageConfidence === "number"
      ? `Language confidence: ${Math.round(transcript.languageConfidence * 100)}%`
      : null,
    typeof transcript.speakerCount === "number"
      ? `Speakers: ${transcript.speakerCount}`
      : null,
    averageConfidence !== null
      ? `Speech confidence: ${Math.round(averageConfidence * 100)}%`
      : null,
    wordTimingHealth !== null ? `Word timing: ${wordTimingHealth}%` : null,
  ].filter((value): value is string => value !== null);

  return (
    <Box layerStyle="band">
      <Stack gap="4">
        <Flex wrap="wrap" align="flex-start" justify="space-between" gap="3">
          <Box>
            <Flex align="center" gap="2">
              <Text textStyle="eyebrow" color="fg.subtle">
                Transcript
              </Text>
              <StatusBadge
                status={
                  transcript.status as "processing" | "completed" | "failed"
                }
              />
            </Flex>
            <Text mt="1.5" textStyle="data" fontSize="11px" color="fg.subtle">
              {transcriptMetadata.join(" · ")}
            </Text>
            {transcript.errorCode && (
              <Flex align="center" gap="1.5" mt="1.5" color="danger.fg">
                <AlertTriangle size={13} aria-hidden />
                <Text fontSize="xs">
                  {userErrorMessage(transcript.errorCode)}
                </Text>
              </Flex>
            )}
          </Box>
          {isReady && (
            <Flex gap="1.5">
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
          <Text fontSize="sm" color="fg.muted">
            Preparing transcript with speaker labels and subtitle exports.
          </Text>
        ) : transcript.utterances.length > 0 ? (
          <Stack
            maxH="32rem"
            gap="0"
            overflowY="auto"
            borderTopWidth="1px"
            borderColor="border.subtle"
          >
            {transcript.utterances.map((utterance) => (
              <Box
                key={`${utterance.index}-${utterance.startSec}`}
                py="3"
                borderBottomWidth="1px"
                borderColor="border.subtle"
              >
                <Flex gap="2" align="center" mb="1">
                  <Text fontSize="13px" fontWeight="500" color="fg">
                    {utterance.speakerLabel}
                  </Text>
                  <Text textStyle="data" fontSize="11px" color="fg.timecode">
                    {formatTimecode(utterance.startSec)} – {formatTimecode(utterance.endSec)}
                  </Text>
                </Flex>
                <Text fontSize="sm" lineHeight="1.7" color="fg" maxW="80ch">
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
            borderRadius="l1"
            bg="bg.subtle"
            p="4"
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
