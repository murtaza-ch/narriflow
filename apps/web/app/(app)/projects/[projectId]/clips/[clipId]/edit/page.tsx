import { notFound } from "next/navigation";
import Link from "next/link";
import { requireWorkspaceProject } from "@/lib/workspace";
import { clipService } from "@narriflow/services";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { ChevronRight } from "lucide-react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { formatDuration, formatTimecode } from "@/lib/format";
import { CaptionPresetForm } from "./caption-preset-form";

export default async function ClipEditPage({
  params,
}: {
  params: Promise<{ projectId: string; clipId: string }>;
}) {
  const { projectId, clipId } = await params;
  const appUser = await requireWorkspaceProject(projectId, "content.edit");

  const clips = await clipService.listClips(appUser.id, projectId);
  const clip = clips.find((c) => c.id === clipId);
  if (!clip) notFound();

  return (
    <Stack gap="8" maxW="1120px" mx="auto" w="full">
      {/* Breadcrumb */}
      <Flex
        as="nav"
        aria-label="Breadcrumb"
        align="center"
        gap="1.5"
        fontSize="13px"
        color="fg.muted"
        animation="fade-up"
        animationFillMode="backwards"
      >
        <Link href="/projects">
          <Text
            as="span"
            textDecoration="underline"
            textUnderlineOffset="3px"
            textDecorationColor="border.emphasized"
            transition="color 120ms ease"
            _hover={{ color: "fg" }}
          >
            Projects
          </Text>
        </Link>
        <ChevronRight size={14} aria-hidden />
        <Link href={`/projects/${projectId}`}>
          <Text
            as="span"
            textDecoration="underline"
            textUnderlineOffset="3px"
            textDecorationColor="border.emphasized"
            transition="color 120ms ease"
            _hover={{ color: "fg" }}
          >
            Project
          </Text>
        </Link>
        <ChevronRight size={14} aria-hidden />
        <Text as="span" color="fg" fontWeight="500" aria-current="page">
          Edit clip
        </Text>
      </Flex>

      {/* Header */}
      <Box
        animation="fade-up"
        animationFillMode="backwards"
        style={{ animationDelay: "60ms" }}
      >
        <PageHeader
          eyebrow="Clip"
          title="Edit clip"
          description={clip.hookText}
          meta={
            <>
              <Text textStyle="data" fontSize="12px" color="fg.timecode">
                {formatTimecode(clip.startSec)} – {formatTimecode(clip.endSec)}
              </Text>
              <Text textStyle="data" fontSize="12px" color="fg.muted">
                {formatDuration(clip.durationSec)}
              </Text>
              <Text fontSize="12px" color="fg.subtle">
                Caption style · applies to all new renders
              </Text>
            </>
          }
          actions={
            <Link href={`/projects/${projectId}`}>
              <Text
                as="span"
                fontSize="13px"
                color="fg"
                textDecoration="underline"
                textUnderlineOffset="3px"
                textDecorationColor="border.emphasized"
                transition="color 120ms ease"
                _hover={{ textDecorationColor: "fg" }}
              >
                Back to project
              </Text>
            </Link>
          }
        />
      </Box>

      {/* Two-pane caption editor */}
      <Box
        animation="fade-up"
        animationFillMode="backwards"
        style={{ animationDelay: "120ms" }}
      >
        <CaptionPresetForm
          projectId={projectId}
          clipId={clipId}
          initialPreset={clip.captionPreset}
        />
      </Box>
    </Stack>
  );
}
