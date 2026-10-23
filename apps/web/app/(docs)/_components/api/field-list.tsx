import type { ReactNode } from "react";
import { Flex, type FlexProps } from "@chakra-ui/react";

/**
 * A grouped list of field rows: one rounded container whose rows are set
 * apart by a thin gap of what lies beneath, never a line. A field's child
 * attributes are a nested list one fill deeper (soft fills stack), so the
 * hierarchy reads without borders or extra indentation rules.
 */
export function FieldList({ nested, children, ...rest }: { nested?: boolean; children: ReactNode } & FlexProps) {
  return (
    <Flex
      direction="column"
      gap="2px"
      overflow="hidden"
      borderRadius={nested ? "10px" : "12px"}
      borderWidth={nested ? "0" : "1px"}
      borderColor="border.card"
      css={{ "& > *": { bg: nested ? "bg.soft" : "bg.subtle" } }}
      {...rest}
    >
      {children}
    </Flex>
  );
}
