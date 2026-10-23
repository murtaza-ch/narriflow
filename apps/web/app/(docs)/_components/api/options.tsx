"use client";

import { useState } from "react";
import { Flex } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { Chip } from "./chip";

/** Long option lists (a language code per entry) stay short until asked for. */
const COLLAPSED = 16;

export function Options({ values }: { values: unknown[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? values : values.slice(0, COLLAPSED);
  return (
    <Flex mt="2" wrap="wrap" align="center" gap="1.5" fontSize="12.5px" color="fg.subtle">
      Available options:
      {shown.map((value) => (
        <Chip key={String(value)} color="fg">
          {String(value)}
        </Chip>
      ))}
      {values.length > COLLAPSED ? (
        <Button type="button" variant="ghost" size="xs" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show ${values.length - COLLAPSED} more`}
        </Button>
      ) : null}
    </Flex>
  );
}
