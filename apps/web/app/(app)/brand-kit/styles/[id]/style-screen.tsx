"use client";

import { Box, Stack } from "@chakra-ui/react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { planUpgradeHighlight } from "@narriflow/validators";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { PlanLimitNotice } from "../../../_components/plan-limit-notice";
import { useWorkspaceBootstrap } from "../../../_components/usage";
import { AccessNote } from "../../../settings/_components/access-note";
import { BrandLoadFailure, useBrandApi } from "../../_components/brand-api";
import { BrandApiProvider, useBrandScope } from "../../_components/brand-api-provider";
import { BrandFontsProvider } from "../../_components/brand-fonts";
import { TemplateForm } from "../../_components/template-form";
import EditStyleLoading from "./loading";

/** Edit a caption style: the style, the profile it belongs to and the fonts it can use, read together. */
export function EditStyleScreen({ templateId }: { templateId: string }) {
  const scope = useBrandScope();
  if (!scope) return <EditStyleLoading />;
  return (
    <BrandApiProvider key={scope.workspaceId} scope={scope}>
      <EditStyleContent key={templateId} templateId={templateId} />
    </BrandApiProvider>
  );
}

function EditStyleContent({ templateId }: { templateId: string }) {
  const { queries, scope } = useBrandApi();
  const templateQuery = useQuery(queries.template(templateId));
  const profileQuery = useQuery(queries.templateProfile(templateId));
  const assetsQuery = useQuery(queries.templateEditorAssets(templateId));
  const bootstrap = useWorkspaceBootstrap(scope);

  const failed = [templateQuery, profileQuery, assetsQuery, bootstrap].find((query) => query.isError && !query.data);
  if (failed) {
    return (
      <BrandLoadFailure
        what="This style"
        error={failed.error}
        onRetry={() => {
          void templateQuery.refetch();
          void profileQuery.refetch();
          void assetsQuery.refetch();
          void bootstrap.refetch();
        }}
      />
    );
  }
  if (!templateQuery.data || !profileQuery.data || !assetsQuery.data || !bootstrap.data) return <EditStyleLoading />;

  const template = templateQuery.data;
  const { profileId } = profileQuery.data;
  const { fonts, access, plan } = assetsQuery.data;
  const { workspace } = bootstrap.data;
  const returnHref = profileId ? `/brand-kit/${profileId}?section=styles&template=${templateId}` : "/brand-kit?tab=styles";

  if (template.isBuiltIn) {
    return (
      <Stack gap="8">
        <Box animation="fade-up" animationFillMode="backwards">
          <PageHeader
            title={template.name}
            description="Built-in styles are read-only. Duplicate to customize."
            actions={
              <Button variant="subtle" asChild>
                <Link href={returnHref}>Back</Link>
              </Button>
            }
          />
        </Box>
      </Stack>
    );
  }

  // Saving follows brand-template.service.ts update: `brand.manage` and custom styles on the plan.
  const mayEdit = access.canManageBrand;
  const styleRequirement = plan.customTemplates;
  const fontRequirement = plan.customFonts;
  if (mayEdit && !styleRequirement) {
    return (
      <BrandFontsProvider
        fonts={fonts}
        requirement={fontRequirement?.message ?? null}
        upgrade={fontRequirement?.requiredTier ? { tier: fontRequirement.requiredTier, headline: "Upgrade to use custom fonts", canManageBilling: access.canManageBilling } : null}
      >
        <TemplateForm mode="edit" initialTemplate={template} cancelHref={returnHref} />
      </BrandFontsProvider>
    );
  }
  return (
    <Stack gap="8">
      <Box animation="fade-up" animationFillMode="backwards">
        <PageHeader
          title={template.name}
          description="Changes apply to new projects only."
          actions={
            <Button variant="subtle" asChild>
              <Link href={returnHref}>Back</Link>
            </Button>
          }
        />
      </Box>
      {!mayEdit ? (
        <AccessNote access={workspace} capability="brand.manage" action="edit this style" />
      ) : styleRequirement ? (
        <PlanLimitNotice
          message={styleRequirement.message}
          upgrade={styleRequirement.requiredTier ? { tier: styleRequirement.requiredTier, headline: "Upgrade to edit your caption styles", highlight: planUpgradeHighlight(styleRequirement.requiredTier, "brand.customTemplates") } : null}
          canManageBilling={access.canManageBilling}
        />
      ) : null}
    </Stack>
  );
}
