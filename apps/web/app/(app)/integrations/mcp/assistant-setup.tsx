"use client";

import { type ReactNode, useState } from "react";
import { Box, Code, Flex, Grid, Stack, Tabs, Text } from "@chakra-ui/react";
import { ArrowUp, ArrowUpRight, Check, Copy, Link2, Plug } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { CodeBlock, copyToClipboard } from "@narriflow/ui/components/code-block";
import { Logo } from "@narriflow/ui/components/logo";
import { docsUrl } from "@/lib/docs-url";
import { type AssistantBrand, BrandGlyph, BrandTile } from "../_components/brand-tile";

type ClientId = AssistantBrand | "other";

interface ClientGuide {
  id: ClientId;
  label: string;
  steps: Array<{ text: ReactNode; code?: string }>;
  action?: { label: string; href: string };
  docs: string;
  beta?: boolean;
}

function guides(mcpUrl: string): ClientGuide[] {
  const cursorConfig = btoa(JSON.stringify({ url: mcpUrl }));
  return [
    {
      id: "claude",
      label: "Claude",
      steps: [
        { text: <>In Claude, open <b>Customize → Connectors</b>, select <b>+ Add</b>, then <b>Add custom connector</b>.</> },
        { text: "Paste this URL, then sign in to Narriflow.", code: mcpUrl },
        { text: <>In a chat, turn Narriflow on from <b>+ → Connectors</b>.</> },
      ],
      action: { label: "Open Claude", href: "https://claude.ai" },
      docs: "ai/claude",
    },
    {
      id: "claude-code",
      label: "Claude Code",
      steps: [
        { text: "Run this in your terminal.", code: `claude mcp add --transport http narriflow ${mcpUrl}` },
        { text: <>Run <Code size="sm">/mcp</Code> in Claude Code and sign in to Narriflow.</> },
        { text: "Ask Claude to list your Narriflow projects." },
      ],
      docs: "ai/claude-code",
    },
    {
      id: "chatgpt",
      label: "ChatGPT",
      steps: [
        { text: <>Open <b>ChatGPT Plugins</b>, select <b>+</b>, then <b>Add custom MCP server</b>.</> },
        { text: <>Paste this URL under <b>Connection</b>, choose OAuth, then select <b>Create as a plugin</b>.</>, code: mcpUrl },
        { text: <>Sign in to Narriflow, then type <Code size="sm">@</Code> in a chat and pick Narriflow.</> },
      ],
      action: { label: "Open ChatGPT Plugins", href: "https://chatgpt.com/plugins" },
      docs: "ai/chatgpt",
    },
    {
      id: "codex",
      label: "Codex",
      steps: [
        { text: "Add the server.", code: `codex mcp add narriflow \\\n  --url ${mcpUrl} \\\n  --oauth-resource ${mcpUrl}` },
        { text: "Sign in to Narriflow.", code: "codex mcp login narriflow" },
        { text: "Ask Codex to list your Narriflow projects." },
      ],
      docs: "ai/codex",
    },
    {
      id: "cursor",
      label: "Cursor",
      beta: true,
      steps: [
        { text: <>Click <b>Add to Cursor</b>, or add a server with this URL in <b>Cursor Settings → MCP</b>.</>, code: mcpUrl },
        { text: "Sign in to Narriflow when Cursor asks." },
        { text: "Ask Cursor to list your Narriflow projects." },
      ],
      action: {
        label: "Add to Cursor",
        href: `cursor://anysphere.cursor-deeplink/mcp/install?name=narriflow&config=${encodeURIComponent(cursorConfig)}`,
      },
      docs: "ai/cursor",
    },
    {
      id: "other",
      label: "Other",
      steps: [
        { text: "Add a Streamable HTTP server with this URL.", code: mcpUrl },
        { text: <>Sign in with OAuth, or send a workspace API key as <Code size="sm">Authorization: Bearer nf_…</Code></> },
        { text: <>Call <Code size="sm">narriflow_list_workspaces</Code> first.</> },
      ],
      docs: "ai/other-clients",
    },
  ];
}

function ClientTile({ id }: { id: ClientId }) {
  if (id !== "other") return <BrandTile brand={id} size="lg" />;
  return (
    <Flex boxSize="48px" borderRadius="14px" bg="bg.muted" color="fg" align="center" justify="center" aria-hidden="true">
      <Plug size={22} />
    </Flex>
  );
}

function Wire() {
  return (
    <Box
      w={{ base: "8", sm: "12" }}
      h="1px"
      bgImage="repeating-linear-gradient(90deg, var(--chakra-colors-fg-subtle) 0 4px, transparent 4px 8px)"
      opacity="0.6"
    />
  );
}

