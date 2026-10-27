import { Box, Flex, Grid, Image, Stack, Text } from "@chakra-ui/react";
import { ArrowLeft, AudioLines, ImageIcon, LayoutTemplate, MessageSquareText, Shapes, Type } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { brandFontService, brandPlanRequirement, brandProfileService, BrandProfileNotFoundError, brandTemplateService, sceneTemplateService } from "@narriflow/services";
import { planCountRequirement, planFeatureRequirement, planUpgradeHighlight, sceneTemplateDefinitionSchema, workspaceAllowsCapability } from "@narriflow/validators";
import { Button } from "@narriflow/ui/components/button";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { MediaWell } from "@narriflow/ui/components/media-well";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { formatDuration } from "@/lib/format";
import { ProfileFontRoles } from "../_components/profile-font-roles";
import { ProfileAudioPicker } from "../_components/profile-audio-picker";
import { MembershipRemoveButton, StyleAdder } from "../_components/profile-membership";
import type { BrandFontChoice } from "../_components/brand-fonts";
import { SceneTemplateManager, type SceneTemplateCard } from "./scene-template-manager";
import { LockedButton, type UpgradePrompt } from "../../_components/upgrade";
import { AccessNote } from "../../settings/_components/access-note";

const SECTIONS = ["identity", "styles", "assets", "scenes", "audio", "voice"] as const;
type Section = (typeof SECTIONS)[number];

