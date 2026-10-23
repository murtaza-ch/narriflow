"use client";

import { Fragment } from "react";
import { Box, Flex, Text } from "@chakra-ui/react";
import { Play } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import type { HttpMethod } from "@/lib/docs/openapi";
import { MethodBadge, methodPalette } from "../method-badge";
import { useApiState } from "./api-state";
import { CopyButton } from "./code-card";

/** `/api/v1/uploads/{id}` as separated segments, with parameters tinted like the method. */
export function PathSegments({ path, method }: { path: string; method: HttpMethod }) {
  const palette = methodPalette(method);
  return (
    <Flex align="center" wrap="wrap" columnGap="0.5" rowGap="1" fontFamily="mono" fontSize="13.5px" fontWeight="500" whiteSpace="nowrap">
      {path
        .split("/")
        .filter(Boolean)
        .map((segment, index) => (
          <Fragment key={index}>
            <Text as="span" color="fg.subtle">
              /
            </Text>
            {segment.startsWith("{") ? (
              <Text as="span" px="1" borderRadius="4px" bg={`${palette}.subtle`} color={`${palette}.fg`}>
                {segment}
              </Text>
            ) : (
              <Text as="span" color="fg">
                {segment}
              </Text>
            )}
          </Fragment>
        ))}
    </Flex>
  );
}

/** The method and path of the operation, with the "Try it" button. */
export function PathBar({ method, path, url }: { method: HttpMethod; path: string; url: string }) {
  const { setPlaygroundOpen, opener } = useApiState();
  return (
    <Flex align="center" gap="2" p="1.5" ps="3" minH="12" bg="bg.subtle" borderWidth="1px" borderColor="border.card" borderRadius="12px">
      <MethodBadge method={method} size="md" />
      <Box flex="1" minW="0">
        <PathSegments path={path} method={method} />
      </Box>
      <CopyButton text={url} label="Copy URL" />
      <Button ref={opener} type="button" size="sm" onClick={() => setPlaygroundOpen(true)}>
        Try it
        <Play size={12} fill="currentColor" />
      </Button>
    </Flex>
  );
}
