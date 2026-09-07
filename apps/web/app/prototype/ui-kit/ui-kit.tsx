"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Box,
  Card,
  CloseButton,
  Dialog,
  Field,
  Flex,
  Heading,
  Input,
  Menu,
  Portal,
  SimpleGrid,
  Stack,
  Tabs,
  Text,
  Textarea,
} from "@chakra-ui/react";
import { MoreHorizontal, Plus, Upload, FolderOpen } from "lucide-react";
import { Button, IconButton } from "@narriflow/ui/components/button";
import { Checkbox } from "@narriflow/ui/components/checkbox";
import { NumberInput } from "@narriflow/ui/components/number-input";
import { Select } from "@narriflow/ui/components/select";
import { SegmentedControl } from "@narriflow/ui/components/segmented-control";
import { useColorMode } from "@narriflow/ui/components/color-mode";

import { EmptyState } from "@narriflow/ui/components/empty-state";
import { PageLoading } from "@narriflow/ui/components/page-loading";
import { StatusBadge } from "@narriflow/ui/components/status-badge";

export function UIKIT() {
  const { colorMode, toggleColorMode } = useColorMode();
  const [format, setFormat] = useState("9:16");
  return (
    <Stack maxW="1120px" mx="auto" p={{ base: "5", md: "10" }} gap="8">
      <Flex justify="space-between" align="center" gap="4" wrap="wrap">
        <Stack gap="1">
          <Heading as="h1" size="2xl">
            Narriflow UI kit
          </Heading>
          <Text color="fg.muted" fontSize="sm">
            Production Chakra theme and shared components.
          </Text>
        </Stack>
        <Flex gap="2">
          <Button variant="outline" onClick={toggleColorMode}>
            {colorMode === "dark" ? "Light mode" : "Dark mode"}
          </Button>
          <Button asChild>
            <Link href="/home">Open dashboard</Link>
          </Button>
        </Flex>
      </Flex>
      <SimpleGrid columns={{ base: 2, md: 5 }} gap="3">
        {["bg", "bg.sidebar", "bg.panel", "bg.raised", "bg.dialog"].map((token) => (
          <Box
            key={token}
            bg={token}
            borderWidth="1px"
            borderColor="border"
            borderRadius="l2"
            p="4"
            minH="24"
          >
            <Text fontSize="sm">{token}</Text>
            <Text mt="3" fontSize="xs" color="fg.subtle">
              Secondary text
            </Text>
          </Box>
        ))}
      </SimpleGrid>
      <Card.Root>
        <Card.Header>
          <Card.Title>Actions</Card.Title>
        </Card.Header>
        <Card.Body gap="4">
          <Flex gap="3" wrap="wrap">
            <Button>
              <Plus size={16} />
              New project
            </Button>
            <Button variant="outline">Preview</Button>
            <Button variant="ghost">Cancel</Button>
            <Button disabled>Unavailable</Button>
            <Button loading>Saving</Button>
            <Button colorPalette="danger">Delete</Button>
          </Flex>
          <Flex gap="3">
            <Button size="xs">Small</Button>
            <Button size="sm">Regular</Button>
            <Button size="md">Large</Button>
            <Menu.Root>
              <Menu.Trigger asChild>
                <IconButton variant="outline" aria-label="Project actions">
                  <MoreHorizontal size={16} />
                </IconButton>
              </Menu.Trigger>
              <Portal>
                <Menu.Positioner>
                  <Menu.Content>
                    <Menu.Item value="rename">Rename</Menu.Item>
                    <Menu.Item value="duplicate">Duplicate</Menu.Item>
                    <Menu.Separator />
                    <Menu.Item value="delete" color="danger.fg">
                      Delete
                    </Menu.Item>
                  </Menu.Content>
                </Menu.Positioner>
              </Portal>
            </Menu.Root>
          </Flex>
        </Card.Body>
      </Card.Root>
      <SimpleGrid columns={{ base: 1, md: 2 }} gap="5">
        <Card.Root>
          <Card.Header>
            <Card.Title>Fields and selection</Card.Title>
          </Card.Header>
          <Card.Body gap="5">
            <Field.Root>
              <Field.Label>Project name</Field.Label>
              <Input placeholder="Name your project" />
            </Field.Root>
            <Field.Root invalid>
              <Field.Label>Video link</Field.Label>
              <Input defaultValue="example" />
              <Field.ErrorText>Enter a complete video URL.</Field.ErrorText>
            </Field.Root>
            <Field.Root disabled>
              <Field.Label>Workspace</Field.Label>
              <Input value="Read-only workspace" readOnly />
            </Field.Root>
            <Field.Root>
              <Field.Label>Notes</Field.Label>
              <Textarea placeholder="Add context for your team" />
            </Field.Root>
            <Select
              aria-label="Format"
              value={format}
              onValueChange={setFormat}
              items={[
                { label: "Vertical 9:16", value: "9:16" },
                { label: "Square 1:1", value: "1:1" },
              ]}
            />
            <NumberInput aria-label="Number of clips" defaultValue="5" min={1} max={10} />
            <Checkbox defaultChecked>Include captions</Checkbox>
            <Checkbox disabled>Unavailable option</Checkbox>
            <SegmentedControl items={["Compact", "Comfortable"]} defaultValue="Comfortable" />
          </Card.Body>
        </Card.Root>
        <Stack gap="5">
          <Card.Root>
            <Card.Header>
              <Card.Title>Navigation</Card.Title>
            </Card.Header>
            <Card.Body>
              <Tabs.Root defaultValue="clips">
                <Tabs.List>
                  <Tabs.Trigger value="clips">Clips</Tabs.Trigger>
                  <Tabs.Trigger value="transcript">Transcript</Tabs.Trigger>
                  <Tabs.Trigger value="publish" disabled>
                    Publish
                  </Tabs.Trigger>
                </Tabs.List>
                <Tabs.Content value="clips">
                  <Text color="fg.muted" fontSize="sm">
                    Review and select clips.
                  </Text>
                </Tabs.Content>
                <Tabs.Content value="transcript">
                  <Text color="fg.muted" fontSize="sm">
                    Read the source transcript.
                  </Text>
                </Tabs.Content>
              </Tabs.Root>
            </Card.Body>
          </Card.Root>
          <Card.Root>
            <Card.Header>
              <Card.Title>Dialog</Card.Title>
            </Card.Header>
            <Card.Body gap="4">
              <Text color="fg.muted" fontSize="sm">
                Shared surface, backdrop, focus containment, and responsive spacing.
              </Text>
              <Dialog.Root>
                <Dialog.Trigger asChild>
                  <Button variant="outline">Open dialog</Button>
                </Dialog.Trigger>
                <Portal>
                  <Dialog.Backdrop />
                  <Dialog.Positioner>
                    <Dialog.Content>
                      <Dialog.Header>
                        <Dialog.Title>Import a video</Dialog.Title>
                      </Dialog.Header>
                      <Dialog.Body>
                        <Stack gap="5">
                          <Box bg="bg.panel" borderRadius="l2" p="8" textAlign="center">
                            <Upload size={24} />
                            <Text mt="3">Choose a video to start</Text>
                          </Box>
                          <Field.Root>
                            <Field.Label>Video URL</Field.Label>
                            <Input placeholder="Paste a video link" />
                          </Field.Root>
                        </Stack>
                      </Dialog.Body>
                      <Dialog.Footer>
                        <Dialog.ActionTrigger asChild>
                          <Button variant="ghost">Cancel</Button>
                        </Dialog.ActionTrigger>
                        <Button disabled>Continue</Button>
                      </Dialog.Footer>
                      <Dialog.CloseTrigger asChild>
                        <CloseButton aria-label="Close dialog" size="sm" />
                      </Dialog.CloseTrigger>
                    </Dialog.Content>
                  </Dialog.Positioner>
                </Portal>
              </Dialog.Root>
            </Card.Body>
          </Card.Root>
        </Stack>
      </SimpleGrid>
      <Card.Root>
        <Card.Header>
          <Card.Title>Page states</Card.Title>
        </Card.Header>
        <Card.Body>
          <Tabs.Root defaultValue="empty">
            <Tabs.List flexWrap="wrap">
              <Tabs.Trigger value="empty">Empty</Tabs.Trigger>
              <Tabs.Trigger value="status">Status</Tabs.Trigger>
              <Tabs.Trigger value="library">Library loading</Tabs.Trigger>
              <Tabs.Trigger value="project">Project loading</Tabs.Trigger>
              <Tabs.Trigger value="import">Import loading</Tabs.Trigger>
              <Tabs.Trigger value="rows">Settings loading</Tabs.Trigger>
            </Tabs.List>
            <Tabs.Content value="empty">
              <EmptyState
                icon={<FolderOpen size={24} />}
                title="Your projects will appear here"
                description="Import a video to create your first set of clips."
                action={
                  <Button asChild>
                    <Link href="/upload">Import a video</Link>
                  </Button>
                }
              />
            </Tabs.Content>
            <Tabs.Content value="status">
              <Flex gap="3" wrap="wrap">
                {(["pending", "processing", "ready", "failed"] as const).map((status) => (
                  <StatusBadge key={status} status={status} />
                ))}
              </Flex>
            </Tabs.Content>
            {(["library", "project", "import", "rows"] as const).map((layout) => (
              <Tabs.Content key={layout} value={layout}>
                <PageLoading layout={layout} />
              </Tabs.Content>
            ))}
          </Tabs.Root>
        </Card.Body>
      </Card.Root>
    </Stack>
  );
}