export default async function BrandProfilePage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ section?: string; template?: string }>;
}) {
  const [{ id }, query, actor] = await Promise.all([params, searchParams, admitWorkspacePage("content.view")]);
  const scope = {
    actorUserId: actor.actorUserId,
    workspaceId: actor.workspaceId,
    workspaceOwnerUserId: actor.workspaceOwnerUserId,
    role: actor.role,
    status: actor.status,
    pricingTier: actor.pricingTier,
    isPersonalWorkspace: actor.isPersonalWorkspace,
  };
  let profile;
  try {
    profile = await brandProfileService.get(scope, id);
  } catch (error) {
    if (!(error instanceof BrandProfileNotFoundError)) throw error;
    notFound();
  }
  const section: Section = SECTIONS.includes(query.section as Section) ? query.section as Section : "identity";
  const sceneRows = section === "scenes" ? await sceneTemplateService.list(scope, profile.id) : [];
  const sceneCards: SceneTemplateCard[] = sceneRows.flatMap((scene) => {
    const definition = sceneTemplateDefinitionSchema.safeParse(scene.definition);
    if (!definition.success || (scene.role !== "intro" && scene.role !== "inline" && scene.role !== "outro")) return [];
    return [{ id: scene.id, name: scene.name, role: scene.role, revision: scene.revision, fingerprint: scene.fingerprint, definition: definition.data, isDefault: profile.defaultIntroSceneTemplateId === scene.id || profile.defaultOutroSceneTemplateId === scene.id }];
  });

  const fonts = section === "identity" ? await brandFontService.list(actor) : [];
  const fontRequirement = brandPlanRequirement(actor, "brand.customFonts");
  const canManageFonts = workspaceAllowsCapability({ role: actor.role, status: actor.status }, "brand.manage");

  // Attaching styles and audio is a profile edit (same gate as the services); removing is role-only cleanup.
  const profilesRequirement = brandPlanRequirement(actor, "brand.profiles");
  const canAttach = canManageFonts && profilesRequirement === null;
  const attachUpgrade: UpgradePrompt | null = canManageFonts && profilesRequirement?.requiredTier
    ? { tier: profilesRequirement.requiredTier, headline: "Upgrade to build your brand kit", highlight: planUpgradeHighlight(profilesRequirement.requiredTier, "brandProfiles"), canManageBilling: actor.role === "owner" }
    : null;
  // Styles belong to one profile at a time, so only unassigned ones can be added.
  const styleChoices = section === "styles"
    ? await Promise.all([brandTemplateService.list(actor), brandProfileService.list(scope)]).then(([templates, profiles]) => ({
        available: templates.mine.filter((template) => !profiles.some((other) => other.templates.some((style) => style.id === template.id))).map((template) => ({ id: template.id, name: template.name })),
        // Same gate as the Brand kit page's "New style".
        createRequirement: planCountRequirement(actor.pricingTier, "brandTemplates", templates.mine.length) ?? planFeatureRequirement(actor.pricingTier, "brand.customTemplates"),
      }))
    : { available: [], createRequirement: null };
  const createStyleUpgrade: UpgradePrompt | null = styleChoices.createRequirement?.requiredTier
    ? { tier: styleChoices.createRequirement.requiredTier, headline: "Upgrade to save your own caption styles", highlight: planUpgradeHighlight(styleChoices.createRequirement.requiredTier, "brandTemplates"), canManageBilling: actor.role === "owner" }
    : null;

  const scenesRequirement = brandPlanRequirement(actor, "brand.scenes");
  const defaultsRequirement = brandPlanRequirement(actor, "brand.defaultScenes");
  const createUpgrade: UpgradePrompt | null = scenesRequirement?.requiredTier
    ? { tier: scenesRequirement.requiredTier, headline: "Upgrade to save reusable scenes", highlight: planUpgradeHighlight(scenesRequirement.requiredTier, "brand.scenes") }
    : null;
  const defaultsUpgrade: UpgradePrompt | null = defaultsRequirement?.requiredTier
    ? { tier: defaultsRequirement.requiredTier, headline: "Upgrade to set default intros and outros", highlight: planUpgradeHighlight(defaultsRequirement.requiredTier, "brand.defaultScenes") }
    : null;

  return (
    <Stack gap="8">
      <Box animation="fade-up" animationFillMode="backwards">
        <PageHeader
          title={profile.name}
          description={`${profile.templates.length} styles · ${profile.assets.length} assets · ${profile.fonts.length} fonts · ${profile.approvalRule === "approval_required" ? "approval required" : "direct publish"}`}
          actions={<Button size="sm" variant="subtle" asChild><Link href="/brand-kit"><ArrowLeft size={13} /> Profiles</Link></Button>}
        />
        <AccessNote access={actor} capability="brand.manage" action="change this profile" mt="-4" />
      </Box>

      <Flex gap="0" borderBottomWidth="1px" borderColor="border.subtle" overflowX="auto" animation="rule-in">
        {SECTIONS.map((item) => (
          <Link key={item} href={`/brand-kit/${profile.id}?section=${item}`}>
            <Text px="4" py="3" fontSize="14px" fontWeight="500" whiteSpace="nowrap" color={section === item ? "fg" : "fg.muted"} borderBottomWidth="2px" borderColor={section === item ? "accent.solid" : "transparent"}>
              {item.charAt(0).toUpperCase() + item.slice(1)}
            </Text>
          </Link>
        ))}
      </Flex>

      <Box animation="fade-up" animationFillMode="backwards" style={{ animationDelay: "55ms" }}>
        {section === "identity" && <IdentitySection profile={profile} fonts={fonts} canManage={canManageFonts} requirement={fontRequirement?.message ?? null} upgrade={fontRequirement?.requiredTier ? { tier: fontRequirement.requiredTier, headline: "Upgrade to use custom fonts", canManageBilling: actor.role === "owner" } : null} />}
        {section === "styles" && <StylesSection profile={profile} selectedTemplateId={query.template} available={styleChoices.available} canRemove={canManageFonts} canAttach={canAttach} attachUpgrade={attachUpgrade} createStyle={canManageFonts ? { allowed: styleChoices.createRequirement === null, upgrade: createStyleUpgrade, limit: styleChoices.createRequirement?.message ?? null } : null} />}
        {section === "assets" && <AssetsSection profile={profile} />}
        {section === "scenes" && <ScenesSection profileId={profile.id} scenes={sceneCards} fonts={profile.fonts} canManage={canManageFonts} canManageDefaults={defaultsRequirement === null} createRequirement={scenesRequirement?.message ?? null} createUpgrade={createUpgrade} defaultsUpgrade={defaultsUpgrade} />}
        {section === "audio" && <AudioSection profile={profile} canRemove={canManageFonts} canAttach={canAttach} attachUpgrade={attachUpgrade} />}
        {section === "voice" && <VoiceSection profile={profile} />}
      </Box>
    </Stack>
  );
}

type Profile = Awaited<ReturnType<typeof brandProfileService.get>>;

function SectionHeader({ icon, title, action }: { icon: React.ReactNode; title: string; action?: React.ReactNode }) {
  return (
    <Flex align="center" justify="space-between" gap="3" minH="8">
      <Flex align="center" gap="3">
        <Box color="fg.muted">{icon}</Box>
        <Text fontSize="16px" fontWeight="500">{title}</Text>
      </Flex>
      {action}
    </Flex>
  );
}

