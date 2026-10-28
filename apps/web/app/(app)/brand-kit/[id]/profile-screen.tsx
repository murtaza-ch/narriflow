"use client";

import { Box, Flex, Grid, Heading, Image, Stack, Text } from "@chakra-ui/react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, AudioLines, Check, ImageIcon, LayoutTemplate, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { planUpgradeHighlight, sceneTemplateDefinitionSchema, type CaptionPreset } from "@narriflow/validators";
import { IconButton } from "@narriflow/ui/components/button";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { MediaWell } from "@narriflow/ui/components/media-well";
import { LockedButton, type UpgradePrompt } from "../../_components/upgrade";
import { useWorkspaceBootstrap } from "../../_components/usage";
import { AccessNote } from "../../settings/_components/access-note";
import { type BrandData, BrandLoadFailure, useBrandApi } from "../_components/brand-api";
import { BrandApiProvider, useBrandScope } from "../_components/brand-api-provider";
import { BrandProfileDefaultButton } from "../_components/brand-profile-default-button";
import { BrandProfileDeleteButton } from "../_components/brand-profile-delete-button";
import { BrandMark, BrandTabs, CoverChip, PaletteDots, TabToolbar, plural } from "../_components/brand-kit-ui";
import { ProfileAudioList } from "../_components/profile-audio-list";
import { ProfileAudioPicker } from "../_components/profile-audio-picker";
import { ProfileColorsPanel, ProfileEditorProvider, ProfilePublishingPanel, ProfileVoicePanel, type ProfileEditAccess } from "../_components/profile-editor";
import { ProfileFontRoles } from "../_components/profile-font-roles";
import { StyleAdder } from "../_components/profile-membership";
import { ProfileStyleGrid } from "../_components/profile-styles";
import BrandProfileLoading from "./loading";
import { SceneTemplateManager, type SceneTemplateCard } from "./scene-template-manager";

const SECTIONS = ["identity", "styles", "assets", "scenes", "audio", "voice"] as const;
type Section = (typeof SECTIONS)[number];
const SECTION_LABEL: Record<Section, string> = { identity: "Identity", styles: "Styles", assets: "Assets", scenes: "Scenes", audio: "Audio", voice: "Voice" };

/** One Brand Profile: its header and the active section, read as one aggregate for that section. */
export function BrandProfileScreen({ profileId }: { profileId: string }) {
  const scope = useBrandScope();
  if (!scope) return <BrandProfileLoading />;
  return (
    <BrandApiProvider key={scope.workspaceId} scope={scope}>
      <BrandProfileContent profileId={profileId} />
    </BrandApiProvider>
  );
}

