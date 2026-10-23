import type { ReactNode } from "react";
import { Box } from "@chakra-ui/react";

/** `<Panel>`: Mintlify moves it to a side column; with a single column it stays in the flow. */
export function Panel({ children }: { children?: ReactNode }) {
  return <Box my="5">{children}</Box>;
}