function IdentitySection({ profile, fonts, canManage, requirement, upgrade }: { profile: Profile; fonts: BrandFontChoice[]; canManage: boolean; requirement: string | null; upgrade: UpgradePrompt | null }) {
  return (
    <Stack gap="7">
      <SectionHeader icon={<Shapes size={18} />} title="Colors and fonts" />
      <Grid templateColumns={{ base: "1fr", md: "1.1fr .9fr" }} gap="8">
        <Stack gap="0">
          {[
            ["Primary", profile.identity.primaryColor],
            ["Secondary", profile.identity.secondaryColor],
            ["Signal", profile.identity.accentColor],
          ].map(([label, color]) => (
            <Flex key={label} align="center" gap="4" py="4" borderBottomWidth="1px" borderColor="border.subtle">
              <Box w="42px" h="42px" borderRadius="l1" borderWidth="1px" borderColor="border.card" style={{ background: color ?? "transparent" }} />
              <Stack gap="0.5" flex="1"><Text fontSize="13px" color="fg.muted">{label}</Text><Text textStyle="data">{color ?? "Not set"}</Text></Stack>
            </Flex>
          ))}
        </Stack>
        <ProfileFontRoles profileId={profile.id} memberships={profile.fonts} fonts={fonts} canManage={canManage} requirement={requirement} upgrade={upgrade} />
      </Grid>
    </Stack>
  );
}

function StylesSection({ profile, selectedTemplateId, available, canRemove, canAttach, attachUpgrade, createStyle }: {
  profile: Profile;
  selectedTemplateId?: string;
  available: { id: string; name: string }[];
  canRemove: boolean;
  canAttach: boolean;
  attachUpgrade: UpgradePrompt | null;
  /** Where a new style comes from; null when the viewer can't manage the brand. */
  createStyle: { allowed: boolean; upgrade: UpgradePrompt | null; limit: string | null } | null;
}) {
  const nextPosition = profile.templates.reduce((max, template) => Math.max(max, template.position + 1), 0);
  const adder = canAttach && available.length > 0
    ? <StyleAdder profileId={profile.id} styles={available} nextPosition={nextPosition} />
    : attachUpgrade
      ? <LockedButton size="sm" variant="subtle" prompt={attachUpgrade}>Add style</LockedButton>
      : null;
  // With nothing to add, the next step is making a style.
  const createAction = !createStyle ? null : createStyle.allowed
    ? <Button size="sm" variant="subtle" asChild><Link href="/brand-kit/styles/new">Create a style</Link></Button>
    : createStyle.upgrade
      ? <LockedButton size="sm" variant="subtle" prompt={createStyle.upgrade}>Create a style</LockedButton>
      : null;
  const emptyAction = adder ?? (canAttach ? createAction : null);
  return (
    <Stack gap="7">
      <SectionHeader icon={<LayoutTemplate size={18} />} title="Style presets" action={profile.templates.length > 0 ? adder : undefined} />
      {profile.templates.length === 0 ? (
        <EmptyState
          icon={<LayoutTemplate size={18} />}
          title="No style presets"
          description={available.length === 0 && createStyle?.limit && !createAction ? createStyle.limit : "Add a caption style to this profile."}
          action={emptyAction ?? undefined}
        />
      ) : (
        <>
          <Grid templateColumns={{ base: "1fr", md: "repeat(2, 1fr)", xl: "repeat(3, 1fr)" }} gap="4">
            {profile.templates.map((template) => {
              const selected = selectedTemplateId === template.id || (!selectedTemplateId && profile.defaultTemplateId === template.id);
              return (
                <Stack key={template.id} gap="4" borderRadius="l3" bg="bg.panel" p="4" borderWidth="2px" borderColor={selected ? "accent.solid" : "transparent"}>
                  <Flex align="center" justify="space-between" gap="2">
                    <Text fontFamily="display" fontWeight="500" fontSize="md">{template.name}</Text>
                    {canRemove ? <MembershipRemoveButton profileId={profile.id} kind="template" resourceId={template.id} label={template.name} /> : null}
                  </Flex>
                  <Flex gap="2"><Box h="7px" flex="1" borderRadius="l1" style={{ background: template.primaryColor }} /><Box h="7px" flex="1" borderRadius="l1" style={{ background: template.secondaryColor }} /></Flex>
                  <Button size="sm" variant="subtle" asChild><Link href={`/brand-kit/styles/${template.id}`}>Edit style</Link></Button>
                </Stack>
              );
            })}
          </Grid>
          {available.length === 0 && canAttach ? <Flex align="center" gap="3"><Text fontSize="13px" color="fg.muted">Every style is already in a profile.</Text>{createAction}</Flex> : null}
        </>
      )}
    </Stack>
  );
}

