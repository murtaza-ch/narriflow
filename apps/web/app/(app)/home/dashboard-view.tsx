import Link from "next/link";
import { Box, Flex, Heading, Stack, Text } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { ArrowRight, Bot, Rss, Upload } from "lucide-react";
import type { ProjectListItem } from "@narriflow/services";
import { HeroPasteLinkField } from "./dashboard-client";
import { RetentionBanner } from "../projects/_components/retention-banner";
import { CreationTools } from "./creation-tools";
import { RecentProjects } from "./recent-projects";

export function DashboardView({ items, canCreate, showRetentionBanner }: {
  greeting: string;
  items: ProjectListItem[];
  canCreate: boolean;
  showRetentionBanner: boolean;
}) {
  return <Stack gap={{ base: "8", md: "10" }}>
    {showRetentionBanner && <RetentionBanner />}
    <Box as="section" pt={{ base: "2", md: "5" }} css={{ "@media (min-width: 1600px)": { paddingTop: "30px" } }}>
      <Heading as="h1" fontSize={{ base: "34px", md: "36px" }} css={{ "@media (min-width: 1600px)": { fontSize: "52px" } }} lineHeight="1.14" letterSpacing="-0.03em">Create clips</Heading>
      <Text color="fg.muted" fontSize="sm" mt="4">Import a video to find, edit, and publish short clips.</Text>
      {canCreate ? <>
        <Box w="full" maxW="740px" mt="7"><HeroPasteLinkField /></Box>
        <Flex gap="3" wrap="wrap" align="center" mt="3">
          <Button variant="plain" size="sm" asChild><Link href="/upload"><Upload size={13} />Upload a file</Link></Button>
          <Text fontSize="11px" color="fg.subtle">or</Text>
          <Button variant="plain" size="sm" asChild><Link href="/upload?source=rss"><Rss size={13} />Import a podcast</Link></Button>
          <Text fontSize="10px" color="fg.subtle" display={{ base: "none", sm: "block" }}>MP4, MOV, WebM, MKV, MP3, WAV · up to 5 GB</Text>
        </Flex>
      </> : <Text color="fg.muted" fontSize="sm" mt="6">This workspace is read-only for your current role or subscription state.</Text>}
    </Box>
    {canCreate && <CreationTools items={items} />}
    <RecentProjects items={items} canCreate={canCreate} />
    {canCreate && <Flex as="section" align={{ base: "flex-start", md: "center" }} gap="4" p={{ base: "5", md: "6" }} bg="bg.subtle" borderRadius="l2" direction={{ base: "column", md: "row" }}>
      <Flex boxSize="11" align="center" justify="center" bg="bg.muted" borderRadius="l2" color="fg.muted"><Bot size={22} /></Flex>
      <Stack gap="1" flex="1"><Heading as="h2" fontSize="sm">Channel automation</Heading><Text fontSize="xs" color="fg.subtle">Connect a channel and turn new episodes into clips automatically.</Text></Stack>
      <Button asChild variant="ghost" size="sm"><Link href="/autopilot">Set up Autopilot<ArrowRight size={14} /></Link></Button>
    </Flex>}
  </Stack>;
}