function BrandProfileContent({ profileId }: { profileId: string }) {
  const { queries, scope } = useBrandApi();
  const params = useSearchParams();
  const requested = params.get("section");
  const section: Section = SECTIONS.includes(requested as Section) ? (requested as Section) : "identity";
  const detailQuery = useQuery(queries.profileDetail(profileId, section));
  const bootstrap = useWorkspaceBootstrap(scope);

  // A failed refetch keeps the last profile on screen; only a first load can fail the page.
  if (!detailQuery.data && detailQuery.isError) {
    return <BrandLoadFailure what="This Brand Profile" error={detailQuery.error} onRetry={() => void detailQuery.refetch()} />;
  }
  if (bootstrap.isError && !bootstrap.data) {
    return <BrandLoadFailure what="This Brand Profile" error={bootstrap.error} onRetry={() => void bootstrap.refetch()} />;
  }
  if (!detailQuery.data || !bootstrap.data) return <BrandProfileLoading />;
  const detail = detailQuery.data;
  const { workspace } = bootstrap.data;
  const { profile, isDefault, access, plan, usage, replacements } = detail;
  const { canManageBrand, canManageBilling, canAttach } = access;
  const highlightId = params.get("template") ?? undefined;

  const attachUpgrade: UpgradePrompt | null = canManageBrand && plan.profiles?.requiredTier
    ? { tier: plan.profiles.requiredTier, headline: "Upgrade to build your brand kit", highlight: planUpgradeHighlight(plan.profiles.requiredTier, "brandProfiles"), canManageBilling }
    : null;
  const editAccess: ProfileEditAccess = canAttach ? { mode: "edit" } : attachUpgrade ? { mode: "locked", upgrade: attachUpgrade } : { mode: "read" };
  const logo = profile.assets.find((asset) => asset.id === profile.identity.primaryLogoAssetId || asset.role === "logo");

  return (
    <ProfileEditorProvider profileId={profile.id} revision={profile.revision}>
      <Stack gap="8">
        <Box animation="fade-up" animationFillMode="backwards">
          <Flex align="center" justify="space-between" gap="4" wrap="wrap">
            <Flex align="center" gap={{ base: "3", md: "4" }} minW="0">
              <IconButton asChild size="sm" variant="ghost" aria-label="Back to Brand kit" ms="-2">
                <Link href="/brand-kit"><ArrowLeft size={16} /></Link>
              </IconButton>
              <BrandMark colors={profile.identity} logoUrl={logo?.accessUrl ?? null} name={profile.name} size={56} />
              <Stack gap="1.5" minW="0">
                <Heading as="h1" textStyle="title" fontSize={{ base: "22px", md: "28px" }} truncate>
                  {profile.name}
                </Heading>
                <Flex align="center" gap="3" fontSize="13px" color="fg.muted" wrap="wrap">
                  {isDefault ? (
                    <Flex align="center" gap="1" color="accent.fg" fontWeight="500"><Check size={13} /> Default profile</Flex>
                  ) : null}
                  <Flex align="center" gap="1"><ShieldCheck size={13} /> {profile.approvalRule === "approval_required" ? "Approval required" : "Direct publish"}</Flex>
                  <PaletteDots colors={profile.identity} size={12} />
                </Flex>
              </Stack>
            </Flex>
            {canManageBrand ? (
              <Flex gap="2" align="center">
                {canAttach && !isDefault ? <BrandProfileDefaultButton profileId={profile.id} /> : null}
                {/* Deleting is role-only on every plan; the dialog moves the default and Recipes to a replacement. */}
                <BrandProfileDeleteButton
                  profileId={profile.id}
                  name={profile.name}
                  revision={profile.revision}
                  usage={usage ?? { isDefault, recipes: [] }}
                  replacements={replacements}
                />
              </Flex>
            ) : null}
          </Flex>
          <AccessNote access={workspace} capability="brand.manage" action="change this profile" mt="4" />
        </Box>

        <Stack gap="6" animation="fade-up" animationFillMode="backwards" style={{ animationDelay: "60ms" }}>
          <BrandTabs
            label="Brand Profile"
            tabs={SECTIONS.map((item) => ({
              label: SECTION_LABEL[item],
              href: item === "identity" ? `/brand-kit/${profile.id}` : `/brand-kit/${profile.id}?section=${item}`,
              active: section === item,
              count: item === "styles" ? profile.templates.length : item === "assets" ? profile.assets.length : item === "audio" ? profile.audio.length : undefined,
            }))}
          />

          <Box key={section} animation="fade-up" animationFillMode="backwards" style={{ animationDuration: "0.3s" }}>
            {section === "identity" && <IdentitySection detail={detail} access={editAccess} />}
            {section === "styles" && <StylesSection detail={detail} highlightId={highlightId} attachUpgrade={attachUpgrade} />}
            {section === "assets" && <AssetsSection profile={profile} />}
            {section === "scenes" && <ScenesSection detail={detail} />}
            {section === "audio" && <AudioSection profile={profile} canRemove={canManageBrand} canAttach={canAttach} attachUpgrade={attachUpgrade} />}
            {section === "voice" && <ProfileVoicePanel voice={profile.voice} access={editAccess} />}
          </Box>
        </Stack>
      </Stack>
    </ProfileEditorProvider>
  );
}

type Detail = BrandData<"profileDetail">;
type Profile = Detail["profile"];

