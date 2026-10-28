import Link from "next/link";
import { Box, Flex, Heading, Stack, Text } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { ArrowRight, Rss } from "lucide-react";
import type { ProjectListItem } from "@narriflow/services";
import type { PricingTier } from "@narriflow/validators";
import { HeroExperience, type ReadOnlyReason } from "./hero-experience";
import { RetentionBanner } from "../projects/_components/retention-banner";
import { PlanBadge } from "../_components/upgrade";
import { CreationTools } from "./creation-tools";
import { RecentProjects } from "./recent-projects";

export interface AutopilotSummary {
  /** The plan that adds Autopilot, when this Workspace's plan lacks it. */
  lockedTier: PricingTier | null;
  rules: number;
  /** Rules watching right now; the rest are paused. */
  activeRules: number;
}

export function DashboardView({ items, canCreate, readOnlyReason = null, showRetentionBanner, canManageBilling, autopilot }: {
  greeting: string;
  items: ProjectListItem[];
  canCreate: boolean;
  /** Why this member can't import: their role, or a paused (unpaid) workspace. */
  readOnlyReason?: ReadOnlyReason;
  showRetentionBanner: boolean;
  canManageBilling: boolean;
  autopilot: AutopilotSummary;
}) {
  return <Stack gap={{ base: "8", md: "10" }}>
    {showRetentionBanner && <RetentionBanner canManageBilling={canManageBilling} />}
    <HeroExperience canCreate={canCreate} readOnlyReason={readOnlyReason} />
    {canCreate && <CreationTools items={items} />}
    <RecentProjects items={items} canCreate={canCreate} />
    {canCreate && <AutopilotCard {...autopilot} />}
  </Stack>;
}

/** Autopilot as it stands: an invitation, or what it's doing for this Workspace. */
function AutopilotCard({ lockedTier, rules, activeRules }: AutopilotSummary) {
  const copy = activeRules > 0
    ? { title: "Autopilot is on", description: `${activeRules} ${activeRules === 1 ? "rule is" : "rules are"} watching for new episodes. Each one becomes captioned clips on its own.`, action: "Manage" }
    : rules > 0
      ? { title: "Autopilot is paused", description: "Your rules are paused, so new episodes aren't being imported.", action: "Review rules" }
      : { title: "Put a feed on Autopilot", description: "Watch a podcast feed for new episodes. Each one becomes captioned clips, with no upload.", action: "Set up Autopilot" };
  return (
    <Flex
      as="section"
      aria-label="Autopilot"
      align={{ base: "flex-start", md: "center" }}
      direction={{ base: "column", md: "row" }}
      gap={{ base: "4", md: "6" }}
      p={{ base: "5", md: "6" }}
      bg="bg.panel"
      borderWidth="1px"
      borderColor="border.card"
      borderRadius="l3"
    >
      <FeedToClips flowing={activeRules > 0} />
      <Stack gap="1" flex="1" minW="0">
        <Flex align="center" gap="2" wrap="wrap">
          <Heading as="h2" fontSize="15px" fontWeight="500">{copy.title}</Heading>
          {lockedTier ? <PlanBadge tier={lockedTier} /> : null}
        </Flex>
        <Text fontSize="13px" color="fg.muted">{copy.description}</Text>
      </Stack>
      <Button asChild variant="subtle" size="sm" flexShrink={0}>
        <Link href="/autopilot">{copy.action}<ArrowRight size={14} /></Link>
      </Button>
    </Flex>
  );
}

const CLIP_FILLS = [
  "linear-gradient(140deg,#c1d2f2,#5c6c96)",
  "linear-gradient(135deg,#8cace0,#31486f)",
  "linear-gradient(140deg,#c9bcf0,#74619e)",
];

/** A feed handing off to clips; the hand-off moves while rules are watching. */
function FeedToClips({ flowing }: { flowing: boolean }) {
  return (
    <Flex align="center" gap="2.5" flexShrink={0} aria-hidden>
      <Flex boxSize="10" align="center" justify="center" borderRadius="full" bg="accent.subtle" color="accent.fg">
        <Rss size={17} />
      </Flex>
      <Flex gap="1">
        {[0, 1, 2].map((index) => (
          <Box
            key={index}
            boxSize="1"
            borderRadius="full"
            bg="fg.subtle"
            opacity={flowing ? undefined : 0.5}
            animation={flowing ? "pulse 1.4s ease-in-out infinite" : undefined}
            style={flowing ? { animationDelay: `${index * 0.2}s` } : undefined}
          />
        ))}
      </Flex>
      <Flex align="center" ps="1">
        {CLIP_FILLS.map((fill, index) => (
          <Box
            key={fill}
            w="20px"
            h="34px"
            ms={index ? "-3px" : "0"}
            borderRadius="5px"
            zIndex={index === 1 ? 1 : 0}
            transform={`rotate(${(index - 1) * 12}deg)${index === 1 ? " translateY(-2px)" : ""}`}
            style={{ backgroundImage: fill }}
          />
        ))}
      </Flex>
    </Flex>
  );
}
