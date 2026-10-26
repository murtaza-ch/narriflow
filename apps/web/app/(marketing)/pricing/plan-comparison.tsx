import { Box, Flex, Stack, Table, Text } from "@chakra-ui/react";
import { Check, Minus } from "lucide-react";
import { PLAN_CATALOG, PRICING_TIER_ORDER, planComparison } from "@narriflow/validators";

function Cell({ value }: { value: string | boolean }) {
  if (value === true) {
    return (
      <Flex color="fg" aria-label="Included">
        <Check size={14} aria-hidden="true" />
      </Flex>
    );
  }
  if (value === false) {
    return (
      <Flex color="fg.subtle" aria-label="Not included">
        <Minus size={14} aria-hidden="true" />
      </Flex>
    );
  }
  return (
    <Text as="span" textStyle="data" fontSize="13px" color="fg">
      {value}
    </Text>
  );
}

const rowCell = {
  py: "2.5",
  px: "0",
  pe: "4",
  borderColor: "border.subtle",
  bg: "transparent",
} as const;

/** Every plan limit and feature, derived from the plan catalog that billing enforces. */
export function PlanComparison() {
  return (
    <Stack gap="6">
      <Text as="h2" textStyle="eyebrow" color="fg.muted">
        Compare plans
      </Text>
      <Box overflowX="auto">
        <Table.Root size="sm" minW="640px" css={{ tableLayout: "fixed" }}>
          <Table.Header>
            <Table.Row bg="transparent">
              <Table.ColumnHeader {...rowCell} w="34%">
                <Box srOnly>Feature</Box>
              </Table.ColumnHeader>
              {PRICING_TIER_ORDER.map((tier) => (
                <Table.ColumnHeader key={tier} {...rowCell} textStyle="eyebrow" color="fg">
                  {PLAN_CATALOG[tier].name}
                </Table.ColumnHeader>
              ))}
            </Table.Row>
          </Table.Header>
          {planComparison().map((group) => (
            <Table.Body key={group.title}>
              <Table.Row bg="transparent">
                <Table.ColumnHeader
                  {...rowCell}
                  colSpan={PRICING_TIER_ORDER.length + 1}
                  scope="colgroup"
                  pt="6"
                  fontSize="13px"
                  fontWeight="600"
                  color="fg"
                >
                  {group.title}
                </Table.ColumnHeader>
              </Table.Row>
              {group.rows.map((row) => (
                <Table.Row key={row.label} bg="transparent">
                  <Table.ColumnHeader {...rowCell} scope="row" fontSize="13px" fontWeight="400" color="fg.muted">
                    {row.label}
                  </Table.ColumnHeader>
                  {PRICING_TIER_ORDER.map((tier) => (
                    <Table.Cell key={tier} {...rowCell}>
                      <Cell value={row.values[tier]} />
                    </Table.Cell>
                  ))}
                </Table.Row>
              ))}
            </Table.Body>
          ))}
        </Table.Root>
      </Box>
    </Stack>
  );
}