function IdentitySection({ detail, access }: { detail: Detail; access: ProfileEditAccess }) {
  const { profile, plan } = detail;
  const fonts = "fonts" in detail ? detail.fonts : [];
  const { canManageBrand: canManageFonts, canManageBilling } = detail.access;
  const fontRequirement = plan.customFonts;
  // Approval rules are a plan feature (brand-profile.service.ts); below it the panel explains the upgrade.
  const governanceRequirement = plan.governance;
  const governance = governanceRequirement
    ? {
        message: governanceRequirement.message,
        upgrade: governanceRequirement.requiredTier
          ? { tier: governanceRequirement.requiredTier, headline: "Upgrade to require approval before publishing", highlight: planUpgradeHighlight(governanceRequirement.requiredTier, "brand.governance"), canManageBilling }
          : null,
      }
    : null;
  return (
    <Grid templateColumns={{ base: "1fr", lg: "minmax(0, 1.3fr) minmax(0, 1fr)" }} gap="5" alignItems="start">
      <Stack gap="5">
        <ProfileColorsPanel name={profile.name} identity={profile.identity} access={access} />
        <ProfilePublishingPanel approvalRule={profile.approvalRule} access={access} governance={governance} />
      </Stack>
      <ProfileFontRoles
        profileId={profile.id}
        memberships={profile.fonts}
        fonts={fonts}
        canManage={canManageFonts}
        requirement={fontRequirement?.message ?? null}
        upgrade={fontRequirement?.requiredTier ? { tier: fontRequirement.requiredTier, headline: "Upgrade to use custom fonts", canManageBilling } : null}
      />
    </Grid>
  );
}

function StylesSection({ detail, highlightId, attachUpgrade }: { detail: Detail; highlightId?: string; attachUpgrade: UpgradePrompt | null }) {
  const { profile, access } = detail;
  const { canManageBrand: canManage, canAttach, canManageBilling } = access;
  if (!("styles" in detail)) return null;
  const { templates, available, createRequirement } = detail.styles;
  // Same gate as the Brand kit page's "New style".
  const createUpgrade: UpgradePrompt | null = createRequirement?.requiredTier
    ? { tier: createRequirement.requiredTier, headline: "Upgrade to save your own caption styles", highlight: planUpgradeHighlight(createRequirement.requiredTier, "brandTemplates"), canManageBilling }
    : null;
  const presets = new Map<string, CaptionPreset>([...templates.builtIns, ...templates.mine].map((template) => [template.id, template.captionPreset]));
  const nextPosition = profile.templates.reduce((max, template) => Math.max(max, template.position + 1), 0);
  const createHref = canManage && createRequirement === null ? "/brand-kit/styles/new" : undefined;
  const canAdd = canAttach && (available.length > 0 || createHref);
  const lockedCreate = canAttach && available.length === 0 && !createHref && createUpgrade
    ? <LockedButton prompt={createUpgrade}>Create a style</LockedButton>
    : null;
  const lockedAttach = attachUpgrade ? <LockedButton prompt={attachUpgrade}>Add style</LockedButton> : null;
  const defaultStyle = profile.templates.find((template) => template.id === profile.defaultTemplateId);

  if (profile.templates.length === 0) {
    return (
      <EmptyState
        icon={<LayoutTemplate size={18} />}
        title="No caption styles yet"
        description={canAttach && available.length === 0 && !createHref && createRequirement ? createRequirement.message : "Add a caption style to this profile. New projects with this profile use its default style."}
        action={canAdd ? <StyleAdder variant="button" profileId={profile.id} styles={available} nextPosition={nextPosition} createHref={createHref} /> : lockedCreate ?? lockedAttach ?? undefined}
      />
    );
  }
  return (
    <Stack gap="5">
      <TabToolbar
        summary={defaultStyle ? `${plural(profile.templates.length, "style")} · new projects use ${defaultStyle.name}` : `${plural(profile.templates.length, "style")} · no default yet${canAttach ? ". Make one the default from its menu so new projects start with it." : ""}`}
        action={canAdd ? null : lockedCreate ?? lockedAttach}
      />
      <ProfileStyleGrid
        profileId={profile.id}
        styles={profile.templates.map((template) => ({ id: template.id, name: template.name, preset: presets.get(template.id) ?? null }))}
        defaultId={profile.defaultTemplateId}
        highlightId={highlightId}
        canSetDefault={canAttach}
        canRemove={canManage}
        adder={canAdd ? <StyleAdder profileId={profile.id} styles={available} nextPosition={nextPosition} createHref={createHref} /> : null}
      />
    </Stack>
  );
}

