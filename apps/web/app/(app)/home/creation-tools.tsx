"use client";

import { useState } from "react";
import Link from "next/link";
import { Box, Dialog, Flex, Heading, Portal, SimpleGrid, Stack, Text, Tooltip } from "@chakra-ui/react";
import { ArrowUpRight, Clapperboard, X } from "lucide-react";
import { Button, IconButton } from "@narriflow/ui/components/button";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import type { ProjectListItem } from "@narriflow/services";

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
  },
  {
    art: "dubbing",
    title: "Dubbing",
    description: "Translate voice and captions",
    tab: "dubbing",
  },
] as const;

export function CreationTools({ items }: { items: ProjectListItem[] }) {
  const [selected, setSelected] = useState<"repurpose" | "dubbing" | null>(null);
  return (
    <>
      <SimpleGrid as="section" aria-label="Creation tools" columns={{ base: 2, xl: 4 }} gap="3">
        {tools.map((tool) => {
          const content = (
            <>
              <ToolArtwork kind={tool.art} />
              <Stack gap="1" flex="1" minW="0">
                <Heading as="h2" fontSize={{ base: "xs", md: "sm" }}>
                  {tool.title}
                </Heading>
              </Stack>
              <Box color="fg.subtle" display={{ base: "none", md: "block" }}>
                <ArrowUpRight size={14} />
              </Box>
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
            borderRadius: "l2",
            textAlign: "left",
            transition: "background 150ms",
            _hover: { bg: "bg.muted" },
          } as const;
          return (
            <Tooltip.Root key={tool.title} openDelay={250} closeDelay={0} positioning={{ placement: "top" }}>
              <Tooltip.Trigger asChild>
                {"href" in tool ? (
                  <Flex {...cardProps} asChild>
                    <Link href={tool.href}>{content}</Link>
                  </Flex>
                ) : (
                  <Flex
                    {...cardProps}
                    as="button"
                    cursor="pointer"
                    onClick={() => setSelected(tool.tab)}
                  >
                    {content}
                  </Flex>
                )}
              </Tooltip.Trigger>
              <Portal>
                <Tooltip.Positioner>
                  <Tooltip.Content bg="bg.muted" color="fg" borderRadius="l2" px="3" py="2" fontSize="xs" boxShadow="md">
                    {tool.description}
                  </Tooltip.Content>
                </Tooltip.Positioner>
              </Portal>
            </Tooltip.Root>
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
                <Dialog.Title>
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
                      icon={<Clapperboard size={24} />}
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
                  <Button asChild variant="outline">
                    <Link href="/projects">Browse all projects</Link>
                  </Button>
                </Dialog.Footer>
              )}
              <Dialog.CloseTrigger asChild>
                <IconButton variant="ghost" size="sm" aria-label="Close project picker">
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
