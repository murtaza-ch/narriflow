import { Box, Flex, Grid, Image, Stack, Text } from "@chakra-ui/react";
import { ArrowLeft, AudioLines, ImageIcon, LayoutTemplate, MessageSquareText, Shapes, Type } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { brandProfileService, BrandProfileNotFoundError, sceneTemplateService } from "@narriflow/services";
import { sceneTemplateDefinitionSchema } from "@narriflow/validators";
import { Button } from "@narriflow/ui/components/button";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { MediaWell } from "@narriflow/ui/components/media-well";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { formatDuration } from "@/lib/format";
import { SceneTemplateManager, type SceneTemplateCard } from "./scene-template-manager";

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

  return (
    <Stack gap="8">
      <Box animation="fade-up" animationFillMode="backwards">
        <PageHeader
          eyebrow="Brand profile"
          title={profile.name}
          description={`${profile.templates.length} styles · ${profile.assets.length} assets · ${profile.fonts.length} fonts · ${profile.approvalRule === "approval_required" ? "approval required" : "direct publish"}`}
          actions={<Button size="sm" variant="outline" asChild><Link href="/brand-kit"><ArrowLeft size={13} /> Profiles</Link></Button>}
        />
      </Box>

      <Flex gap="0" borderTopWidth="1px" borderBottomWidth="1px" borderColor="border" overflowX="auto" animation="rule-in">
        {SECTIONS.map((item) => (
          <Link key={item} href={`/brand-kit/${profile.id}?section=${item}`}>
            <Text px="4" py="3" textStyle="eyebrow" whiteSpace="nowrap" color={section === item ? "accent.fg" : "fg.muted"} borderBottomWidth="2px" borderColor={section === item ? "accent.solid" : "transparent"}>
              {item.charAt(0).toUpperCase() + item.slice(1)}
            </Text>
          </Link>
        ))}
      </Flex>

      <Box animation="fade-up" animationFillMode="backwards" style={{ animationDelay: "55ms" }}>
        {section === "identity" && <IdentitySection profile={profile} />}
        {section === "styles" && <StylesSection profile={profile} selectedTemplateId={query.template} />}
        {section === "assets" && <AssetsSection profile={profile} />}
        {section === "scenes" && <ScenesSection profileId={profile.id} scenes={sceneCards} fonts={profile.fonts} canManageDefaults={actor.pricingTier === "business"} />}
        {section === "audio" && <AudioSection profile={profile} />}
        {section === "voice" && <VoiceSection profile={profile} />}
      </Box>
    </Stack>
  );
}

type Profile = Awaited<ReturnType<typeof brandProfileService.get>>;

function SectionHeader({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <Flex align="flex-start" gap="4" pb="5" borderBottomWidth="1px" borderColor="border">
      <Box color="fg.muted" pt="0.5">{icon}</Box>
      <Text textStyle="title" fontSize="lg">{title}</Text>
    </Flex>
  );
}

function IdentitySection({ profile }: { profile: Profile }) {
  return (
    <Stack gap="7">
      <SectionHeader icon={<Shapes size={18} />} title="Colors and fonts" />
      <Grid templateColumns={{ base: "1fr", md: "1.1fr .9fr" }} gap="8">
        <Stack gap="0" borderTopWidth="1px" borderColor="border">
          {[
            ["Primary", profile.identity.primaryColor],
            ["Secondary", profile.identity.secondaryColor],
            ["Signal", profile.identity.accentColor],
          ].map(([label, color]) => (
            <Flex key={label} align="center" gap="4" py="4" borderBottomWidth="1px" borderColor="border.subtle">
              <Box w="42px" h="42px" borderRadius="l1" borderWidth="1px" borderColor="border" style={{ background: color ?? "transparent" }} />
              <Stack gap="0.5" flex="1"><Text textStyle="eyebrow" color="fg.subtle">{label}</Text><Text textStyle="data">{color ?? "Not set"}</Text></Stack>
            </Flex>
          ))}
        </Stack>
        <Box bg="bg.panel" borderRadius="l2" p="6">
          <Stack gap="5">
            <Text textStyle="eyebrow" color="fg.subtle">Type roles</Text>
            {profile.fonts.length ? profile.fonts.map((font) => (
              <Flex key={`${font.id}-${font.role}`} align="baseline" justify="space-between" gap="4">
                <Text fontFamily="display" fontSize="20px" fontWeight={font.weight}>{font.family}</Text>
                <Text textStyle="eyebrow" color="fg.subtle">{font.role}</Text>
              </Flex>
            )) : <Text fontSize="13px" color="fg.muted">System typography is used until font roles are attached.</Text>}
          </Stack>
        </Box>
      </Grid>
    </Stack>
  );
}

