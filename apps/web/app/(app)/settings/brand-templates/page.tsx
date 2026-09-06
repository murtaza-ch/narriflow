import { Box, Flex, Grid, Image, Stack, Text } from "@chakra-ui/react";
import Link from "next/link";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { audioAssetService, brandTemplateService } from "@narriflow/services";
import { TemplateGallery } from "./_components/template-gallery";
import { BrandAudioPanel } from "./_components/brand-audio-panel";

const TABS = ["templates", "logos", "colors", "audio"] as const;
type BrandKitTab = (typeof TABS)[number];

export default async function BrandKitPage({ searchParams,
}: { searchParams?: Promise<{ tab?: string }>;
}) {
  const appUser = await admitWorkspacePage("content.view");
  const params = await searchParams;
  const tab: BrandKitTab = TABS.includes(params?.tab as BrandKitTab) ? (params!.tab as BrandKitTab)
    : "templates";
  const context = { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId,
  };
  const data = await brandTemplateService.list(appUser.workspaceOwnerUserId, context,
  );
  const canManage = appUser.workspace.role !== "viewer" && (appUser.workspace.status === "active" || appUser.workspace.role === "owner");
  const logos = tab === "logos"
    ? (await Promise.all(data.mine.filter((template) => template.logoStorageKey).map(async (template) => ({ template, url: await brandTemplateService.getLogoDownloadUrl(appUser.workspaceOwnerUserId, template.id, context,
                ),
              })),
          )).filter((item) => item.url)
    : [];
  const audio = tab === "audio"
    ? (await Promise.all([
        audioAssetService.listAssets(appUser.workspaceOwnerUserId, { kind: "music" }, context,
            ),
        audioAssetService.listAssets(appUser.workspaceOwnerUserId, { kind: "sfx" }, context,
            ),
      ])).flatMap((group) => group.assets).filter((asset) => asset.scope === "user")
    : [];

  return (
    <Stack gap="8">
      <Box animation="fade-up" animationFillMode="backwards">
        <PageHeader
          title="Brand kit"
          description="Pick a style for new clips. Your default is applied to every project unless you choose a different template at upload."
          actions={canManage && tab === "templates" ? (
            <Button asChild>
              <Link href="/brand-kit/new">New template</Link>
            </Button>
          ) : undefined}
        />
      </Box>
      <Flex gap="1" borderBottomWidth="1px" borderColor="border" overflowX="auto">
        {TABS.map((value) => (
          <Button key={value} size="sm" variant={tab === value ? "outline" : "ghost"} asChild><Link href={value === "templates" ? "/brand-kit" : `/brand-kit?tab=${value}`}>{value.charAt(0).toUpperCase() + value.slice(1)}</Link></Button>))}
      </Flex>
      <Box
        animation="fade-up"
        animationFillMode="backwards"
        style={{ animationDelay: "60ms" }}
      >
        {tab === "templates" ? (
          <TemplateGallery builtIns={data.builtIns} mine={data.mine} defaultId={data.defaultId} />
        ) : tab === "logos" ? (
          logos.length === 0 ? (
            <Text py="10" textAlign="center" color="fg.muted" fontSize="13px">Add a logo to a workspace template and it will appear here.</Text>
          ) : (
            <Grid templateColumns={{ base: "1fr", sm: "repeat(2, 1fr)", lg: "repeat(3, 1fr)",
              }} gap="4">{logos.map(({ template, url }) => (
                <Stack key={template.id} gap="3" p="5" bg="bg.subtle" borderTopWidth="1px" borderColor="border"><Flex h="120px" align="center" justify="center" layerStyle="well"><Image src={url ?? undefined} alt={`${template.name} logo`} maxH="88px" maxW="80%" objectFit="contain" /></Flex><Text fontSize="13px" fontWeight="600">{template.name}</Text><Button size="xs" variant="outline" asChild><Link href={`/brand-kit/${template.id}`}>Edit template</Link></Button></Stack>))}</Grid>
          )
        ) : tab === "colors" ? (
          data.mine.length === 0 ? (
            <Text py="10" textAlign="center" color="fg.muted" fontSize="13px">Create a workspace template to define reusable colors.</Text>
          ) : (
            <Stack gap="0" borderTopWidth="1px" borderColor="border">{data.mine.map((template) => (
                <Flex key={template.id} align="center" gap="4" py="4" borderBottomWidth="1px" borderColor="border.subtle"><Text fontSize="13px" fontWeight="600" flex="1">{template.name}</Text>{[{ label: "Primary", color: template.primaryColor }, { label: "Secondary", color: template.secondaryColor }, { label: "Accent", color: template.accentColor },
                  ].filter((swatch) => swatch.color).map((swatch) => (
                      <Stack key={swatch.label} gap="1" align="center"><Box w="9" h="9" borderRadius="l1" borderWidth="1px" borderColor="border" bg={swatch.color ?? undefined} /><Text textStyle="eyebrow" color="fg.subtle">{swatch.label}</Text></Stack>))}<Button size="xs" variant="ghost" asChild><Link href={`/brand-kit/${template.id}`}>Edit</Link></Button></Flex>))}</Stack>
          )
        ) : (
          <BrandAudioPanel assets={audio.map((asset) => ({ id: asset.id, kind: asset.kind, title: asset.title, durationSec: asset.durationSec, playbackUrl: asset.playbackUrl,
            }))} canManage={canManage} />
        )}
      </Box>
    </Stack>
  );
}
