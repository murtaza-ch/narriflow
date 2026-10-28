import { Box, Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { AudioLines, Check, ImageIcon, LayoutTemplate, Plus, ShieldCheck, Type } from "lucide-react";
import Link from "next/link";
import {
  brandFontService,
  brandCountRequirement,
  brandPlanRequirement,
  brandProfileService,
  brandTemplateService,

} from "@narriflow/services";
import { planCountRequirement, planFeatureRequirement, planUpgradeHighlight, workspaceAllowsCapability, type CaptionPreset } from "@narriflow/validators";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { FontLibrary, FontUploadButton } from "./_components/font-manager";
import { TemplateGallery } from "./_components/template-gallery";
import { BrandMark, BrandTabs, CoverChip, PaletteDots, plural } from "./_components/brand-kit-ui";
import { StyleThumb } from "../_shared/style-thumb";
import { PlanLimitNotice } from "../_components/plan-limit-notice";
import { LockedButton, UpgradeHero } from "../_components/upgrade";
import { BrandKitVisual } from "../_components/upgrade-visuals";
import { FeatureHero } from "../_components/feature-hero";
import { AccessNote } from "../settings/_components/access-note";
import { featureUpgradePrompt } from "@/lib/feature-upgrade-prompt";

const TABS = ["profiles", "styles", "fonts"] as const;
type Tab = (typeof TABS)[number];

export default async function BrandKitPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const [actor, query] = await Promise.all([admitWorkspacePage("content.view"), searchParams]);
  const tab: Tab = TABS.includes(query.tab as Tab) ? (query.tab as Tab) : "profiles";
  const scope = {
    actorUserId: actor.actorUserId,
    workspaceId: actor.workspaceId,
    workspaceOwnerUserId: actor.workspaceOwnerUserId,
    role: actor.role,
    status: actor.status,
    pricingTier: actor.pricingTier,
    isPersonalWorkspace: actor.isPersonalWorkspace,
  };
  const [profiles, defaultProfileId, templates, fonts] = await Promise.all([
    brandProfileService.list(scope),
    brandProfileService.getDefaultId(scope),
    brandTemplateService.list(actor),
    brandFontService.list(scope),
  ]);
  const mayManageBrand = workspaceAllowsCapability(
    { role: actor.role, status: actor.status },
    "brand.manage",
  );
  const writable = mayManageBrand;
  const fontRequirement = brandPlanRequirement(actor, "brand.customFonts");
  // Brand Profiles are plan-gated by the same policy the services refuse with, including the shared-Workspace rule.
  const brandKitRequirement = brandPlanRequirement(actor, "brand.profiles");
  const hasProfiles = brandKitRequirement === null;
  const canManage = writable && hasProfiles;
  const canManageBilling = actor.role === "owner";
  // Plan boundaries shown before the user starts, with the same copy the services refuse with.
  const profileRequirement = hasProfiles ? brandCountRequirement(actor, "brand.profiles", "brandProfiles", profiles.length) : null;
  // Caption styles follow brand-template.service.ts: the feature and its count, not the shared-workspace branding rule.
  const styleRequirement =
    planCountRequirement(actor.pricingTier, "brandTemplates", templates.mine.length) ??
    planFeatureRequirement(actor.pricingTier, "brand.customTemplates");
  const canCreateProfile = canManage && profileRequirement === null;
  const brandKitTier = brandKitRequirement?.requiredTier ?? null;
  const newProfileAction = canCreateProfile ? (
    <Button asChild><Link href="/brand-kit/new">New profile</Link></Button>
  ) : writable && profileRequirement?.requiredTier ? (
    <LockedButton
      prompt={{
        tier: profileRequirement.requiredTier,
        headline: "Upgrade to add more Brand Profiles",
        highlight: planUpgradeHighlight(profileRequirement.requiredTier, "brandProfiles"),
        canManageBilling,
      }}
    >
      New profile
    </LockedButton>
  ) : undefined;
  const styleUpgrade = styleRequirement?.requiredTier
    ? {
        tier: styleRequirement.requiredTier,
        headline: "Upgrade to save your own caption styles",
        highlight: planUpgradeHighlight(styleRequirement.requiredTier, "brandTemplates"),
        canManageBilling,
      }
    : null;
  const customStylesUpgrade = featureUpgradePrompt(actor.pricingTier, "brand.customTemplates", "Upgrade to use your own caption styles");
  const newStyleAction = !mayManageBrand ? null : styleRequirement === null ? (
    <Button asChild><Link href="/brand-kit/styles/new">New style</Link></Button>
  ) : styleUpgrade ? (
    <LockedButton prompt={styleUpgrade}>
      New style
    </LockedButton>
  ) : null;
  const fontUpgrade = fontRequirement?.requiredTier
    ? { tier: fontRequirement.requiredTier, headline: "Upgrade to use custom fonts", highlight: planUpgradeHighlight(fontRequirement.requiredTier, "brand.customFonts"), canManageBilling }
    : null;
  const uploadFontAction = !mayManageBrand ? null : fontRequirement === null ? (
    <FontUploadButton />
  ) : fontUpgrade ? (
    <LockedButton prompt={fontUpgrade}>Upload font</LockedButton>
  ) : null;

  const presets = new Map<string, CaptionPreset>([...templates.builtIns, ...templates.mine].map((template) => [template.id, template.captionPreset]));
  const profileByStyle = Object.fromEntries(profiles.flatMap((profile) => profile.templates.map((style) => [style.id, profile.name] as const)));
  const actions = { profiles: hasProfiles ? newProfileAction : undefined, styles: newStyleAction ?? undefined, fonts: uploadFontAction ?? undefined }[tab];

  return (
    <Stack gap="8">
      <Box animation="fade-up" animationFillMode="backwards">
        <PageHeader
          title="Brand kit"
          description="Manage your brand colors, fonts, assets, and caption styles."
          actions={actions}
        />
        <AccessNote access={actor} capability="brand.manage" action="change the brand kit" mt="4" />
      </Box>

      <Stack gap="6" animation="fade-up" animationFillMode="backwards" style={{ animationDelay: "60ms" }}>
        <BrandTabs
          label="Brand kit"
          tabs={[
            { label: "Profiles", href: "/brand-kit", active: tab === "profiles", count: profiles.length },
            { label: "Caption styles", href: "/brand-kit?tab=styles", active: tab === "styles", count: templates.mine.length },
            { label: "Fonts", href: "/brand-kit?tab=fonts", active: tab === "fonts", count: fonts.length },
          ]}
        />

        {tab === "profiles" ? (
          <Stack gap="5">
            {mayManageBrand && profileRequirement && !profileRequirement.requiredTier ? (
              <PlanLimitNotice message={`${profileRequirement.message} Remove a profile to add another.`} upgrade={null} />
            ) : null}
            {!hasProfiles ? (
              <UpgradeHero
                title="Keep every clip on brand"
                points={["Keep your logo, colors, fonts, and caption styles in one place.", "Apply them to new projects automatically."]}
                ctaLabel="Upgrade to build your brand kit"
                visual={<BrandKitVisual />}
                prompt={{
                  tier: brandKitTier,
                  headline: "Upgrade to build your brand kit",
                  highlight: brandKitTier ? planUpgradeHighlight(brandKitTier, "brandProfiles") : undefined,
                  canManageBilling,
                }}
              />
            ) : null}
            {/* Profiles kept after a downgrade stay listed and readable. */}
            {profiles.length === 0 ? (hasProfiles ? (
              <FeatureHero
                title="No Brand Profiles yet"
                points={[
                  "Keep your logo, colors, fonts, and caption styles in one place.",
                  "New projects with the profile start on brand, with its default style and music.",
                ]}
                visual={<BrandKitVisual />}
                action={canCreateProfile ? (
                  <Button size="sm" asChild>
                    <Link href="/brand-kit/new">
                      <Plus size={15} aria-hidden /> Build your first profile
                    </Link>
                  </Button>
                ) : undefined}
              />
            ) : null) : (
              <Grid templateColumns={{ base: "1fr", md: "repeat(2, minmax(0, 1fr))", xl: "repeat(3, minmax(0, 1fr))" }} gap="4">
                {profiles.map((profile) => {
                  const defaultStyle = profile.templates.find((template) => template.id === profile.defaultTemplateId);
                  const displayFont = profile.fonts.find((font) => font.role === "display") ?? profile.fonts[0];
                  const logo = profile.assets.find((asset) => asset.id === profile.identity.primaryLogoAssetId || asset.role === "logo");
                  const preset = defaultStyle ? presets.get(defaultStyle.id) : undefined;
                  return (
                    <ProfileCard
                      key={profile.id}
                      href={`/brand-kit/${profile.id}`}
                      name={profile.name}
                      colors={profile.identity}
                      logoUrl={logo?.accessUrl ?? null}
                      preset={preset ?? null}
                      isDefault={profile.id === defaultProfileId}
                      approvalRequired={profile.approvalRule === "approval_required"}
                      subtitle={`${defaultStyle?.name ?? "No default style"} · ${displayFont ? displayFont.family : "System typography"}`}
                      stats={[
                        { icon: <LayoutTemplate size={13} />, label: plural(profile.templates.length, "style") },
                        { icon: <ImageIcon size={13} />, label: plural(profile.assets.length, "asset") },
                        { icon: <Type size={13} />, label: plural(profile.fonts.length, "font") },
                        { icon: <AudioLines size={13} />, label: `${profile.audio.length} audio` },
                      ]}
                    />
                  );
                })}
              </Grid>
            )}
          </Stack>
        ) : null}

        {tab === "styles" ? (
          <Stack gap="5">
            {mayManageBrand && styleRequirement && !styleRequirement.requiredTier ? <PlanLimitNotice message={`${styleRequirement.message} Delete a style to add another.`} upgrade={null} /> : null}
            <TemplateGallery
              builtIns={templates.builtIns}
              mine={templates.mine}
              defaultId={templates.defaultId}
              profileByStyle={profileByStyle}
              access={{
                canManage: mayManageBrand,
                // Choosing the workspace default is a workspace setting (brand-template.service.ts setDefault).
                canSetDefault: workspaceAllowsCapability({ role: actor.role, status: actor.status }, "workspace.manage"),
                customUpgrade: customStylesUpgrade ? { ...customStylesUpgrade, canManageBilling } : null,
                duplicateBlocked: styleRequirement ? { upgrade: styleUpgrade } : null,
              }}
            />
          </Stack>
        ) : null}

        {tab === "fonts" ? (
          <Stack gap="5">
            {fontRequirement ? <PlanLimitNotice message={fontRequirement.message} upgrade={fontUpgrade} /> : null}
            <FontLibrary fonts={fonts} canManage={mayManageBrand} />
          </Stack>
        ) : null}
      </Stack>
    </Stack>
  );
}