function StylesSection({ profile, selectedTemplateId }: { profile: Profile; selectedTemplateId?: string }) {
  return (
    <Stack gap="7">
      <SectionHeader icon={<LayoutTemplate size={18} />} title="Style presets" />
      {profile.templates.length === 0 ? <EmptyState icon={<LayoutTemplate size={18} />} title="No style presets" /> : (
        <Grid templateColumns={{ base: "1fr", md: "repeat(2, 1fr)", xl: "repeat(3, 1fr)" }} gap="4">
          {profile.templates.map((template) => {
            const selected = selectedTemplateId === template.id || (!selectedTemplateId && profile.defaultTemplateId === template.id);
            return (
              <Stack key={template.id} gap="4" borderRadius="l2" bg="bg.panel" p="4" position="relative" _before={{ content: '""', position: "absolute", insetInlineStart: "0", top: "0", bottom: "0", w: "3px", bg: selected ? "accent.solid" : "transparent" }}>
                <Flex align="center" gap="2"><Text textStyle="eyebrow" color={selected ? "accent.fg" : "fg.subtle"}>{selected ? "Selected" : "Preset"}</Text></Flex>
                <Text fontFamily="display" fontWeight="500" fontSize="md">{template.name}</Text>
                <Flex gap="2"><Box h="7px" flex="1" borderRadius="l1" style={{ background: template.primaryColor }} /><Box h="7px" flex="1" borderRadius="l1" style={{ background: template.secondaryColor }} /></Flex>
                <Button size="sm" variant="outline" asChild><Link href={`/brand-kit/styles/${template.id}`}>Edit style</Link></Button>
              </Stack>
            );
          })}
        </Grid>
      )}
    </Stack>
  );
}

function AssetsSection({ profile }: { profile: Profile }) {
  return (
    <Stack gap="7">
      <SectionHeader icon={<ImageIcon size={18} />} title="Visual assets" />
      {profile.assets.length === 0 ? <EmptyState icon={<ImageIcon size={18} />} title="No visual assets" /> : (
        <Grid templateColumns={{ base: "repeat(2, 1fr)", md: "repeat(3, 1fr)", xl: "repeat(4, 1fr)" }} gap="4">
          {profile.assets.map((asset) => (
            <Stack key={asset.id} gap="2">
              <MediaWell ratio={1}>{asset.accessUrl && asset.kind === "image" ? <Image src={asset.accessUrl} alt={asset.title} w="full" h="full" objectFit="cover" /> : <Flex w="full" h="full" align="center" justify="center"><ImageIcon size={20} /></Flex>}</MediaWell>
              <Text fontSize="12.5px" fontWeight="600" lineClamp={1}>{asset.title}</Text>
              <Text textStyle="eyebrow" color="fg.subtle">{asset.role} · {asset.width}×{asset.height}</Text>
            </Stack>
          ))}
        </Grid>
      )}
    </Stack>
  );
}

function ScenesSection({ profileId, scenes, fonts, canManageDefaults }: { profileId: string; scenes: SceneTemplateCard[]; fonts: Profile["fonts"]; canManageDefaults: boolean }) {
  return (
    <Stack gap="7">
      <SectionHeader icon={<Type size={18} />} title="Scene templates" />
      <SceneTemplateManager profileId={profileId} scenes={scenes} fonts={fonts.map((font) => ({ id: font.id, family: font.family, fingerprint: font.fingerprint, missing: font.missing }))} canManageDefaults={canManageDefaults} />
    </Stack>
  );
}

function AudioSection({ profile }: { profile: Profile }) {
  return (
    <Stack gap="7">
      <SectionHeader icon={<AudioLines size={18} />} title="Audio references" />
      {profile.audio.length === 0 ? <EmptyState icon={<AudioLines size={18} />} title="No referenced audio" description="Add music or sound effects from your audio library." /> : <Stack gap="0" borderTopWidth="1px" borderColor="border">{profile.audio.map((audio, index) => <Flex key={audio.id} align="center" gap="4" py="4" borderBottomWidth="1px" borderColor="border.subtle"><Text textStyle="data" color="fg.subtle">{String(index + 1).padStart(2, "0")}</Text><Text fontSize="13px" fontWeight="600" flex="1">{audio.title}</Text><Text textStyle="eyebrow" color="fg.subtle">{audio.kind}</Text><Text textStyle="data" color="fg.timecode">{formatDuration(audio.durationSec)}</Text></Flex>)}</Stack>}
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
      <Stack gap="0" borderTopWidth="1px" borderColor="border">{rows.map(([label, value]) => <Grid key={label} templateColumns={{ base: "1fr", md: "180px 1fr" }} gap="3" py="4" borderBottomWidth="1px" borderColor="border.subtle"><Text textStyle="eyebrow" color="fg.subtle">{label}</Text><Text fontSize="13px" lineHeight="1.6">{value}</Text></Grid>)}</Stack>
    </Stack>
  );
}
