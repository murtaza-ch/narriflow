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
    console.warn(JSON.stringify({ level: "error", message: "studio_error_boundary", errorName: error instanceof Error ? error.name : "UnknownError" }));
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
      <Stack gap="5" maxW="480px" w="full" p={{ base: "6", md: "10" }} bg="studio.surface" borderWidth="1px" borderColor="studio.border" borderRadius="l3" align="center" textAlign="center" animation="fade-up">
        <Flex
          boxSize="14"
          align="center"
          justify="center"
          borderWidth="1px"
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

        <Flex gap="3" wrap="wrap" justify="center">
          <Button size="sm" variant="solid" colorPalette="brand" onClick={reset}>
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