function ProfileCard({
  href,
  name,
  colors,
  logoUrl,
  preset,
  isDefault,
  approvalRequired,
  subtitle,
  stats,
}: {
  href: string;
  name: string;
  colors: { primaryColor: string; secondaryColor: string; accentColor: string | null };
  logoUrl: string | null;
  preset: CaptionPreset | null;
  isDefault: boolean;
  approvalRequired: boolean;
  subtitle: string;
  stats: { icon: React.ReactNode; label: string }[];
}) {
  return (
    <Box asChild display="block" className="group" bg="bg.subtle" borderRadius="l3" overflow="hidden">
      <Link href={href} aria-label={`Open ${name}`}>
        <Box position="relative" aspectRatio={16 / 9} overflow="hidden" bg="studio.canvas">
          {preset ? (
            <Box position="absolute" inset="0" transition="transform 400ms cubic-bezier(0.22, 1, 0.36, 1)" _groupHover={{ transform: "scale(1.03)" }}>
              <StyleThumb preset={preset} seed={href} aspectRatio="16 / 9" boost={0.95} captionTopPct={62} imageSizes="(min-width: 1280px) 33vw, (min-width: 768px) 50vw, 100vw" />
            </Box>
          ) : (
            <Stack position="absolute" inset="0" align="center" justify="center" gap="2" style={{ background: colors.secondaryColor }}>
              <Text fontFamily="display" fontWeight="600" fontSize="56px" lineHeight="1" letterSpacing="-0.04em" style={{ color: colors.primaryColor }}>
                Aa
              </Text>
              <Box h="4px" w="10" borderRadius="full" style={{ background: colors.accentColor ?? colors.primaryColor }} />
            </Stack>
          )}
          <Flex position="absolute" top="3" left="3" right="3" justify="space-between" gap="2" pointerEvents="none">
            {isDefault ? <CoverChip icon={<Check size={12} />}>Default</CoverChip> : <span />}
            {approvalRequired ? <CoverChip icon={<ShieldCheck size={12} />}>Approval required</CoverChip> : null}
          </Flex>
        </Box>
        <Stack gap="3.5" p="4">
          <Flex align="center" gap="3" minW="0">
            <BrandMark colors={colors} logoUrl={logoUrl} name={name} size={40} />
            <Stack gap="0.5" minW="0" flex="1">
              <Text fontSize="15px" fontWeight="500" truncate>
                {name}
              </Text>
              <Text fontSize="12.5px" color="fg.muted" truncate>
                {subtitle}
              </Text>
            </Stack>
            <PaletteDots colors={colors} />
          </Flex>
          <Flex gap="4" color="fg.subtle" flexWrap="wrap">
            {stats.map((stat) => (
              <Flex key={stat.label} align="center" gap="1.5">
                {stat.icon}
                <Text fontSize="12px" fontVariantNumeric="tabular-nums">
                  {stat.label}
                </Text>
              </Flex>
            ))}
          </Flex>
        </Stack>
      </Link>
    </Box>
  );
}
