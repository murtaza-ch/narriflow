"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Flex, Grid, Heading, Stack, Text, chakra } from "@chakra-ui/react";
import { ArrowLeft } from "lucide-react";
import { Button, IconButton } from "@narriflow/ui/components/button";
import { Input } from "@narriflow/ui/components/input";
import { SegmentedControl } from "@narriflow/ui/components/segmented-control";
import { toaster } from "@narriflow/ui/components/toaster";
import { failureMessage, useBrandApi, useIntent } from "./brand-api";
import { PlanLimitNotice } from "../../_components/plan-limit-notice";
import type { CreateBrandProfileInput } from "@narriflow/api-client/brand";
import type { UpgradePrompt } from "../../_components/upgrade";
import { BrandMark, Panel, PaletteDots, type BrandColors } from "./brand-kit-ui";
import { BrandColorPreview, BrandColorTiles, EMPTY_VOICE, VoiceFields, type VoiceDraft } from "./profile-fields";

function slugify(value: string) {
  return value.toLocaleLowerCase("en-US").trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return <Stack gap="1.5"><chakra.label htmlFor={htmlFor} fontSize="13px" fontWeight="500" color="fg">{label}</chakra.label>{children}</Stack>;
}

export function BrandProfileCreateForm({
  governance,
}: {
  /** Why the plan can't require approval, or `null` when it can. */
  governance: { message: string; upgrade: UpgradePrompt | null } | null;
}) {
  const router = useRouter();
  const { mutations, invalidate } = useBrandApi();
  const intent = useIntent<CreateBrandProfileInput>();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [colors, setColors] = useState<BrandColors>({ primaryColor: "#FFFFFF", secondaryColor: "#111522", accentColor: "#5B6CFF" });
  const [voice, setVoice] = useState<VoiceDraft>(EMPTY_VOICE);
  const [approvalRule, setApprovalRule] = useState("none");

  const create = useMutation({
    mutationFn: (input: CreateBrandProfileInput) => mutations.createProfile(input, intent.keyFor(input)),
    onSuccess: (created) => {
      intent.complete();
      toaster.create({ type: "success", title: "Brand Profile created" });
      router.push(`/brand-kit/${created.id}`);
      void invalidate();
    },
    onError: (error) =>
      toaster.create({ type: "error", title: "Could not create profile", description: failureMessage(error, "The profile could not be created.") }),
  });
  const pending = create.isPending;

  function submit() {
    create.mutate({
      name,
      slug: slug || slugify(name),
      identity: { ...colors, primaryLogoAssetId: null, alternateLogoAssetId: null },
      voice: { ...voice, audience: voice.audience.trim(), hashtagGuidance: voice.hashtagGuidance.trim() },
      approvalRule: approvalRule as CreateBrandProfileInput["approvalRule"],
    });
  }

  const valid = name.trim().length > 0 && (slug || slugify(name)).length > 0;
  return (
    <Stack gap="8">
      <Flex align="center" justify="space-between" gap="4" wrap="wrap" animation="fade-up" animationFillMode="backwards">
        <Flex align="center" gap="3" minW="0">
          <IconButton asChild size="sm" variant="ghost" aria-label="Back to Brand kit" ms="-2">
            <Link href="/brand-kit"><ArrowLeft size={16} /></Link>
          </IconButton>
          <BrandMark colors={colors} name={name || "New profile"} size={48} />
          <Stack gap="1" minW="0">
            <Heading as="h1" textStyle="title" fontSize={{ base: "22px", md: "28px" }} truncate>
              {name.trim() || "Build a Brand Profile"}
            </Heading>
            <Flex align="center" gap="2" fontSize="13px" color="fg.muted">
              <Text>Applies to new projects. Add styles and media next.</Text>
            </Flex>
          </Stack>
        </Flex>
        <Flex gap="2">
          <Button variant="subtle" asChild><Link href="/brand-kit">Cancel</Link></Button>
          <Button onClick={submit} disabled={!valid} loading={pending}>Create profile</Button>
        </Flex>
      </Flex>

      <Grid templateColumns={{ base: "1fr", lg: "minmax(0, 1.3fr) minmax(0, 1fr)" }} gap="5" alignItems="start" animation="fade-up" animationFillMode="backwards" style={{ animationDelay: "60ms" }}>
        <Stack gap="5">
          <Panel title="Identity">
            <Grid templateColumns={{ base: "1fr", sm: "1fr 1fr" }} gap="4">
              <Field label="Profile name" htmlFor="profile-name"><Input id="profile-name" aria-label="Profile name" value={name} onChange={(event) => { const next = event.currentTarget.value; setName(next); if (!slugEdited) setSlug(slugify(next)); }} maxLength={80} placeholder="Northstar Coffee" autoFocus /></Field>
              <Field label="URL slug" htmlFor="profile-slug"><Input id="profile-slug" aria-label="URL slug" value={slug} onChange={(event) => { setSlugEdited(true); setSlug(slugify(event.currentTarget.value)); }} maxLength={80} fontFamily="mono" placeholder="northstar-coffee" /></Field>
            </Grid>
          </Panel>
          <Panel title="Colors" action={<PaletteDots colors={colors} />}>
            <BrandColorTiles colors={colors} onChange={setColors} />
            <BrandColorPreview colors={colors} name={name} />
          </Panel>
          <Panel title="Publishing">
            {governance ? (
              <Text fontSize="14px" fontWeight="500">Direct publish</Text>
            ) : (
              <SegmentedControl aria-label="Publishing rule" items={[{ label: "Direct publish", value: "none" }, { label: "Approval required", value: "approval_required" }]} value={approvalRule} onValueChange={setApprovalRule} alignSelf="flex-start" />
            )}
            <Text fontSize="13px" color="fg.muted">
              {approvalRule === "approval_required" ? "Clips in new projects with this brand need review approval before they publish." : "Clips in new projects with this brand publish without a review."}
            </Text>
            {governance ? <PlanLimitNotice message={governance.message} upgrade={governance.upgrade} /> : null}
          </Panel>
        </Stack>
        <Panel title="Voice">
          <VoiceFields value={voice} onChange={setVoice} stacked />
        </Panel>
      </Grid>
    </Stack>
  );
}
