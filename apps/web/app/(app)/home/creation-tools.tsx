"use client";

import { useState } from "react";
import Link from "next/link";
import { Box, Dialog, Flex, Heading, Portal, SimpleGrid, Stack, Text } from "@chakra-ui/react";
import { ArrowUpRight, Captions, Clapperboard, FileText, Languages, X } from "lucide-react";
import { Button, IconButton } from "@narriflow/ui/components/button";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import type { ProjectListItem } from "@narriflow/services";

const tools = [
  { icon: Clapperboard, title: "AI clips", description: "Extract short clips", href: "/upload" },
  {
    icon: Captions,
    title: "Captions",
    description: "Add and style subtitles",
    href: "/upload?mode=caption_only",
  },
  {
    icon: FileText,
    title: "Repurpose",
    description: "Create posts and summaries",
    tab: "repurpose",
  },
  {
    icon: Languages,
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
              <Box color="fg.muted" flexShrink={0}>
                <tool.icon size={23} strokeWidth={1.6} />
              </Box>
              <Stack gap="1" flex="1" minW="0">
                <Heading as="h2" fontSize={{ base: "xs", md: "sm" }}>
                  {tool.title}
                </Heading>
                <Text fontSize={{ base: "10px", md: "11px" }} color="fg.subtle">
                  {tool.description}
                </Text>
              </Stack>
              <Box color="fg.subtle" display={{ base: "none", md: "block" }}>
                <ArrowUpRight size={14} />
              </Box>
            </>
          );
          const styles = {
            align: "center",
            gap: "3",
            p: { base: "3", md: "4" },
            minH: "80px",
            bg: "bg.panel",
            borderWidth: "1px",
            borderColor: "border",
            borderRadius: "l2",
            textAlign: "left",
            transition: "background 150ms, border-color 150ms",
            _hover: { bg: "bg.muted", borderColor: "border.emphasized" },
          } as const;
          return "href" in tool ? (
            <Flex key={tool.title} {...styles} asChild>
              <Link href={tool.href}>{content}</Link>
            </Flex>
          ) : (
            <Flex
              key={tool.title}
              {...styles}
              as="button"
              cursor="pointer"
              onClick={() => setSelected(tool.tab)}
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
