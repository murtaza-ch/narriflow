import { Box, Flex, Text } from "@chakra-ui/react";
import { CreditCard, Palette, Share2 } from "lucide-react";
import { NavLink } from "@narriflow/ui/components/nav-link";

const SETTINGS_LINKS = [
  { label: "Brand templates", href: "/settings/brand-templates", icon: Palette },
  { label: "Social accounts", href: "/settings/social", icon: Share2 },
  { label: "Billing & plans", href: "/settings/billing", icon: CreditCard },
] as const;

/**
 * Settings shell — one surface for brand templates, social, and billing.
 * Desktop: a slim sticky side rail on the left, page content right. Mobile:
 * the rail collapses into a horizontally scrollable tab row above the page.
 * Each page owns its PageHeader; this layout only draws the rail.
 */
export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Flex
      direction={{ base: "column", lg: "row" }}
      align="flex-start"
      gap={{ base: "5", lg: "10" }}
      maxW="1120px"
      mx="auto"
      w="full"
    >
      <Box
        as="nav"
        aria-label="Settings sections"
        w={{ base: "full", lg: "200px" }}
        flexShrink={0}
        position={{ lg: "sticky" }}
        top={{ lg: "20" }}
      >
        <Text
          textStyle="eyebrow"
          color="fg.subtle"
          px="3"
          mb="2"
          display={{ base: "none", lg: "block" }}
        >
          Settings
        </Text>
        <Flex
          direction={{ base: "row", lg: "column" }}
          gap="1"
          overflowX={{ base: "auto", lg: "visible" }}
          borderBottomWidth={{ base: "1px", lg: "0" }}
          borderColor="border"
          pb={{ base: "2", lg: "0" }}
          css={{
            scrollbarWidth: "none",
            "&::-webkit-scrollbar": { display: "none" },
          }}
        >
          {SETTINGS_LINKS.map(({ label, href, icon: Icon }) => (
            <Box key={href} flexShrink={0}>
              <NavLink href={href} icon={<Icon size={14} />}>
                {label}
              </NavLink>
            </Box>
          ))}
        </Flex>
      </Box>

      <Box flex="1" minW="0" w="full">
        {children}
      </Box>
    </Flex>
  );
}