function AssetsSection({ profile }: { profile: Profile }) {
  if (profile.assets.length === 0) {
    return <EmptyState icon={<ImageIcon size={18} />} title="No visual assets" description="Save a generated image to this profile from the Studio." />;
  }
  return (
    <Grid templateColumns={{ base: "repeat(2, minmax(0, 1fr))", md: "repeat(3, minmax(0, 1fr))", xl: "repeat(5, minmax(0, 1fr))" }} gap="4" rowGap="5">
      {profile.assets.map((asset) => (
        <Stack key={asset.id} gap="2.5" minW="0">
          <MediaWell ratio={1} position="relative">
            {asset.accessUrl && asset.kind === "image" ? <Image src={asset.accessUrl} alt={asset.title} w="full" h="full" objectFit="cover" /> : <Flex w="full" h="full" align="center" justify="center" color="studio.fgMuted"><ImageIcon size={20} /></Flex>}
            {asset.role === "logo" ? <Box position="absolute" top="2" left="2"><CoverChip>Logo</CoverChip></Box> : null}
          </MediaWell>
          <Stack gap="0.5" minW="0">
            <Text fontSize="13px" fontWeight="500" truncate>{asset.title}</Text>
            <Text fontSize="12px" color="fg.subtle" fontVariantNumeric="tabular-nums">{asset.width}×{asset.height}</Text>
          </Stack>
        </Stack>
      ))}
    </Grid>
  );
}

function ScenesSection({ detail }: { detail: Detail }) {
  const { profile, plan } = detail;
  const sceneRows = "scenes" in detail ? detail.scenes : [];
  const sceneCards: SceneTemplateCard[] = sceneRows.flatMap((scene) => {
    const definition = sceneTemplateDefinitionSchema.safeParse(scene.definition);
    if (!definition.success || (scene.role !== "intro" && scene.role !== "inline" && scene.role !== "outro")) return [];
    return [{ id: scene.id, name: scene.name, role: scene.role, revision: scene.revision, fingerprint: scene.fingerprint, definition: definition.data, isDefault: profile.defaultIntroSceneTemplateId === scene.id || profile.defaultOutroSceneTemplateId === scene.id }];
  });
  const scenesRequirement = plan.scenes;
  const defaultsRequirement = plan.defaultScenes;
  const createUpgrade: UpgradePrompt | null = scenesRequirement?.requiredTier
    ? { tier: scenesRequirement.requiredTier, headline: "Upgrade to save reusable scenes", highlight: planUpgradeHighlight(scenesRequirement.requiredTier, "brand.scenes") }
    : null;
  const defaultsUpgrade: UpgradePrompt | null = defaultsRequirement?.requiredTier
    ? { tier: defaultsRequirement.requiredTier, headline: "Upgrade to set default intros and outros", highlight: planUpgradeHighlight(defaultsRequirement.requiredTier, "brand.defaultScenes") }
    : null;
  return (
    <SceneTemplateManager
      profileId={profile.id}
      scenes={sceneCards}
      fonts={profile.fonts.map((font) => ({ id: font.id, family: font.family, fingerprint: font.fingerprint, missing: font.missing }))}
      colors={profile.identity}
      canManage={detail.access.canManageBrand}
      canManageDefaults={defaultsRequirement === null}
      createRequirement={scenesRequirement?.message ?? null}
      createUpgrade={createUpgrade}
      defaultsRequirement={defaultsRequirement?.message ?? null}
      defaultsUpgrade={defaultsUpgrade}
    />
  );
}

function AudioSection({ profile, canRemove, canAttach, attachUpgrade }: { profile: Profile; canRemove: boolean; canAttach: boolean; attachUpgrade: UpgradePrompt | null }) {
  const picker = canAttach
    ? <ProfileAudioPicker profileId={profile.id} attachedIds={profile.audio.map((audio) => audio.id)} nextPosition={profile.audio.reduce((max, audio) => Math.max(max, audio.position + 1), 0)} />
    : attachUpgrade
      ? <LockedButton prompt={attachUpgrade}>Add audio</LockedButton>
      : null;
  // The picker keeps one place in the tree, so its dialog stays open while the first tracks arrive.
  return (
    <Stack gap="5">
      <TabToolbar summary={profile.audio.length ? `${plural(profile.audio.length, "track")} · new clips start with the first music track` : "Music and sound effects for this brand"} action={picker} />
      {profile.audio.length === 0 ? (
        <EmptyState icon={<AudioLines size={18} />} title="No brand audio yet" description="Add music or sound effects. New clips with this profile start with its first music track." />
      ) : (
        <ProfileAudioList profileId={profile.id} audio={profile.audio} canRemove={canRemove} />
      )}
    </Stack>
  );
}
