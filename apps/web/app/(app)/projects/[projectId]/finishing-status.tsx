import Link from "next/link";
import { Flex, Stack, Text } from "@chakra-ui/react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import type { ProjectFinishingView } from "@narriflow/services";
import { FinishingAutoRefresh } from "./finishing-auto-refresh";

const WORKING = new Set(["waiting", "due", "running", "exporting"]);

/** What finishing did for this Project's newest generation: working, ready
 * with links to its exports, partial, or skipped with the reason. */
export function FinishingStatus({ projectId, finishing }: { projectId: string; finishing: ProjectFinishingView }) {
  const working = WORKING.has(finishing.state);
  const exported = finishing.clips.filter((clip) => clip.exportId);
  const copyCount = finishing.clips.filter((clip) => clip.copyWritten).length;
  const warn = finishing.state === "partial" || finishing.state === "skipped";
  const title = working
    ? "Finishing in progress"
    : finishing.state === "ready"
      ? "Ready to review"
      : finishing.state === "partial"
        ? "Finishing partly done"
        : "Finishing skipped";
  return (
    <Stack gap="2" bg="bg.subtle" borderRadius="l2" px="3.5" py="3" data-finishing-state={finishing.state}>
      <Flex align="center" gap="2" color={warn ? "warning.fg" : "fg"}>
        {working ? <Loader2 size={14} aria-hidden /> : warn ? <AlertTriangle size={14} aria-hidden /> : <CheckCircle2 size={14} aria-hidden />}
        <Text fontSize="sm" fontWeight="600">
          {title}
        </Text>
      </Flex>
      {working ? (
        <>
          <Text fontSize="xs" color="fg.muted">
            {finishing.state === "waiting"
              ? "Narriflow will export the best clips and write copy when clip generation finishes."
              : "Exporting the best clips and writing copy. This page updates on its own."}
          </Text>
          <FinishingAutoRefresh />
        </>
      ) : null}
      {finishing.message ? (
        <Text fontSize="xs" color="fg.muted">
          {finishing.message}
        </Text>
      ) : null}
      {finishing.rankedWithAudienceData ? (
        <Stack gap="1" data-ranked-with-audience-data>
          <Text fontSize="xs" color="fg.muted">
            Ranked with your audience data. Each clip's score was multiplied by a factor from what has worked for your audience.{" "}
            <Link href="/performance">
              <Text as="span" color="fg.accent" textDecoration="underline" textUnderlineOffset="3px">
                See what worked
              </Text>
            </Link>
          </Text>
          {finishing.clips.map((clip) =>
            clip.ranking ? (
              <Text key={clip.clipId} fontSize="xs" color="fg.subtle">
                {clip.title}: score {clip.ranking.score} × {clip.ranking.factor}
                {clip.ranking.groups.length > 0
                  ? ` (${clip.ranking.groups.map((group) => `${group.label} ${Number(group.lift.toFixed(2))}x`).join(", ")})`
                  : " (no matching audience group)"}
              </Text>
            ) : null,
          )}
        </Stack>
      ) : null}
      {!working && exported.length > 0 ? (
        <Stack gap="1">
          {exported.map((clip) => (
            <Flex key={clip.clipId} align="baseline" gap="2" minW="0">
              <Link href={`/projects/${projectId}/clips/${clip.clipId}/exports/${clip.exportId}`}>
                <Text fontSize="xs" color="fg.accent" fontWeight="500" textDecoration="underline" textUnderlineOffset="3px" truncate>
                  {clip.title}
                </Text>
              </Link>
              <Text fontSize="xs" color="fg.subtle" flexShrink={0}>
                {clip.exportStatus === "ready" ? "export ready" : clip.exportStatus === "failed" ? "export failed" : "export partly ready"}
                {clip.copyWritten ? " · copy written" : ""}
              </Text>
            </Flex>
          ))}
        </Stack>
      ) : null}
      {!working && copyCount > 0 ? (
        <Text fontSize="xs" color="fg.muted">
          Copy written for {copyCount} clip{copyCount === 1 ? "" : "s"}.
        </Text>
      ) : null}
    </Stack>
  );
}
