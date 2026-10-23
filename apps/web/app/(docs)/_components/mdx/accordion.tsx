import type { ReactNode } from "react";
import { Box, Flex, Text } from "@chakra-ui/react";
import { ChevronRight } from "lucide-react";
import { Icon } from "./icon";
import { slugify } from "./utils";

/** `<AccordionGroup>`: accordions stacked close together. */
export function AccordionGroup({ children }: { children?: ReactNode }) {
  return (
    <Box my="5" display="grid" gap="2" css={{ "& > details": { my: 0 } }}>
      {children}
    </Box>
  );
}

export interface AccordionProps {
  title: string;
  description?: string;
  icon?: string;
  defaultOpen?: boolean;
  children?: ReactNode;
}

/** `<Accordion>` is a native `<details>`: open state, keyboard and find-in-page come for free. */
export function Accordion({ title, description, icon, defaultOpen, children }: AccordionProps) {
  return (
    <Box
      asChild
      my="3"
      bg="bg.subtle"
      borderRadius="12px"
      scrollMarginTop="24"
      css={{ "&[open] > summary [data-chevron]": { transform: "rotate(90deg)" } }}
    >
      <details id={slugify(title)} open={defaultOpen}>
        <Box
          asChild
          display="flex"
          alignItems="center"
          gap="3"
          px="4"
          py="3"
          borderRadius="12px"
          cursor="pointer"
          listStyle="none"
          transition="background 120ms ease"
          _hover={{ bg: "bg.muted" }}
          css={{ "&::-webkit-details-marker": { display: "none" } }}
        >
          <summary>
            <Box data-chevron="" display="flex" color="fg.subtle" transition="transform 150ms ease" aria-hidden="true">
              <ChevronRight size={16} />
            </Box>
            {icon ? <Icon icon={icon} size={16} /> : null}
            <Box flex="1" minW="0">
              <Text m="0" fontSize="14.5px" fontWeight="500" lineHeight="1.5" color="fg">
                {title}
              </Text>
              {description ? (
                <Text m="0" fontSize="13px" lineHeight="1.5" color="fg.muted">
                  {description}
                </Text>
              ) : null}
            </Box>
          </summary>
        </Box>
        <Flex direction="column" px="4" pt="1" pb="4" ps="11" css={{ "& > :first-child": { mt: 0 }, "& > :last-child": { mb: 0 } }}>
          {children}
        </Flex>
      </details>
    </Box>
  );
}
