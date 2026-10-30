"use client";

import { Box, Stack } from "@chakra-ui/react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { planUpgradeHighlight } from "@narriflow/validators";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { PlanLimitNotice } from "../../../_components/plan-limit-notice";
import { BrandLoadFailure, useBrandApi } from "../../_components/brand-api";
import { BrandApiProvider, useBrandScope } from "../../_components/brand-api-provider";
import { BrandFontsProvider } from "../../_components/brand-fonts";
import { TemplateForm } from "../../_components/template-form";
import NewStyleLoading from "./loading";
import { capabilityDeniedHref } from "@/lib/request-failure-notice";

/** New caption style: the editor, or the plan boundary that stops it, from the Brand kit aggregate. */
export function NewStyleScreen() {
  const scope = useBrandScope();
  if (!scope) return <NewStyleLoading />;
  return (
    <BrandApiProvider key={scope.workspaceId} scope={scope}>
      <NewStyleContent />
    </BrandApiProvider>
  );
}

function NewStyleContent() {
  const router = useRouter();
  const { queries } = useBrandApi();
  const kitQuery = useQuery(queries.kit());
  const data = kitQuery.data;
  const forbidden = data !== undefined && !data.access.canManageBrand;
  // Creating the style raises the count; the editor stays up while the new style opens.
  const decided = useRef<boolean | null>(null);
  if (data && decided.current === null) decided.current = data.plan.styleCreate === null;

  useEffect(() => {
    if (forbidden) router.replace(capabilityDeniedHref("brand-kit"));
  }, [forbidden, router]);

  if (kitQuery.isError && !data) {
    return <BrandLoadFailure what="Caption styles" error={kitQuery.error} onRetry={() => void kitQuery.refetch()} />;
  }
  if (!data || forbidden) return <NewStyleLoading />;

  const { plan, access, fonts } = data;
  if (decided.current) {
    const fontRequirement = plan.customFonts;
    return (
      <BrandFontsProvider
        fonts={fonts}
        requirement={fontRequirement?.message ?? null}
        upgrade={fontRequirement?.requiredTier ? { tier: fontRequirement.requiredTier, headline: "Upgrade to use custom fonts", canManageBilling: access.canManageBilling } : null}
      >
        <TemplateForm mode="create" cancelHref="/brand-kit?tab=styles" />
      </BrandFontsProvider>
    );
  }

  // Mirrors brand-template.service.ts create: the feature and its count only.
  const requirement = plan.styleCreate;
  const upgrade = requirement?.requiredTier
    ? {
        tier: requirement.requiredTier,
        headline: "Upgrade to save your own caption styles",
        highlight: planUpgradeHighlight(requirement.requiredTier, "brandTemplates"),
      }
    : null;
  return (
    <Stack gap="8">
      <Box animation="fade-up" animationFillMode="backwards">
        <PageHeader
          title="New style"
          description="Styles apply when you import a video."
          actions={
            <Button variant="subtle" asChild>
              <Link href="/brand-kit?tab=styles">Cancel</Link>
            </Button>
          }
        />
      </Box>
      <PlanLimitNotice
        message={requirement?.requiredTier ? requirement.message : `${requirement?.message ?? ""} Delete a style to add another.`}
        upgrade={upgrade}
        canManageBilling={access.canManageBilling}
      />
    </Stack>
  );
}
