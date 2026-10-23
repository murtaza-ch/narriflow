"use client";

import { useId, useState, type ReactNode } from "react";
import { Box, chakra } from "@chakra-ui/react";
import { ChevronRight } from "lucide-react";
import { FieldList } from "./field-list";

export interface ExpandableProps {
  /** Noun phrase after "Show"/"Hide". */
  title?: string;
  defaultOpen?: boolean;
  children?: ReactNode;
}

/** A soft toggle that folds child attributes away; what it opens is a nested field list. */
export function Expandable({ title = "child attributes", defaultOpen = false, children }: ExpandableProps) {
  const [open, setOpen] = useState(defaultOpen);
  const panel = useId();
  return (
    <Box mt="3">
      <chakra.button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen(!open)}
        display="inline-flex"
        alignItems="center"
        gap="1.5"
        h="8"
        ps="2.5"
        pe="3"
        bg="bg.soft"
        borderRadius="control"
        fontSize="13px"
        fontWeight="500"
        color="fg.muted"
        cursor="pointer"
        transition="background 120ms ease, color 120ms ease"
        _hover={{ bg: "bg.softHover", color: "fg" }}
      >
        <Box as="span" display="flex" transform={open ? "rotate(90deg)" : undefined} transition="transform 150ms ease">
          <ChevronRight size={14} />
        </Box>
        {`${open ? "Hide" : "Show"} ${title}`}
      </chakra.button>
      {open ? (
        <FieldList id={panel} nested mt="3">
          {children}
        </FieldList>
      ) : null}
    </Box>
  );
}
