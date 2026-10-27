"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { NativeSelect, Stack, Text } from "@chakra-ui/react";
import { toaster } from "@narriflow/ui/components/toaster";
import {
  BrandFontsProvider,
  brandFontStyle,
  useBrandFont,
  type BrandFontChoice,
} from "./brand-fonts";
import { PlanLimitNotice } from "../../_components/plan-limit-notice";
import type { UpgradePrompt } from "../../_components/upgrade";

const ROLES = ["display", "body", "caption", "fallback"] as const;
type Role = (typeof ROLES)[number];
type Membership = {
  id: string;
  role: string;
  family: string;
  fingerprint: string;
};

function RolePreview({ font }: { font?: Membership }) {
  const loaded = useBrandFont(font ? { ...font, kind: "brand_font" } : null);
  return (
    <Text fontSize="18px" style={loaded ? brandFontStyle(loaded) : undefined}>
      {font?.family ?? "System typography"}
    </Text>
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
            position: ROLES.indexOf(role),
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
  return (
    <BrandFontsProvider fonts={fonts}>
      <Stack gap="4" bg="bg.soft" borderRadius="l3" p="5">
        <Text textStyle="eyebrow" color="fg.muted">
          Type roles
        </Text>
        {requirement ? (
          <PlanLimitNotice message={requirement} upgrade={upgrade} />
        ) : null}
        {ROLES.map((role) => {
          const current = memberships.find((font) => font.role === role);
          return (
            <Stack key={role} gap="2">
              <Text fontSize="12px" color="fg.muted" textTransform="capitalize">
                {role}
              </Text>
              <RolePreview font={current} />
              {canManage ? (
                <NativeSelect.Root
                  size="sm"
                  disabled={busy || (!!requirement && !current)}
                >
                  <NativeSelect.Field
                    aria-label={`${role} font`}
                    value={current?.id ?? ""}
                    onChange={(event) =>
                      assign(role, event.currentTarget.value)
                    }
                    bg="bg.panel"
                    borderWidth="0"
                    borderRadius="l2"
                    _focusVisible={{ bg: "bg.muted", outline: "none" }}
                  >
                    <option value="">Use system typography</option>
                    {fonts
                      .filter(
                        (font) =>
                          (font.accessUrl && !requirement) ||
                          font.id === current?.id,
                      )
                      .map((font) => (
                        <option key={font.id} value={font.id}>
                          {font.family} · {font.style}
                        </option>
                      ))}
                  </NativeSelect.Field>
                  <NativeSelect.Indicator />
                </NativeSelect.Root>
              ) : null}
            </Stack>
          );
        })}
        <Text fontSize="12px" color="fg.muted">
          Upload fonts in Brand kit. Roles make them available to this profile's
          Scene Templates. Caption styles and Studio let you choose the font for
          each design.
        </Text>
      </Stack>
    </BrandFontsProvider>
  );
}
