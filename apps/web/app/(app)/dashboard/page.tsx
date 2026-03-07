import Link from "next/link";
import { Button } from "@narriflow/ui/components/button";
import { Stack, Heading, Text, Box } from "@chakra-ui/react";

export default function DashboardPage() {
  return (
    <Box as="section">
      <Stack gap="6">
        <Stack gap="2">
          <Heading size="xl" fontWeight="semibold" letterSpacing="tight">Dashboard</Heading>
          <Text color="fg.muted">
            Monitor ingest throughput, transcription health, and upcoming output
            milestones.
          </Text>
        </Stack>
        <Button asChild>
          <Link href="/upload">Start New Upload</Link>
        </Button>
      </Stack>
    </Box>
  );
}
