import type { ReactNode } from "react";
import { Box, Flex, Text } from "@chakra-ui/react";
import { ChevronRight, File, Folder } from "lucide-react";

const ROW = { alignItems: "center", gap: "2", px: "2", py: "1", borderRadius: "8px", fontSize: "14px", lineHeight: "1.5" } as const;

function Tree({ children }: { children?: ReactNode }) {
  return (
    <Box my="5" css={{ "& > details, & > div": { ms: 0 } }}>
      {children}
    </Box>
  );
}

/** A folder is a native `<details>`: it opens and closes with no script. */
function TreeFolder({ name, defaultOpen, children }: { name: string; defaultOpen?: boolean; children?: ReactNode }) {
  return (
    <Box asChild css={{ "&[open] > summary [data-chevron]": { transform: "rotate(90deg)" } }}>
      <details open={defaultOpen}>
        <Box asChild display="flex" {...ROW} cursor="pointer" listStyle="none" color="fg" _hover={{ bg: "bg.soft" }} css={{ "&::-webkit-details-marker": { display: "none" } }}>
          <summary>
            <Box data-chevron="" display="flex" color="fg.subtle" transition="transform 150ms ease" aria-hidden="true">
              <ChevronRight size={14} />
            </Box>
            <Box color="fg.muted" display="flex" aria-hidden="true">
              <Folder size={16} />
            </Box>
            <Text as="span" truncate>
              {name}
            </Text>
          </summary>
        </Box>
        <Box ms="5">{children}</Box>
      </details>
    </Box>
  );
}

function TreeFile({ name }: { name: string }) {
  return (
    <Flex {...ROW} ps="7" color="fg.muted">
      <File size={16} aria-hidden="true" />
      <Text as="span" truncate>
        {name}
      </Text>
    </Flex>
  );
}

/** `<Tree>` with `<Tree.Folder name defaultOpen>` and `<Tree.File name>`. */
const TreeRoot = Object.assign(Tree, { Folder: TreeFolder, File: TreeFile });
export { TreeRoot as Tree };
