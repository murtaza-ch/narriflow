"use client";

import { Stack, Text } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";

export default function WorkspaceEntryError({ retry }: { retry: () => void }) {
  return <Stack minH="100dvh" align="center" justify="center" p="6" gap="4">
    <Text as="h1" fontSize="xl" fontWeight="600">Your workspace couldn’t open</Text>
    <Text color="fg.muted" textAlign="center">You’re signed in. Try opening your workspace again.</Text>
    <Button onClick={retry}>Try again</Button>
  </Stack>;
}
