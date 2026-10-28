import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { KeyRound, ShieldCheck, Terminal, Webhook } from "lucide-react";
import type { ReactNode } from "react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Bone, LoadingScreen } from "@narriflow/ui/components/page-loading";
import { IconTile } from "../_components/settings-ui";
import { TextBone } from "../_components/settings-skeleton";

type Column = { label: string; flex: number; from?: "sm" | "md" | "lg" };

const KEY_COLUMNS: Column[] = [
  { label: "Name", flex: 3 },
  { label: "Key", flex: 3, from: "md" },
  { label: "Access", flex: 3 },
  { label: "Last used", flex: 2, from: "sm" },
  { label: "Created", flex: 2, from: "lg" },
];
const WEBHOOK_COLUMNS: Column[] = [
  { label: "Endpoint", flex: 4 },
  { label: "Events", flex: 4, from: "md" },
  { label: "Status", flex: 2 },
  { label: "Delivery", flex: 3, from: "sm" },
];

/** A section's header as on the page: icon, title, one line, and its action on the right (a bone). */
function Section({ icon, title, description, action, children }: { icon: ReactNode; title: string; description: string; action?: ReactNode; children: ReactNode }) {
  return (
    <Box as="section">
      <Flex align={{ base: "flex-start", sm: "center" }} justify="space-between" gap="3" mb="4" direction={{ base: "column", sm: "row" }}>
        <Flex align="center" gap="3" minW="0">
          <IconTile>{icon}</IconTile>
          <Stack gap="0.5" minW="0">
            <Text as="h2" fontSize="15px" fontWeight="500">{title}</Text>
            <Text fontSize="13px" color="fg.muted">{description}</Text>
          </Stack>
        </Flex>
        {action}
      </Flex>
      {children}
    </Box>
  );
}

/** The key and webhook tables: real column labels over soft rows, with the columns the real table hides on small screens hidden too. */
function TableRows({ columns, rows }: { columns: Column[]; rows: number }) {
  const cell = (column: Column) => ({ flex: column.flex, minW: "0", display: column.from ? { base: "none", [column.from]: "flex" } : "flex" });
  return (
    <Stack gap="1">
      <Flex gap="3" px="3" pb="1" fontSize="12px" color="fg.subtle">
        {columns.map((column) => (
          <Flex key={column.label} {...cell(column)}>{column.label}</Flex>
        ))}
        <Box w="8" flexShrink={0} />
      </Flex>
      {Array.from({ length: rows }, (_, row) => (
        <Flex key={row} align="center" gap="3" px="3" h="46px" bg="bg.subtle" borderRadius="10px">
          {columns.map((column) => (
            <Flex key={column.label} {...cell(column)}>
              <Bone h="3" w="70%" />
            </Flex>
          ))}
          <Bone boxSize="8" borderRadius="control" flexShrink={0} />
        </Flex>
      ))}
    </Stack>
  );
}

/** Developer access: docs button, then the API keys, Quickstart, Callbacks and Webhooks sections as a Pro workspace sees them. */
export default function Loading() {
  return (
    <LoadingScreen label="Loading developer access" gap="10">
      <PageHeader title="Developer access" description="API keys, callbacks and webhooks for connecting your own tools." actions={<Bone h="9" w="26" borderRadius="control" />} />
      <Section icon={<KeyRound size={16} />} title="API keys" description="Each key acts for this workspace with the permissions you give it." action={<Bone h="9" w="28" borderRadius="control" flexShrink={0} />}>
        <TableRows columns={KEY_COLUMNS} rows={2} />
      </Section>
      <Section icon={<Terminal size={16} />} title="Quickstart" description="Check a key works with one request.">
        <Bone h="100px" borderRadius="12px" />
      </Section>
      <Section icon={<ShieldCheck size={16} />} title="Callbacks" description="Narriflow signs every callback so your endpoint can trust it.">
        <Flex align={{ base: "flex-start", sm: "center" }} gap="3" direction={{ base: "column", sm: "row" }} bg="bg.subtle" borderRadius="12px" p="4">
          <Flex gap="3" align="center" flex="1" minW="0">
            <IconTile>
              <Webhook size={18} />
            </IconTile>
            <Stack gap="0" minW="0">
              <Text fontSize="14px" fontWeight="500">Callback signing secret</Text>
              <TextBone w="56" line="20px" />
            </Stack>
          </Flex>
          <Bone h="9" w="32" borderRadius="control" flexShrink={0} />
        </Flex>
      </Section>
      <Section icon={<Webhook size={16} />} title="Webhooks" description="Push finished work to your tools as signed events." action={<Bone h="9" w="32" borderRadius="control" flexShrink={0} />}>
        <TableRows columns={WEBHOOK_COLUMNS} rows={2} />
      </Section>
    </LoadingScreen>
  );
}
