"use client";

import { useState } from "react";
import Link from "next/link";
import { Box, Dialog, Flex, Heading, Portal, SimpleGrid, Stack, Text } from "@chakra-ui/react";
import { ArrowUpRight, Clapperboard, X } from "lucide-react";
import { PLAN_CATALOG } from "@narriflow/validators";
import { Button, IconButton } from "@narriflow/ui/components/button";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { featureUpgradePrompt } from "@/lib/feature-upgrade-prompt";
import { UpgradeGem, useUpgrade } from "../_components/upgrade";
import type { ProjectListItem } from "../projects/_lib/api";

import { ToolArtwork, tiltScene, resetScene } from "./hero-experience";
import styles from "./hero-experience.module.css";

const tools = [
  { art: "clips", title: "AI clips", description: "Extract short clips", href: "/upload" },
  {
    art: "captions",
    title: "Captions",
    description: "Add and style subtitles",
    href: "/upload?mode=caption_only",
  },
  {
    art: "repurpose",
    title: "Repurpose",
    description: "Create posts and summaries",
    tab: "repurpose",
    feature: "content.repurposing",
    headline: "Upgrade to repurpose your videos",
  },
  {
    art: "dubbing",
    title: "Dubbing",
    description: "Translate voice and captions",
    tab: "dubbing",
    feature: "dubbing",
    headline: "Upgrade to dub your videos",
  },
] as const;

export function CreationTools({ items }: { items: ProjectListItem[] }) {
  const [selected, setSelected] = useState<"repurpose" | "dubbing" | null>(null);
  const { currentTier, openUpgrade } = useUpgrade();
  return (
    <>
      <SimpleGrid as="section" aria-label="Creation tools" columns={{ base: 2, xl: 4 }} gap="3">
        {tools.map((tool) => {
          // A tool the plan lacks opens the upgrade instead of a project picker
          // that would only lead to a locked panel.
          const upgrade = "feature" in tool ? featureUpgradePrompt(currentTier, tool.feature, tool.headline) : null;
          const content = (
            <>
              <ToolArtwork kind={tool.art} />
              <Stack gap="0.5" flex="1" minW="0">
                <Heading as="h2" fontSize={{ base: "xs", md: "sm" }} fontWeight="500">
                  {tool.title}
                </Heading>
                <Text fontSize="12.5px" color="fg.muted" truncate>
                  {tool.description}
                </Text>
              </Stack>
              {upgrade?.tier ? (
                <UpgradeGem label={`Needs ${PLAN_CATALOG[upgrade.tier].name}`} />
              ) : (
                <Box color="fg.subtle" display={{ base: "none", md: "block" }}>
                  <ArrowUpRight size={14} />
                </Box>
              )}
            </>
          );
          const cardProps = {
            className: styles.toolCard,
            onPointerMove: tiltScene,
            onPointerLeave: resetScene,
            align: "center",
            gap: "3",
            p: { base: "4", md: "5" },
            minH: "176px",
            bg: "bg.panel",
            borderWidth: "1px",
            borderColor: "border.card",
            borderRadius: "l3",
            textAlign: "left",
            transition: "background 150ms",
            _hover: { bg: "bg.subtle" },
          } as const;
          return "href" in tool ? (
            <Flex key={tool.title} {...cardProps} asChild>
              <Link href={tool.href}>{content}</Link>
            </Flex>
          ) : (
            <Flex
              key={tool.title}
              {...cardProps}
              as="button"
              cursor="pointer"
              aria-haspopup="dialog"
              onClick={() => (upgrade?.tier ? openUpgrade(upgrade) : setSelected(tool.tab))}
            >
              {content}
            </Flex>
          );
        })}
      </SimpleGrid>
      <Dialog.Root
        open={selected !== null}
        onOpenChange={({ open }) => {
          if (!open) setSelected(null);
        }}
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content>
              <Dialog.Header flexDirection="column" gap="2" pe="12">
                <Dialog.Title fontSize="18px" fontWeight="500">
                  {selected === "dubbing" ? "Dub a video" : "Repurpose a video"}
                </Dialog.Title>
                <Dialog.Description>Choose a recent project to continue.</Dialog.Description>
              </Dialog.Header>
              <Dialog.Body>
                <Stack gap="2">
                  {items.length ? (
                    items.map((project) => (
                      <Button
                        key={project.id}
                        asChild
                        variant="ghost"
                        h="auto"
                        py="3"
                        justifyContent="space-between"
                        borderRadius="l2"
                      >
                        <Link href={`/projects/${project.id}?tab=${selected}`}>
                          <Text truncate>{project.title}</Text>
                          <ArrowUpRight size={15} />
                        </Link>
                      </Button>
                    ))
                  ) : (
                    <EmptyState
                      icon={<Clapperboard size={20} />}
                      title="Start with a video"
                      description="Import a video, then use its transcript and clips to create more content."
                      action={
                        <Button asChild>
                          <Link href="/upload">Import a video</Link>
                        </Button>
                      }
                    />
                  )}
                </Stack>
              </Dialog.Body>
              {items.length > 0 && (
                <Dialog.Footer>
                  <Button asChild variant="subtle">
                    <Link href="/projects">Browse all projects</Link>
                  </Button>
                </Dialog.Footer>
              )}
              <Dialog.CloseTrigger asChild>
                <IconButton variant="ghost" size="sm" borderRadius="full" aria-label="Close project picker">
                  <X size={16} />
                </IconButton>
              </Dialog.CloseTrigger>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </>
  );
}
