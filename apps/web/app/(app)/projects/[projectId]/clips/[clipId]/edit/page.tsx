import { notFound } from "next/navigation";
import Link from "next/link";
import { Button } from "@narriflow/ui/components/button";
import { requireCurrentAppUser } from "@narriflow/auth";
import { clipService } from "@narriflow/services";
import { Stack, Box, Heading, Text, Flex } from "@chakra-ui/react";
import { ChevronRight } from "lucide-react";
import { CaptionPresetForm } from "./caption-preset-form";

export default async function ClipEditPage({
  params,
}: {
  params: Promise<{ projectId: string; clipId: string }>;
}) {
  const appUser = await requireCurrentAppUser();
  const { projectId, clipId } = await params;

  const clips = await clipService.listClips(appUser.id, projectId);
  const clip = clips.find((c) => c.id === clipId);
  if (!clip) notFound();

  return (
    <Stack gap="32px">
      {/* Breadcrumb */}
      <Flex align="center" gap="6px" fontSize="13px" color="fg.muted">
        <Link href="/projects">
          <Text _hover={{ color: "fg" }} transition="color 150ms ease">Projects</Text>
        </Link>
        <ChevronRight size={14} />
        <Link href={`/projects/${projectId}`}>
          <Text _hover={{ color: "fg" }} transition="color 150ms ease">Project</Text>
        </Link>
        <ChevronRight size={14} />
        <Text color="fg" fontWeight="500">Edit Clip</Text>
      </Flex>

      {/* Header */}
      <Stack gap="4px">
        <Heading size="xl" fontWeight="600" letterSpacing="-0.02em">Edit Clip</Heading>
        <Text fontSize="13px" color="fg.muted">{clip.hookText}</Text>
        <Text fontSize="12px" fontFamily="mono" color="fg.subtle">
          {clip.startSec.toFixed(1)}s – {clip.endSec.toFixed(1)}s · {clip.durationSec.toFixed(1)}s
        </Text>
      </Stack>

      {/* Caption preset */}
      <Box
        borderRadius="12px"
        borderWidth="1px"
        borderColor="border"
        bg="bg.panel"
        p="20px"
      >
        <Stack gap="16px">
          <Box>
            <Text fontSize="14px" fontWeight="500" color="fg">Caption style</Text>
            <Text fontSize="12px" color="fg.muted" mt="2px">
              Customize the look of burnt-in captions for this clip. Applies to all new renders.
            </Text>
          </Box>
          <CaptionPresetForm
            projectId={projectId}
            clipId={clipId}
            initialPreset={clip.captionPreset}
          />
        </Stack>
      </Box>

      <Flex>
        <Button asChild size="sm" variant="outline">
          <Link href={`/projects/${projectId}`}>Back to project</Link>
        </Button>
      </Flex>
    </Stack>
  );
}
