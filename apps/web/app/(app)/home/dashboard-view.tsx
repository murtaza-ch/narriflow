import Link from "next/link";
import { Flex, Heading, Stack, Text } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { ArrowRight, Bot } from "lucide-react";
import type { ProjectListItem } from "@narriflow/services";
import { HeroExperience } from "./hero-experience";
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
    <HeroExperience canCreate={canCreate} />
    {canCreate && <CreationTools items={items} />}
    <RecentProjects items={items} canCreate={canCreate} />
    {canCreate && <Flex as="section" align={{ base: "flex-start", md: "center" }} gap="4" p={{ base: "5", md: "6" }} bg="bg.panel" borderWidth="1px" borderColor="border.card" borderRadius="l3" direction={{ base: "column", md: "row" }}>
      <Flex boxSize="10" align="center" justify="center" bg="bg.soft" borderRadius="full" color="fg.muted"><Bot size={20} /></Flex>
      <Stack gap="1" flex="1"><Heading as="h2" fontSize="sm" fontWeight="500">Channel automation</Heading><Text fontSize="13px" color="fg.muted">Connect a channel and turn new episodes into clips automatically.</Text></Stack>
      <Button asChild variant="ghost" size="sm"><Link href="/autopilot">Set up Autopilot<ArrowRight size={14} /></Link></Button>
    </Flex>}
  </Stack>;
}
