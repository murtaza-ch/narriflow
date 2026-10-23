import type { ComponentPropsWithoutRef } from "react";
import { Box } from "@chakra-ui/react";

/** Wide tables scroll sideways instead of stretching the page. */
export function Table(props: ComponentPropsWithoutRef<"table">) {
  return (
    <Box tabIndex={0} role="region" aria-label="Table" my="5" overflowX="auto" css={{ scrollbarWidth: "thin" }}>
      <table {...props} />
    </Box>
  );
}
