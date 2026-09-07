import { Box, Flex, Grid, Image, Stack, Text } from "@chakra-ui/react";
import { ArrowRight, AudioLines, Check, ImageIcon, Type } from "lucide-react";
import Link from "next/link";
import { brandProfileService, brandTemplateService, hasFeature, isProgramWriteEnabled } from "@narriflow/services";
import { workspaceAllowsCapability } from "@narriflow/validators";
import { Button } from "@narriflow/ui/components/button";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { TemplateGallery } from "./_components/template-gallery";
import { BrandProfileDefaultButton } from "./_components/brand-profile-default-button";

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
  const [profiles, defaultProfileId, templates] = await Promise.all([
    brandProfileService.list(scope),
    brandProfileService.getDefaultId(scope),
    brandTemplateService.list(actor.workspaceOwnerUserId, { workspaceId: actor.workspaceId, actorUserId: actor.actorUserId }),
  ]);
  const canManage = workspaceAllowsCapability(
    { role: actor.role, status: actor.status },
    "brand.manage",
  ) && hasFeature(actor.pricingTier, "brand.profiles") && isProgramWriteEnabled("brand_profiles");

  return (
    <Stack gap="10">
      <Box animation="fade-up" animationFillMode="backwards">
        <PageHeader
          title="Brand kit"
          description="Manage your brand colors, fonts, assets, and caption styles."
          actions={canManage ? <Button asChild><Link href="/brand-kit/new">New profile</Link></Button> : undefined}
        />
      </Box>

      <Box animation="fade-up" animationFillMode="backwards" style={{ animationDelay: "90ms" }}>
        {profiles.length === 0 ? (
          <EmptyState icon={<ImageIcon size={20} />} title="No Brand Profiles yet" description="Save your brand colors, styles, and assets." />
        ) : (
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
                <Box key={profile.id} as="article" position="relative" borderRadius="l3" bg="bg.panel" py="5" ps="5" pe="4">
                  <Flex align="flex-start" justify="space-between" gap="5">
                    <Stack gap="5" minW="0" flex="1">
                      <Flex align="center" gap="3">
                        {isDefault && <Flex align="center" gap="1.5" color="accent.fg"><Check size={12} /><Text textStyle="eyebrow">Default</Text></Flex>}
                      </Flex>
                      <Flex gap="3" align="center">
                        <Flex
                          layerStyle="well"
                          w="12"
                          h="12"
                          flexShrink="0"
                          align="center"
                          justify="center"
                          overflow="hidden"
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
                        {[profile.identity.primaryColor, profile.identity.secondaryColor, profile.identity.accentColor].filter((color): color is string => Boolean(color)).map((color) => <Box key={color} w="30px" h="8px" borderRadius="l1" borderWidth="1px" borderColor="border" style={{ background: color }} />)}
                      </Flex>
                      <Flex gap="5" color="fg.muted" flexWrap="wrap">
                        <Flex align="center" gap="1.5"><ImageIcon size={13} /><Text textStyle="data" fontSize="11px">{profile.assets.length} assets</Text></Flex>
                        <Flex align="center" gap="1.5"><Type size={13} /><Text textStyle="data" fontSize="11px">{profile.fonts.length} fonts</Text></Flex>
                        <Flex align="center" gap="1.5"><AudioLines size={13} /><Text textStyle="data" fontSize="11px">{profile.audio.length} audio</Text></Flex>
                      </Flex>
                    </Stack>
                    <Stack align="flex-end" justify="space-between" minH="176px">
                      <Text textStyle="eyebrow" color={profile.approvalRule === "approval_required" ? "accent.fg" : "fg.subtle"}>{profile.approvalRule === "approval_required" ? "Approval required" : "Direct publish"}</Text>
                      <Button size="sm" variant="outline" asChild><Link href={`/brand-kit/${profile.id}`}>Open <ArrowRight size={13} /></Link></Button>
                      {canManage && !isDefault && <BrandProfileDefaultButton profileId={profile.id} />}
                    </Stack>
                  </Flex>
                </Box>
              );
            })}
          </Grid>
        )}
      </Box>

      <Box as="section" borderTopWidth="1px" borderColor="border" pt="7">
        <Stack gap="1" mb="5">
          <Flex justify="space-between" align="center"><Text textStyle="eyebrow" color="fg.subtle">Style library</Text><Button size="sm" variant="outline" asChild><Link href="/brand-kit/styles/new">New style</Link></Button></Flex>
          <Text fontSize="13px" color="fg.muted">Start with a built-in style or customize a saved preset.</Text>
        </Stack>
        <TemplateGallery builtIns={templates.builtIns} mine={templates.mine.filter((template) => !profiles.some((profile) => profile.templates.some((style) => style.id === template.id)))} defaultId={templates.defaultId} />
      </Box>
    </Stack>
  );
}
