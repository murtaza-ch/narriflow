"use client";

import type { ReactNode } from "react";
import { Flex } from "@chakra-ui/react";
import { useApiState } from "./api-state";
import { ChoiceMenu } from "./choice-menu";
import { Chip } from "./chip";
import { Section } from "./section";

export interface ResponsePanel {
  code: string;
  description?: string;
  contentType?: string;
  rows: ReactNode;
}

/** The Response block: a status-code menu, the content type, and the fields of the selected status. */
export function ResponseSection({ panels }: { panels: ResponsePanel[] }) {
  const { status, setStatus } = useApiState();
  const current = panels.find((panel) => panel.code === status) ?? panels[0];
  if (!current) return null;
  return (
    <Section
      title="Response"
      aside={
        <Flex align="center" gap="2">
          <ChoiceMenu label="Status code" variant="subtle" mono value={current.code} onChange={setStatus} options={panels.map(({ code }) => ({ value: code, label: code }))} />
          {current.contentType ? <Chip>{current.contentType}</Chip> : null}
        </Flex>
      }
      subtitle={current.description}
    >
      {current.rows}
    </Section>
  );
}
