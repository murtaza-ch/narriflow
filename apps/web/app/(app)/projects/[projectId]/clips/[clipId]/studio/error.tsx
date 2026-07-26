"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button, Flex, Heading, Stack, Text } from "@chakra-ui/react";
import { Clapperboard } from "lucide-react";

export default function StudioError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();
  const params = useParams<{ projectId?: string }>();
  const projectId = typeof params?.projectId === "string" ? params.projectId : null;

  useEffect(() => {
    console.error("studio_error_boundary", error);
  }, [error]);

  return (
    <Flex
      minH="100dvh"
      align="center"
      justify="center"
      p="6"
      bg="studio.canvas"
      color="studio.fg"
    >
      <Stack gap="5" maxW="440px" align="center" textAlign="center" animation="fade-up">
        {/* Ghost frame — the Blueline empty/error signature, graphite-tuned */}
        <Flex
          w="200px"
          aspectRatio={16 / 9}
          align="center"
          justify="center"
          borderWidth="1px"
          borderStyle="dashed"
          borderColor="studio.borderStrong"
          borderRadius="l2"
          color="studio.fgSubtle"
        >
          <Clapperboard size={28} strokeWidth={1.5} />
        </Flex>

        <Stack gap="2" align="center">
          <Text textStyle="eyebrow" color="studio.fgMuted">
            Studio
          </Text>
          <Heading textStyle="title" fontSize="20px" color="studio.fg">
            We couldn&rsquo;t load the editor
          </Heading>
          <Text color="studio.fgMuted" fontSize="14px">
            Something went wrong while loading the studio. You can try again,
            and if it keeps happening, contact support.
          </Text>
          {error.digest ? (
            <Text textStyle="data" fontSize="12px" color="studio.fgSubtle">
              Digest: {error.digest}
            </Text>
          ) : null}
        </Stack>

        <Flex gap="3">
          <Button size="sm" variant="solid" colorPalette="accent" onClick={reset}>
            Try again
          </Button>
          <Button
            size="sm"
            variant="outline"
            color="studio.fg"
            borderColor="studio.borderStrong"
            _hover={{ bg: "studio.surface" }}
            onClick={() =>
              projectId ? router.push(`/projects/${projectId}`) : router.push("/projects")
            }
          >
            Back to project
          </Button>
        </Flex>
      </Stack>
    </Flex>
  );
}
