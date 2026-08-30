import { Box, Flex, Grid, Image, Stack, Text } from "@chakra-ui/react";
import { ArrowLeft, AudioLines, ImageIcon, LayoutTemplate, MessageSquareText, Shapes, Type } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { brandProfileService, BrandProfileNotFoundError } from "@narriflow/services";
import { Button } from "@narriflow/ui/components/button";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { MediaWell } from "@narriflow/ui/components/media-well";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import LegacyTemplatePage from "../../settings/brand-templates/[id]/page";

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
    const profileId = await brandProfileService.resolveProfileForTemplate(scope, id);
    if (profileId) redirect(`/brand-kit/${profileId}?section=styles&template=${id}`);
    return LegacyTemplatePage({ params: Promise.resolve({ id }) });
  }
  const section: Section = SECTIONS.includes(query.section as Section) ? query.section as Section : "identity";

  return (
    <Stack gap="8">
      <Box animation="fade-up" animationFillMode="backwards">
        <PageHeader
          eyebrow={`Brand Profile · ${String(profile.revision).padStart(2, "0")}`}
          title={profile.name}
          description={`${profile.templates.length} styles · ${profile.assets.length} assets · ${profile.fonts.length} fonts · ${profile.approvalRule === "approval_required" ? "approval required" : "direct publish"}`}
          actions={<Button size="sm" variant="outline" asChild><Link href="/brand-kit"><ArrowLeft size={13} /> Profiles</Link></Button>}
        />
      </Box>

      <Flex gap="0" borderTopWidth="1px" borderBottomWidth="1px" borderColor="border" overflowX="auto" animation="rule-in">
        {SECTIONS.map((item) => (
          <Link key={item} href={`/brand-kit/${profile.id}?section=${item}`}>
            <Text px="4" py="3" textStyle="eyebrow" whiteSpace="nowrap" color={section === item ? "accent.fg" : "fg.muted"} borderBottomWidth="2px" borderColor={section === item ? "accent.solid" : "transparent"}>
              {item}
            </Text>
          </Link>
        ))}
      </Flex>

      <Box animation="fade-up" animationFillMode="backwards" style={{ animationDelay: "55ms" }}>
        {section === "identity" && <IdentitySection profile={profile} />}
        {section === "styles" && <StylesSection profile={profile} selectedTemplateId={query.template} />}
        {section === "assets" && <AssetsSection profile={profile} />}
        {section === "scenes" && <ScenesSection />}
        {section === "audio" && <AudioSection profile={profile} />}
        {section === "voice" && <VoiceSection profile={profile} />}
      </Box>
    </Stack>
  );
}

type Profile = Awaited<ReturnType<typeof brandProfileService.get>>;

function SectionHeader({ index, icon, title, description }: { index: string; icon: React.ReactNode; title: string; description: string }) {
  return (
    <Flex align="flex-start" gap="4" pb="5" borderBottomWidth="1px" borderColor="border">
      <Text textStyle="data" color="fg.subtle">{index}</Text>
      <Box color="accent.fg" pt="0.5">{icon}</Box>
      <Stack gap="1"><Text textStyle="title" fontSize="22px">{title}</Text><Text fontSize="13px" color="fg.muted">{description}</Text></Stack>
    </Flex>
  );
}

