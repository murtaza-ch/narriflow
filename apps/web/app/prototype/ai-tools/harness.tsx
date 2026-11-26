"use client";

// AI tools panel harness (Add Emojis ticket 25): the real rows over mock Studio state, one column per
// row state, and the real tool rail inside the Studio's height budget. No API.
import { useEffect, useMemo, useState } from "react";
import { Box, Flex, Grid, Text } from "@chakra-ui/react";
import { SignedOutApiProvider } from "@/app/_components/api-provider";
import { StudioFieldsProvider, type StudioFields, type ToolId } from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/studio-shell";
import { studioUpgradePrompts } from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/studio-upgrade";
import { AiToolsList } from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/ai-tools-panel";
import {
  aiToolsFixtureEmojiEditor,
  aiToolsFixtureFields,
  type AiToolsScenario,
} from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/ai-tools/ai-tools-fixture";
import { ReadOnlyPanelNotice, ToolSidebar } from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-sidebar";

export interface AiToolsHarnessOptions {
  readonly view: "states" | "rail";
  /** Only these columns (ids below); all when empty. */
  readonly only: readonly string[];
}

type EmojiInput = Parameters<typeof aiToolsFixtureEmojiEditor>[0];

const COLUMNS: readonly { id: string; caption: string; scenario: AiToolsScenario; emoji: EmojiInput }[] = [
  { id: "fresh", caption: "Fresh English clip, Free plan, speaker analysis running", scenario: "fresh", emoji: { run: { status: "idle" } } },
  { id: "running", caption: "Add emojis running; the rest stays usable", scenario: "fresh", emoji: { run: { status: "running", density: "balanced" } } },
  { id: "failed", caption: "Add emojis failed (offline)", scenario: "fresh", emoji: { run: { status: "failed", failure: { reason: "request", code: null } } } },
  { id: "applied", caption: "Everything applied", scenario: "applied", emoji: { run: { status: "idle" }, shown: 12 } },
  { id: "empty", caption: "No emojis fit; emojis off", scenario: "applied", emoji: { run: { status: "done", added: 0, leftOut: 0, partial: false }, enabled: false } },
  { id: "urdu", caption: "Urdu audio clip, classic style", scenario: "urdu-audio", emoji: { run: { status: "idle" } } },
  { id: "readonly", caption: "Read-only (another tab edits)", scenario: "readonly", emoji: { run: { status: "idle" } } },
];

const noop = () => undefined;

/** Client only: the fixtures have no server rendering to match. */
export function AiToolsHarness({ options }: { options: AiToolsHarnessOptions }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return <SignedOutApiProvider>{options.view === "rail" ? <RailView /> : <StatesView only={options.only} />}</SignedOutApiProvider>;
}

function StatesView({ only }: { only: readonly string[] }) {
  const columns = only.length > 0 ? COLUMNS.filter((column) => only.includes(column.id)) : COLUMNS;
  return (
    <Box minH="100dvh" bg="bg" p="3">
      <Grid className="dark" data-theme="dark" templateColumns={`repeat(${Math.min(columns.length, 4)}, 380px)`} gap="3" bg="studio.frame" color="studio.fg" p="3" borderRadius="16px" w="fit-content" mx="auto">
        {columns.map((column) => (
          <StateColumn key={column.id} caption={column.caption} scenario={column.scenario} emoji={column.emoji} />
        ))}
      </Grid>
    </Box>
  );
}

function StateColumn({ caption, scenario, emoji }: { caption: string; scenario: AiToolsScenario; emoji: EmojiInput }) {
  const [opened, setOpened] = useState<string | null>(null);
  const fields = useMemo(
    () =>
      aiToolsFixtureFields(scenario, {
        upgradePrompts: studioUpgradePrompts(scenario === "fresh" ? "free" : "pro", null),
        openTool: (opening) => setOpened(typeof opening === "string" ? opening : `${opening.tool} › ${opening.section}`),
      }),
    [scenario],
  );
  const editor = useMemo(() => aiToolsFixtureEmojiEditor(emoji), [emoji]);
  return (
    <Flex direction="column" gap="2">
      <Text fontSize="12px" color="studio.fgSubtle" px="1">
        {caption}
        {opened ? ` · opened ${opened}` : ""}
      </Text>
      <StudioFieldsProvider fields={fields}>
        {/* The tool panel's frame, as `ToolSidebar` draws it. */}
        <Flex direction="column" bg="studio.canvas" borderRadius="12px" overflow="hidden">
          <Flex px="5" pt="4" pb="3" align="center">
            <Text fontSize="16px" fontWeight="500" color="studio.fg">
              AI tools
            </Text>
          </Flex>
          {scenario === "readonly" ? <ReadOnlyPanelNotice onTakeOver={noop} /> : null}
          <AiToolsList emojiEditor={editor} />
        </Flex>
      </StudioFieldsProvider>
    </Flex>
  );
}

/** The real rail and panel inside the Studio's height budget: top bar 56 px, timeline 250 px, 8 px frame and gaps. */
function RailView() {
  const [activeTool, setActiveTool] = useState<ToolId | null>("ai");
  const base = useMemo(() => aiToolsFixtureFields("fresh", { upgradePrompts: studioUpgradePrompts("free", null) }), []);
  const fields = {
    ...base,
    activeTool,
    // Other panels need the full Studio; the rail toggles only the AI tools panel here.
    setActiveTool: (tool: ToolId | null) => setActiveTool(tool === "ai" ? "ai" : null),
    openTool: (opening: ToolId | { tool: ToolId }) => setActiveTool((typeof opening === "string" ? opening : opening.tool) === "ai" ? "ai" : null),
    handleTakeOverEditing: noop,
    setCaptionPreset: noop,
    setCaptionEmojis: noop,
    replaceCaptionEmojis: () => undefined,
    checkpointCloud: async () => true,
  } as unknown as StudioFields;
  return (
    <StudioFieldsProvider fields={fields}>
      <Flex className="dark" data-theme="dark" direction="column" h="100dvh" p="2" gap="2" bg="studio.frame" color="studio.fg">
        <Box h="56px" flexShrink={0} bg="studio.canvas" borderRadius="12px" />
        <Flex flex="1" minH="0" gap="2">
          <Box w="320px" bg="studio.canvas" borderRadius="12px" />
          <Box flex="1" minW="0" bg="studio.canvas" borderRadius="12px" />
          <ToolSidebar />
        </Flex>
        <Box h="250px" flexShrink={0} bg="studio.canvas" borderRadius="12px" />
      </Flex>
    </StudioFieldsProvider>
  );
}