function AssetsSection({ profile }: { profile: Profile }) {
  return (
    <Stack gap="7">
      <SectionHeader icon={<ImageIcon size={18} />} title="Visual assets" />
      {profile.assets.length === 0 ? <EmptyState icon={<ImageIcon size={18} />} title="No visual assets" description="Save a generated image to this profile from the Studio." /> : (
        <Grid templateColumns={{ base: "repeat(2, 1fr)", md: "repeat(3, 1fr)", xl: "repeat(4, 1fr)" }} gap="4">
          {profile.assets.map((asset) => (
            <Stack key={asset.id} gap="2">
              <MediaWell ratio={1}>{asset.accessUrl && asset.kind === "image" ? <Image src={asset.accessUrl} alt={asset.title} w="full" h="full" objectFit="cover" /> : <Flex w="full" h="full" align="center" justify="center" color="studio.fgMuted"><ImageIcon size={20} /></Flex>}</MediaWell>
              <Text fontSize="13px" fontWeight="500" lineClamp={1}>{asset.title}</Text>
              <Text fontSize="12px" color="fg.subtle" fontVariantNumeric="tabular-nums">{asset.role} · {asset.width}×{asset.height}</Text>
            </Stack>
          ))}
        </Grid>
      )}
    </Stack>
  );
}

function ScenesSection({ profileId, scenes, fonts, canManage, canManageDefaults, createRequirement, createUpgrade, defaultsUpgrade }: { profileId: string; scenes: SceneTemplateCard[]; fonts: Profile["fonts"]; canManage: boolean; canManageDefaults: boolean; createRequirement: string | null; createUpgrade: UpgradePrompt | null; defaultsUpgrade: UpgradePrompt | null }) {
  return (
    <Stack gap="7">
      <SectionHeader icon={<Type size={18} />} title="Scene templates" />
      <SceneTemplateManager profileId={profileId} scenes={scenes} fonts={fonts.map((font) => ({ id: font.id, family: font.family, fingerprint: font.fingerprint, missing: font.missing }))} canManage={canManage} canManageDefaults={canManageDefaults} createRequirement={createRequirement} createUpgrade={createUpgrade} defaultsUpgrade={defaultsUpgrade} />
    </Stack>
  );
}

function AudioSection({ profile, canRemove, canAttach, attachUpgrade }: { profile: Profile; canRemove: boolean; canAttach: boolean; attachUpgrade: UpgradePrompt | null }) {
  const picker = canAttach
    ? <ProfileAudioPicker profileId={profile.id} attachedIds={profile.audio.map((audio) => audio.id)} nextPosition={profile.audio.reduce((max, audio) => Math.max(max, audio.position + 1), 0)} />
    : attachUpgrade
      ? <LockedButton size="sm" variant="subtle" prompt={attachUpgrade}>Add audio</LockedButton>
      : null;
  return (
    <Stack gap="7">
      <SectionHeader icon={<AudioLines size={18} />} title="Audio references" />
      {profile.audio.length > 0 && picker ? <Box>{picker}</Box> : null}
      {profile.audio.length === 0 ? (
        <EmptyState icon={<AudioLines size={18} />} title="No referenced audio" description="Add music or sound effects from your audio library." action={picker ?? undefined} />
      ) : (
        <Stack gap="0">
          {profile.audio.map((audio, index) => (
            <Flex key={audio.id} align="center" gap="4" py="4" borderBottomWidth="1px" borderColor="border.subtle">
              <Text fontSize="12px" color="fg.subtle" fontVariantNumeric="tabular-nums">{String(index + 1).padStart(2, "0")}</Text>
              <Text fontSize="13px" fontWeight="500" flex="1">{audio.title}</Text>
              <Text fontSize="12px" color="fg.subtle">{audio.kind === "sfx" ? "Sound effect" : "Music"}</Text>
              <Text textStyle="data" color="fg.timecode">{formatDuration(audio.durationSec)}</Text>
              {canRemove ? <MembershipRemoveButton profileId={profile.id} kind="audio" resourceId={audio.id} label={audio.title} /> : null}
            </Flex>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function VoiceSection({ profile }: { profile: Profile }) {
  const rows = [
    ["Audience", profile.voice.audience || "Not specified"],
    ["Tone", profile.voice.tone.join(" · ") || "Not specified"],
    ["Preferred terms", profile.voice.preferredTerms.join(" · ") || "None"],
    ["Blocked terms", profile.voice.blockedTerms.join(" · ") || "None"],
    ["Hashtag guidance", profile.voice.hashtagGuidance || "Not specified"],
  ];
  return (
    <Stack gap="7">
      <SectionHeader icon={<MessageSquareText size={18} />} title="Voice guidance" />
      <Stack gap="0">{rows.map(([label, value]) => <Grid key={label} templateColumns={{ base: "1fr", md: "180px 1fr" }} gap="3" py="4" borderBottomWidth="1px" borderColor="border.subtle"><Text fontSize="13px" color="fg.muted">{label}</Text><Text fontSize="13px" lineHeight="1.6">{value}</Text></Grid>)}</Stack>
    </Stack>
  );
}
