import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import {
  Bell,
  Braces,
  Building2,
  ChartNoAxesCombined,
  CreditCard,
  Share2,
  UserRound,
  Users,
} from "lucide-react";
import { NavLink } from "@narriflow/ui/components/nav-link";
import { workspaceAllowsCapability } from "@narriflow/services";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";

const ACCOUNT_LINKS = [
  { label: "Profile", href: "/settings/profile", icon: UserRound },
  { label: "Notifications", href: "/settings/notifications", icon: Bell },
] as const;

const WORKSPACE_LINKS = [
  { label: "Workspace settings", href: "/settings/workspace", icon: Building2 },
  { label: "Members", href: "/settings/members", icon: Users },
  { label: "Social accounts", href: "/settings/social-accounts", icon: Share2 },
  { label: "Billing", href: "/settings/billing", icon: CreditCard },
  { label: "Usage history", href: "/settings/usage", icon: ChartNoAxesCombined },
  { label: "Developer access", href: "/settings/api", icon: Braces },
] as const;

function SettingsGroup({
  label,
  links,
}: {
  label: string;
  links: ReadonlyArray<{ label: string; href: string; icon: typeof UserRound }>;
}) {
  return (
    <Stack gap="1" direction={{ base: "row", lg: "column" }} flexShrink={0}>
      <Text
        textStyle="eyebrow"
        color="fg.subtle"
        px="3"
        pt="3"
        pb="1.5"
        display={{ base: "none", lg: "block" }}
      >
        {label}
      </Text>
      {links.map(({ label: itemLabel, href, icon: Icon }) => (
        <Box key={href} flexShrink={0}>
          <NavLink href={href} icon={<Icon size={14} />}>
            {itemLabel}
          </NavLink>
        </Box>
      ))}
    </Stack>
  );
}

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const appUser = await admitWorkspacePage("content.view");
  const workspaceLinks = workspaceAllowsCapability(appUser.workspace, "api.manage")
    ? WORKSPACE_LINKS
    : WORKSPACE_LINKS.filter((link) => link.href !== "/settings/api");
  return (
    <Flex
      direction={{ base: "column", lg: "row" }}
      align="flex-start"
      gap={{ base: "5", lg: "10" }}
      maxW="1180px"
      mx="auto"
      w="full"
    >
      <Box
        as="nav"
        minW="0"
        aria-label="Settings sections"
        w={{ base: "full", lg: "220px" }}
        flexShrink={0}
        position={{ lg: "sticky" }}
        top={{ lg: "20" }}
      >
        <Flex
          direction={{ base: "row", lg: "column" }}
          gap={{ base: "4", lg: "2" }}
          overflowX={{ base: "auto", lg: "visible" }}
          borderBottomWidth={{ base: "1px", lg: "0" }}
          borderColor="border"
          pb={{ base: "3", lg: "0" }}
          css={{ scrollbarWidth: "none", "&::-webkit-scrollbar": { display: "none" } }}
        >
          <SettingsGroup label="Your account" links={ACCOUNT_LINKS} />
          <SettingsGroup label={appUser.workspace.workspaceName} links={workspaceLinks} />
        </Flex>
      </Box>
      <Box flex="1" minW="0" w="full">
        {children}
      </Box>
    </Flex>
  );
}
