"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Flex, Stack, Text } from "@chakra-ui/react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { EmptyState } from "@narriflow/ui/components/empty-state";

export default function ProjectError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("project_error_boundary", error);
  }, [error]);

  return (
    <Flex minH="60dvh" align="center" justify="center" p="6">
      <Stack gap="3" align="center" animation="fade-up" animationFillMode="backwards">
        <EmptyState
          icon={
            <Flex color="danger.fg">
              <AlertTriangle size={22} aria-hidden />
            </Flex>
          }
          title="We couldn't load this project"
          description="Something went wrong while loading this project. Try again — if it keeps happening, contact support."
          action={<Button onClick={reset}>Try again</Button>}
        />
        <Link href="/projects">
          <Text
            as="span"
            fontSize="xs"
            color="fg.muted"
            textDecoration="underline"
            textDecorationColor="border.emphasized"
            textUnderlineOffset="3px"
            transition="text-decoration-color 120ms ease"
            _hover={{ textDecorationColor: "fg" }}
          >
            Back to projects
          </Text>
        </Link>
        {error.digest ? (
          <Text textStyle="data" fontSize="11px" color="fg.subtle">
            digest {error.digest}
          </Text>
        ) : null}
      </Stack>
    </Flex>
  );
}
