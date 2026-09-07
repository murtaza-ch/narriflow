import { Box, Stack, Text } from "@chakra-ui/react";
import Link from "next/link";
import { isProgramWriteEnabled } from "@narriflow/services";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { BrandProfileCreateForm } from "../_components/brand-profile-create-form";

export default async function NewBrandProfilePage() {
  await admitWorkspacePage("brand.manage");
  const enabled = isProgramWriteEnabled("brand_profiles");
  return (
    <Stack gap="8">
      <Box animation="fade-up" animationFillMode="backwards">
        <PageHeader
          title="Build a Brand Profile"
          description="Applies to new projects. Add styles and media next."
          actions={<Button variant="outline" asChild><Link href="/brand-kit">Cancel</Link></Button>}
        />
      </Box>
      {enabled ? <BrandProfileCreateForm /> : (
        <Box  bg="bg.panel" borderWidth="1px" borderRadius="l2" borderColor="border" p="7">
          <Stack gap="2"><Text textStyle="eyebrow" color="accent.fg">Read-only release group</Text><Text fontSize="14px">Brand Profile creation is paused. Existing profiles and projects remain readable.</Text></Stack>
        </Box>
      )}
    </Stack>
  );
}