function IdentitySection({ profile }: { profile: Profile }) {
  return (
    <Stack gap="7">
      <SectionHeader index="01" icon={<Shapes size={18} />} title="Identity system" description="The stable visual facts frozen into each new project." />
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
        <Box layerStyle="blueprint" borderTopWidth="1px" borderBottomWidth="1px" borderColor="border" p="6">
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
      <SectionHeader index="02" icon={<LayoutTemplate size={18} />} title="Style presets" description="Existing Brand Template IDs remain stable inside this profile." />
      {profile.templates.length === 0 ? <EmptyState icon={<LayoutTemplate size={18} />} title="No style presets" description="Attach a custom Brand Template to make it available for new projects." /> : (
        <Grid templateColumns={{ base: "1fr", md: "repeat(2, 1fr)", xl: "repeat(3, 1fr)" }} gap="4">
          {profile.templates.map((template, index) => {
            const selected = selectedTemplateId === template.id || (!selectedTemplateId && profile.defaultTemplateId === template.id);
            return (
              <Stack key={template.id} gap="4" borderTopWidth="1px" borderBottomWidth="1px" borderColor={selected ? "border.accent" : "border"} p="4" position="relative" _before={{ content: '""', position: "absolute", insetInlineStart: "0", top: "0", bottom: "0", w: "3px", bg: selected ? "accent.solid" : "transparent" }}>
                <Flex align="center" gap="2"><Text textStyle="data" color="fg.subtle">{String(index + 1).padStart(2, "0")}</Text><Box h="1px" bg="border" flex="1" /><Text textStyle="eyebrow" color={selected ? "accent.fg" : "fg.subtle"}>{selected ? "Selected" : "Preset"}</Text></Flex>
                <Text fontFamily="display" fontWeight="650" fontSize="20px">{template.name}</Text>
                <Flex gap="2"><Box h="7px" flex="1" borderRadius="l1" style={{ background: template.primaryColor }} /><Box h="7px" flex="1" borderRadius="l1" style={{ background: template.secondaryColor }} /></Flex>
                <Button size="xs" variant="outline" asChild><Link href={`/settings/brand-templates/${template.id}`}>Edit style</Link></Button>
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
      <SectionHeader index="03" icon={<ImageIcon size={18} />} title="Visual assets" description="Reusable images and video remain private; access locations are short-lived." />
      {profile.assets.length === 0 ? <EmptyState icon={<ImageIcon size={18} />} title="No visual assets" description="Uploads appear here after visual-asset writes are enabled for this release group." /> : (
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

function ScenesSection() {
  return (
    <Stack gap="7">
      <SectionHeader index="04" icon={<Type size={18} />} title="Scene templates" description="Bounded intros, outros, and cards will live here without creating a second editor." />
      <Box layerStyle="blueprint" borderTopWidth="1px" borderBottomWidth="1px" borderColor="border" p={{ base: "5", md: "8" }}>
        <Grid templateColumns={{ base: "1fr", md: "repeat(3, 1fr)" }} gap="6">
          {["Intro", "Card", "Outro"].map((label, index) => <Stack key={label} gap="3" ps="4" borderInlineStartWidth="3px" borderColor={index === 1 ? "accent.solid" : "border.control"}><Text textStyle="data" color="fg.subtle">0{index + 1}</Text><Text textStyle="title" fontSize="20px">{label}</Text><Text fontSize="12.5px" color="fg.muted">Defined here, inserted later through the Clip Editor Document.</Text></Stack>)}
        </Grid>
      </Box>
    </Stack>
  );
}

function AudioSection({ profile }: { profile: Profile }) {
  return (
    <Stack gap="7">
      <SectionHeader index="05" icon={<AudioLines size={18} />} title="Audio references" description="The existing Audio Asset library stays authoritative; profiles only reference rows." />
      {profile.audio.length === 0 ? <EmptyState icon={<AudioLines size={18} />} title="No referenced audio" description="Attach existing music or sound effects without copying their storage or metadata." /> : <Stack gap="0" borderTopWidth="1px" borderColor="border">{profile.audio.map((audio, index) => <Flex key={audio.id} align="center" gap="4" py="4" borderBottomWidth="1px" borderColor="border.subtle"><Text textStyle="data" color="fg.subtle">{String(index + 1).padStart(2, "0")}</Text><Text fontSize="13px" fontWeight="600" flex="1">{audio.title}</Text><Text textStyle="eyebrow" color="fg.subtle">{audio.kind}</Text><Text textStyle="data" color="fg.timecode">{Math.round(audio.durationSec)}s</Text></Flex>)}</Stack>}
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
      <SectionHeader index="06" icon={<MessageSquareText size={18} />} title="Voice guidance" description="Reusable writing constraints for assisted copy and campaign delivery." />
      <Stack gap="0" borderTopWidth="1px" borderColor="border">{rows.map(([label, value]) => <Grid key={label} templateColumns={{ base: "1fr", md: "180px 1fr" }} gap="3" py="4" borderBottomWidth="1px" borderColor="border.subtle"><Text textStyle="eyebrow" color="fg.subtle">{label}</Text><Text fontSize="13px" lineHeight="1.6">{value}</Text></Grid>)}</Stack>
    </Stack>
  );
}
