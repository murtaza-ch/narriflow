"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { Upload } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Select } from "@narriflow/ui/components/select";
import { toaster } from "@narriflow/ui/components/toaster";
import {
  BrandFontsProvider,
  brandFontStyle,
  useBrandFont,
  type BrandFontChoice,
} from "./brand-fonts";
import { PlanLimitNotice } from "../../_components/plan-limit-notice";
import type { UpgradePrompt } from "../../_components/upgrade";
import { Panel } from "./brand-kit-ui";

const ROLES = [
  { role: "display", label: "Display", sample: "Headline" },
  { role: "body", label: "Body", sample: "Body text" },
  { role: "caption", label: "Caption", sample: "Caption" },
  { role: "fallback", label: "Fallback", sample: "Fallback" },
] as const;
type Role = (typeof ROLES)[number]["role"];
const SYSTEM = "system";
type Membership = {
  id: string;
  role: string;
  family: string;
  fingerprint: string;
};

function RoleSample({ font, sample }: { font?: Membership; sample: string }) {
  const loaded = useBrandFont(font ? { ...font, kind: "brand_font" } : null);
  return (
    <Stack gap="0" minW="0" flex="1">
      <Text fontSize="22px" lineHeight="1.25" truncate style={loaded ? brandFontStyle(loaded) : undefined}>
        {sample}
      </Text>
      <Text fontSize="12px" color="fg.subtle" truncate>
        {font?.family ?? "System typography"}
      </Text>
    </Stack>
  );
}

export function ProfileFontRoles({
  profileId,
  memberships,
  fonts,
  canManage,
  requirement,
  upgrade,
}: {
  profileId: string;
  memberships: Membership[];
  fonts: BrandFontChoice[];
  canManage: boolean;
  requirement: string | null;
  upgrade: UpgradePrompt | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const choices = fonts.filter((font) => font.accessUrl && !requirement);
  async function assign(role: Role, id: string) {
    const current = memberships.find((font) => font.role === role);
    if (!id && !current) return;
    setBusy(true);
    try {
      const response = await fetch(
        `/api/brand-profiles/${profileId}/membership`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "font",
            role,
            resourceId: id || current?.id,
            position: ROLES.findIndex((item) => item.role === role),
            ...(!id ? { remove: true } : {}),
          }),
        },
      );
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.message ?? "The font role could not be saved.");
      }
      router.refresh();
    } catch (error) {
      toaster.create({
        type: "error",
        title: "Font role could not be saved",
        description:
          error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      setBusy(false);
    }
  }
  const noUploads = canManage && !requirement && choices.length === 0;
  return (
    <BrandFontsProvider fonts={fonts}>
      <Panel
        title="Typography"
        action={noUploads ? (
          <Button size="sm" variant="subtle" asChild>
            <Link href="/brand-kit?tab=fonts"><Upload size={13} /> Upload a font</Link>
          </Button>
        ) : null}
      >
        {requirement ? <PlanLimitNotice message={requirement} upgrade={upgrade} /> : null}
        <Stack gap="4">
          {ROLES.map(({ role, label, sample }) => {
            const current = memberships.find((font) => font.role === role);
            const options = fonts.filter((font) => (font.accessUrl && !requirement) || font.id === current?.id);
            return (
              <Flex key={role} align="center" gap="4" minW="0">
                <Text w="16" flexShrink={0} fontSize="12px" fontWeight="500" color="fg.muted">
                  {label}
                </Text>
                <RoleSample font={current} sample={sample} />
                {canManage && options.length > 0 ? (
                  <Box w={{ base: "36", md: "44" }} flexShrink={0}>
                    <Select
                      ariaLabel={`${label} font`}
                      disabled={busy || (!!requirement && !current)}
                      value={current?.id ?? SYSTEM}
                      items={[
                        { label: "System typography", value: SYSTEM },
                        ...options.map((font) => ({ label: `${font.family} · ${font.style}`, value: font.id })),
                      ]}
                      onValueChange={(value) => {
                        if (value && value !== (current?.id ?? SYSTEM)) void assign(role, value === SYSTEM ? "" : value);
                      }}
                    />
                  </Box>
                ) : null}
              </Flex>
            );
          })}
        </Stack>
        <Text fontSize="12px" color="fg.subtle">
          Roles make fonts available to this profile&apos;s scenes.
        </Text>
      </Panel>
    </BrandFontsProvider>
  );
}
