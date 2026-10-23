"use client";

import { useState } from "react";
import { Box, Flex, Text } from "@chakra-ui/react";
import { CircleAlert, CircleCheck, TriangleAlert } from "lucide-react";
import { CodeCard, CodePane, CodeTabs } from "./code-card";
import { LiveCode } from "./live-code";

export type PlaygroundResult =
  | { kind: "response"; status: number; statusText: string; headers: Record<string, string>; body: string; time: number }
  | { kind: "error"; message: string };

function prettyBody(body: string): { text: string; json: boolean } {
  try {
    return { text: JSON.stringify(JSON.parse(body), null, 2), json: true };
  } catch {
    return { text: body, json: false };
  }
}

/** The request never produced a response: a network error, or a body that isn't JSON. */
function ErrorCard({ message }: { message: string }) {
  return (
    <Flex align="flex-start" gap="3" p="4" bg="danger.subtle" borderRadius="12px" role="alert">
      <Box color="danger.fg" mt="0.5">
        <TriangleAlert size={16} />
      </Box>
      <Text fontSize="13px" color="fg">
        {message}
      </Text>
    </Flex>
  );
}

/** What the server answered: status and timing on top, then the body or the headers. */
export function ResultCard({ result }: { result: PlaygroundResult }) {
  const [tab, setTab] = useState("body");
  if (result.kind === "error") return <ErrorCard message={result.message} />;

  const ok = result.status >= 200 && result.status < 300;
  const Icon = ok ? CircleCheck : CircleAlert;
  const { text, json } = prettyBody(result.body);
  const headers = Object.entries(result.headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");

  return (
    <CodeCard
      flexShrink={0}
      start={
        <Flex align="center" gap="3" minW="0" h="full">
          <Flex align="center" gap="1.5" flexShrink={0} color={ok ? "accent.fg" : "danger.fg"} aria-live="polite">
            <Icon size={14} aria-hidden="true" />
            <Text as="span" fontSize="12.5px" fontWeight="500" fontFamily="mono">
              {result.status} {result.statusText}
            </Text>
          </Flex>
          <Text as="span" fontSize="12px" color="fg.subtle" flexShrink={0}>
            {result.time} ms
          </Text>
          <CodeTabs
            label="Response view"
            tabs={[
              { value: "body", label: "Body" },
              { value: "headers", label: "Headers" },
            ]}
            value={tab}
            onChange={setTab}
          />
        </Flex>
      }
      copy={{ text: tab === "body" ? text : headers, label: tab === "body" ? "Copy body" : "Copy headers" }}
    >
      <CodePane maxH="16rem">
        {tab === "headers" ? headers || "No headers" : text ? <LiveCode code={text} lang={json ? "json" : "text"} /> : "No content"}
      </CodePane>
    </CodeCard>
  );
}
