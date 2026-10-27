import { Box, Flex, Grid, Image, Stack, Text } from "@chakra-ui/react";
import { ArrowRight, AudioLines, Check, ImageIcon, Type } from "lucide-react";
import Link from "next/link";
import {
  brandFontService,
  brandCountRequirement,
  brandPlanRequirement,
  brandProfileService,
  brandTemplateService,

} from "@narriflow/services";
import { planCountRequirement, planFeatureRequirement, planUpgradeHighlight, workspaceAllowsCapability } from "@narriflow/validators";
import { Button } from "@narriflow/ui/components/button";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { FontManager } from "./_components/font-manager";
import { TemplateGallery } from "./_components/template-gallery";
import { BrandProfileDefaultButton } from "./_components/brand-profile-default-button";
import { BrandProfileDeleteButton } from "./_components/brand-profile-delete-button";
import { PlanLimitNotice } from "../_components/plan-limit-notice";
import { LockedButton, UpgradeHero } from "../_components/upgrade";
import { BrandKitVisual } from "../_components/upgrade-visuals";
import { AccessNote } from "../settings/_components/access-note";
import { featureUpgradePrompt } from "@/lib/feature-upgrade-prompt";

export default async function BrandKitPage() {
  const actor = await admitWorkspacePage("content.view");
  const scope = {
    actorUserId: actor.actorUserId,
    workspaceId: actor.workspaceId,
    workspaceOwnerUserId: actor.workspaceOwnerUserId,
    role: actor.role,
    status: actor.status,
    pricingTier: actor.pricingTier,
    isPersonalWorkspace: actor.isPersonalWorkspace,
  };
  const [profiles, defaultProfileId, usage, templates, fonts] = await Promise.all([
    brandProfileService.list(scope),
    brandProfileService.getDefaultId(scope),
    brandProfileService.usage(scope),
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
    <Button size="sm" variant="subtle" asChild><Link href="/brand-kit/styles/new">New style</Link></Button>
  ) : styleUpgrade ? (
    <LockedButton size="sm" variant="subtle" prompt={styleUpgrade}>
      New style
    </LockedButton>
  ) : null;

  return (
    <Stack gap="10">
      <Box animation="fade-up" animationFillMode="backwards">
        <PageHeader
          title="Brand kit"
          description="Manage your brand colors, fonts, assets, and caption styles."
          actions={hasProfiles ? newProfileAction : undefined}
        />
        <AccessNote access={actor} capability="brand.manage" action="change the brand kit" mt="-4" />
        {mayManageBrand && profileRequirement && !profileRequirement.requiredTier ? (
          <PlanLimitNotice message={`${profileRequirement.message} Remove a profile to add another.`} upgrade={null} />
        ) : null}
      </Box>

      <Stack gap="6" animation="fade-up" animationFillMode="backwards" style={{ animationDelay: "90ms" }}>
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
          <EmptyState
            icon={<ImageIcon size={20} />}
            title="No Brand Profiles yet"
            description="Save your brand colors, styles, and assets."
            action={canCreateProfile ? <Button size="sm" variant="subtle" asChild><Link href="/brand-kit/new">New profile</Link></Button> : undefined}
          />
        ) : null) : (
          <Grid templateColumns={{ base: "1fr", lg: "repeat(2, minmax(0, 1fr))" }} gap="5">
            {profiles.map((profile) => {
              const defaultStyle = profile.templates.find((template) => template.id === profile.defaultTemplateId) ?? profile.templates[0];
              const displayFont = profile.fonts.find((font) => font.role === "display") ?? profile.fonts[0];
              const logo = profile.assets.find(
                (asset) =>
                  asset.id === profile.identity.primaryLogoAssetId ||
                  asset.role === "logo",
              );
              const isDefault = profile.id === defaultProfileId;
              return (
                <Box key={profile.id} as="article" position="relative" borderRadius="l3" borderWidth="1px" borderColor="border.card" bg="bg.panel" py="5" ps="5" pe="4">
                  <Flex align="flex-start" justify="space-between" gap="5">
                    <Stack gap="5" minW="0" flex="1">
                      <Flex align="center" gap="3">
                        {isDefault && <Flex align="center" gap="1.5" color="accent.fg"><Check size={12} /><Text textStyle="eyebrow">Default</Text></Flex>}
                      </Flex>
                      <Flex gap="3" align="center">
                        <Flex
                          w="12"
                          h="12"
                          flexShrink="0"
                          align="center"
                          justify="center"
                          overflow="hidden"
                          borderRadius="l2"
                          bg="bg.soft"
                          color="fg.muted"
                        >
                          {logo?.accessUrl ? (
                            <Image
                              src={logo.accessUrl}
                              alt={`${profile.name} logo`}
                              w="full"
                              h="full"
                              objectFit="contain"
                            />
                          ) : (
                            <ImageIcon size={17} />
                          )}
                        </Flex>
                        <Stack gap="1" minW="0">
                          <Text textStyle="title" fontSize="lg" lineClamp={1}>{profile.name}</Text>
                          <Text fontSize="12.5px" color="fg.muted">{defaultStyle?.name ?? "No style selected"} · {displayFont ? `${displayFont.family} ${displayFont.weight}` : "System typography"}</Text>
                        </Stack>
                      </Flex>
                      <Flex gap="2" flexWrap="wrap">
                        {[profile.identity.primaryColor, profile.identity.secondaryColor, profile.identity.accentColor].filter((color): color is string => Boolean(color)).map((color) => <Box key={color} w="30px" h="8px" borderRadius="l1" borderWidth="1px" borderColor="border.card" style={{ background: color }} />)}
                      </Flex>
                      <Flex gap="5" color="fg.muted" flexWrap="wrap">
                        <Flex align="center" gap="1.5"><ImageIcon size={13} /><Text fontSize="12px" fontVariantNumeric="tabular-nums">{profile.assets.length} assets</Text></Flex>
                        <Flex align="center" gap="1.5"><Type size={13} /><Text fontSize="12px" fontVariantNumeric="tabular-nums">{profile.fonts.length} fonts</Text></Flex>
                        <Flex align="center" gap="1.5"><AudioLines size={13} /><Text fontSize="12px" fontVariantNumeric="tabular-nums">{profile.audio.length} audio</Text></Flex>
                      </Flex>
                    </Stack>
                    <Stack align="flex-end" justify="space-between" minH="176px">
                      <Text textStyle="eyebrow" color={profile.approvalRule === "approval_required" ? "accent.fg" : "fg.muted"}>{profile.approvalRule === "approval_required" ? "Approval required" : "Direct publish"}</Text>
                      <Button size="sm" variant="subtle" asChild><Link href={`/brand-kit/${profile.id}`}>Open <ArrowRight size={13} /></Link></Button>
                      <Flex gap="1">
                        {canManage && !isDefault && <BrandProfileDefaultButton profileId={profile.id} />}
                        {/* Deleting is role-only on every plan; the dialog moves the default and Recipes to a replacement. */}
                        {mayManageBrand ? (
                          <BrandProfileDeleteButton
                            profileId={profile.id}
                            name={profile.name}
                            revision={profile.revision}
                            usage={usage[profile.id] ?? { isDefault: false, recipes: [] }}
                            replacements={hasProfiles ? profiles.filter((other) => other.id !== profile.id).map((other) => ({ id: other.id, name: other.name })) : []}
                          />
                        ) : null}
                      </Flex>
                    </Stack>
                  </Flex>
                </Box>
              );
            })}
          </Grid>
        )}
      </Stack>

      <FontManager fonts={fonts} canManage={mayManageBrand} requirement={fontRequirement?.message ?? null} upgrade={fontRequirement?.requiredTier ? { tier: fontRequirement.requiredTier, headline: "Upgrade to use custom fonts", highlight: planUpgradeHighlight(fontRequirement.requiredTier, "brand.customFonts"), canManageBilling } : null} />

      <Box as="section">
        <Flex justify="space-between" align="center" mb="5"><Text fontSize="16px" fontWeight="500">Style library</Text>{newStyleAction}</Flex>
        {mayManageBrand && styleRequirement && !styleRequirement.requiredTier ? <Box mt="-3" mb="5"><PlanLimitNotice message={`${styleRequirement.message} Delete a style to add another.`} upgrade={null} /></Box> : null}
        <TemplateGallery
          builtIns={templates.builtIns}
          mine={templates.mine.filter((template) => !profiles.some((profile) => profile.templates.some((style) => style.id === template.id)))}
          defaultId={templates.defaultId}
          access={{
            canManage: mayManageBrand,
            // Choosing the workspace default is a workspace setting (brand-template.service.ts setDefault).
            canSetDefault: workspaceAllowsCapability({ role: actor.role, status: actor.status }, "workspace.manage"),
            customUpgrade: customStylesUpgrade ? { ...customStylesUpgrade, canManageBilling } : null,
            duplicateBlocked: styleRequirement ? { upgrade: styleUpgrade } : null,
          }}
        />
      </Box>
    </Stack>
  );
}
