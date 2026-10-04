import { Flex, Text } from "@chakra-ui/react";
import { CircleAlert } from "lucide-react";

/**
 * Inline form error — danger tokens + icon, announced via role="alert".
 * Renders nothing when there is no message.
 */
export function FormError({ message }: { message: string | null }) {
  if (!message) return null;

  return (
    <Flex
      role="alert"
      gap="2"
      align="flex-start"
      px="3"
      py="2"
      borderRadius="l2"
      borderWidth="1px"
      borderColor="danger.emphasized"
      bg="danger.subtle"
      color="danger.fg"
      animation="fade-up"
    >
      <Flex flexShrink={0} pt="0.5">
        <CircleAlert size={14} />
      </Flex>
      <Text fontSize="13px" lineHeight="1.5">
        {message}
      </Text>
    </Flex>
  );
}
