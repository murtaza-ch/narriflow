import type { ReactNode } from "react";
import { Box, Flex } from "@chakra-ui/react";
import { Icon } from "./icon";

export interface StepProps {
  title?: string;
  icon?: string;
  /** Replaces the automatic number. */
  stepNumber?: number;
  titleSize?: "p" | "h2" | "h3" | "h4";
  children?: ReactNode;
}

/** `<Steps>`: numbered steps, counted in CSS so `<Step>` needs no index. */
export function Steps({ children }: { children?: ReactNode }) {
  return (
    <Box as="ol" my="6" p="0" listStyleType="none" css={{ counterReset: "step" }}>
      {children}
    </Box>
  );
}

export function Step({ title, icon, stepNumber, titleSize = "p", children }: StepProps) {
  return (
    <Box
      as="li"
      display="grid"
      gridTemplateColumns="28px minmax(0, 1fr)"
      columnGap={{ base: "3", md: "4" }}
      position="relative"
      mb="0"
      ps="0"
      pb="6"
      css={{
        counterIncrement: "step",
        // A faint thread from one marker to the next.
        "&:not(:last-child)::before": {
          content: '""',
          position: "absolute",
          insetInlineStart: "13px",
          top: "36px",
          bottom: "8px",
          w: "2px",
          borderRadius: "full",
          bg: "bg.soft",
        },
        "&:last-child": { pb: 0 },
      }}
    >
      <Flex boxSize="7" borderRadius="full" bg="bg.muted" align="center" justify="center" fontSize="13px" fontWeight="600" color="fg" aria-hidden="true">
        {icon ? <Icon icon={icon} size={14} /> : stepNumber ?? <Box as="span" css={{ "&::before": { content: "counter(step)" } }} />}
      </Flex>
      <Box minW="0" css={{ "& > :first-child": { mt: 0 }, "& > :last-child": { mb: 0 } }}>
        {title ? (
          <Box as={titleSize} m="0" mb="2" fontSize="16px" fontWeight="600" lineHeight="28px" color="fg">
            {title}
          </Box>
        ) : null}
        {children}
      </Box>
    </Box>
  );
}
