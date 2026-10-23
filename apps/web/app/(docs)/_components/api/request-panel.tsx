"use client";

import { type BoxProps, Flex, type FlexProps } from "@chakra-ui/react";
import { useApiState } from "./api-state";
import { ChoiceMenu } from "./choice-menu";
import { CodeCard, CodePane, CodeTabs } from "./code-card";
import type { ExampleLanguage } from "./examples";

/** The request in one of the example languages; the language choice is shared by every card on the page. */
export function RequestCard({ languages, maxH }: { languages: ExampleLanguage[]; maxH?: BoxProps["maxH"] }) {
  const { language, setLanguage } = useApiState();
  const current = languages.find((item) => item.id === language) ?? languages[0];
  if (!current) return null;
  return (
    <CodeCard
      start={<ChoiceMenu label="Language" value={current.id} onChange={setLanguage} options={languages.map(({ id, label }) => ({ value: id, label }))} />}
      copy={{ text: current.text, label: "Copy request" }}
    >
      <CodePane maxH={maxH}>{current.node}</CodePane>
    </CodeCard>
  );
}

/** Example responses, one tab per status; the status is shared with the Response section. */
export function ResponseCard({ maxH }: { maxH?: BoxProps["maxH"] }) {
  const { responses, status, setStatus } = useApiState();
  const current = responses.find((item) => item.code === status) ?? responses[0];
  if (!current) return null;
  return (
    <CodeCard
      start={<CodeTabs label="Response examples" tabs={responses.map(({ code }) => ({ value: code, label: code }))} value={current.code} onChange={setStatus} mono />}
      copy={{ text: current.text, label: "Copy response" }}
    >
      <CodePane maxH={maxH}>{current.node}</CodePane>
    </CodeCard>
  );
}

/** The request and response examples, stacked. */
export function Examples({ languages, ...rest }: { languages: ExampleLanguage[] } & FlexProps) {
  const { responses } = useApiState();
  return (
    <Flex direction="column" gap="3" minH="0" {...rest}>
      <RequestCard languages={languages} />
      {responses.length ? <ResponseCard /> : null}
    </Flex>
  );
}