export function AssistantSetup({
  mcpUrl,
  status,
  notice,
}: {
  mcpUrl: string;
  status: { ready: boolean; label: string };
  notice?: ReactNode;
}) {
  const clients = guides(mcpUrl);
  const [selected, setSelected] = useState<ClientId>("claude");

  return (
    <Stack gap="6">
      <Stack align="center" textAlign="center" gap="0">
        <Flex align="center" mb="5">
          <Flex boxSize="48px" borderRadius="14px" bg="bg.muted" align="center" justify="center" aria-hidden="true">
            <Logo size="lg" showWordmark={false} />
          </Flex>
          <Wire />
          <Flex boxSize="7" borderRadius="full" bg="bg.soft" align="center" justify="center" color="fg.muted" aria-hidden="true">
            <Link2 size={14} />
          </Flex>
          <Wire />
          <ClientTile id={selected} />
        </Flex>
        <Text as="h1" fontSize={{ base: "24px", md: "28px" }} fontWeight="500" letterSpacing="-0.02em">
          Connect your AI assistant
        </Text>
        <Text fontSize="14px" color="fg.muted" mt="1">
          Clip, review, export and schedule videos from chat.
        </Text>
        <Flex align="center" gap="1.5" mt="4" h="6" px="2.5" borderRadius="full" bg="bg.soft" fontSize="12px" color="fg.muted">
          <Box boxSize="1.5" borderRadius="full" bg={status.ready ? "accent.solid" : "fg.subtle"} />
          {status.label}
        </Flex>
      </Stack>

      {notice}

      <Tabs.Root
        value={selected}
        onValueChange={(details) => setSelected(details.value as ClientId)}
        variant="plain"
        bg="bg.subtle"
        borderRadius="14px"
        p={{ base: "3", md: "4" }}
      >
        <Tabs.List gap="1" flexWrap="wrap">
          {clients.map((client) => (
            <Tabs.Trigger
              key={client.id}
              value={client.id}
              h="8"
              px="3"
              py="0"
              gap="2"
              borderRadius="9px"
              fontSize="13px"
              color="fg.muted"
              _hover={{ color: "fg" }}
              _selected={{ bg: "bg.raised", color: "fg" }}
            >
              {client.id !== "other" ? <BrandGlyph brand={client.id} size={14} /> : <Plug size={14} />}
              {client.label}
              {client.beta ? (
                <Text as="span" fontSize="11px" color="fg.subtle">
                  Beta
                </Text>
              ) : null}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        {clients.map((client) => (
          <Tabs.Content key={client.id} value={client.id} pt="5" pb="1" px={{ base: "1", md: "2" }}>
            <Stack as="ol" gap="4" listStyleType="none">
              {client.steps.map((step, index) => (
                <Flex as="li" key={String(index)} gap="3" align="flex-start">
                  <Flex boxSize="22px" flexShrink={0} borderRadius="full" bg="bg.soft" align="center" justify="center" fontSize="12px" color="fg.muted">
                    {index + 1}
                  </Flex>
                  <Stack gap="2.5" flex="1" minW="0" pt="0.5">
                    <Text fontSize="14px" css={{ "& b": { fontWeight: 500 } }}>
                      {step.text}
                    </Text>
                    {step.code ? <CodeBlock code={step.code} language={step.code.startsWith("http") ? "text" : "shell"} /> : null}
                  </Stack>
                </Flex>
              ))}
            </Stack>
            <Flex gap="2" mt="6" wrap="wrap">
              {client.action ? (
                <Button asChild size="sm">
                  <a href={client.action.href} target={client.action.href.startsWith("http") ? "_blank" : undefined} rel="noreferrer">
                    {client.action.label}
                    <ArrowUpRight size={16} />
                  </a>
                </Button>
              ) : null}
              <Button asChild size="sm" variant="ghost" color="fg.muted">
                <a href={docsUrl(client.docs)} target="_blank" rel="noreferrer">
                  Read the guide
                  <ArrowUpRight size={16} />
                </a>
              </Button>
            </Flex>
          </Tabs.Content>
        ))}
      </Tabs.Root>
    </Stack>
  );
}

const PROMPTS = [
  "Clip this video with my brand kit: https://youtu.be/…",
  "Export the top-scoring clip from my latest project.",
  "Schedule that clip to TikTok tomorrow at 9am.",
];

function PromptCard({ prompt }: { prompt: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Stack justify="space-between" gap="5" bg="bg.subtle" borderRadius="12px" p="4" minH="28">
      <Text fontSize="14px" lineHeight="1.5">
        {prompt}
      </Text>
      <Flex align="center" justify="space-between">
        <Button
          size="xs"
          variant="subtle"
          onClick={async () => {
            if (!(await copyToClipboard(prompt))) return;
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1800);
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? "Copied" : "Copy"}
        </Button>
        <Flex boxSize="7" borderRadius="full" bg="bg.soft" color="fg.muted" align="center" justify="center" aria-hidden="true">
          <ArrowUp size={14} />
        </Flex>
      </Flex>
    </Stack>
  );
}

export function PromptCards() {
  return (
    <Grid templateColumns={{ base: "1fr", md: "repeat(3, minmax(0, 1fr))" }} gap="2">
      {PROMPTS.map((prompt) => (
        <PromptCard key={prompt} prompt={prompt} />
      ))}
    </Grid>
  );
}
