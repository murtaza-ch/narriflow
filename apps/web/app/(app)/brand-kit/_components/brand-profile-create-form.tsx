"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Box, Grid, Stack, Text, Textarea } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { Input } from "@narriflow/ui/components/input";
import { Select } from "@narriflow/ui/components/select";
import { toaster } from "@narriflow/ui/components/toaster";

function slugify(value: string) {
  return value.toLocaleLowerCase("en-US").trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <Stack gap="1.5"><Text textStyle="eyebrow" color="fg.subtle">{label}</Text>{children}</Stack>;
}

export function BrandProfileCreateForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [primaryColor, setPrimaryColor] = useState("#FFFFFF");
  const [secondaryColor, setSecondaryColor] = useState("#111522");
  const [accentColor, setAccentColor] = useState("#5B6CFF");
  const [audience, setAudience] = useState("");
  const [tone, setTone] = useState("");
  const [preferredTerms, setPreferredTerms] = useState("");
  const [blockedTerms, setBlockedTerms] = useState("");
  const [hashtagGuidance, setHashtagGuidance] = useState("");
  const [approvalRule, setApprovalRule] = useState("none");

  function submit() {
    startTransition(async () => {
      try {
        const response = await fetch("/api/brand-profiles", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            slug: slug || slugify(name),
            identity: { primaryColor, secondaryColor, accentColor, primaryLogoAssetId: null, alternateLogoAssetId: null },
            voice: {
              audience,
              tone: tone.split(",").map((item) => item.trim()).filter(Boolean),
              preferredTerms: preferredTerms.split(",").map((item) => item.trim()).filter(Boolean),
              blockedTerms: blockedTerms.split(",").map((item) => item.trim()).filter(Boolean),
              hashtagGuidance,
            },
            approvalRule,
          }),
        });
        const payload = await response.json().catch(() => null) as { id?: string; message?: string } | null;
        if (!response.ok || !payload?.id) throw new Error(payload?.message ?? "The profile could not be created.");
        toaster.create({ type: "success", title: "Brand Profile created" });
        router.push(`/brand-kit/${payload.id}`);
        router.refresh();
      } catch (error) {
        toaster.create({ type: "error", title: "Could not create profile", description: error instanceof Error ? error.message : "Please try again." });
      }
    });
  }

  const valid = name.trim().length > 0 && (slug || slugify(name)).length > 0;
  return (
    <Stack gap="8" animation="fade-up" animationFillMode="backwards" style={{ animationDelay: "55ms" }}>
      <Grid templateColumns={{ base: "1fr", lg: "1fr 1fr" }} gap="8">
        <Stack gap="5">
          <Box borderTopWidth="1px" borderColor="border" pt="4"><Text textStyle="title" fontSize="21px">Identity</Text></Box>
          <Field label="Profile name"><Input aria-label="Profile name" value={name} onChange={(event) => { const next = event.currentTarget.value; setName(next); if (!slugEdited) setSlug(slugify(next)); }} maxLength={80} placeholder="Northstar Coffee" /></Field>
          <Field label="URL slug"><Input aria-label="URL slug" value={slug} onChange={(event) => { setSlugEdited(true); setSlug(slugify(event.currentTarget.value)); }} maxLength={80} fontFamily="mono" /></Field>
          <Grid templateColumns="repeat(3, 1fr)" gap="3">
            {[{ label: "Primary", value: primaryColor, set: setPrimaryColor }, { label: "Secondary", value: secondaryColor, set: setSecondaryColor }, { label: "Signal", value: accentColor, set: setAccentColor }].map((color) => <Field key={color.label} label={color.label}><Input type="color" aria-label={color.label} value={color.value} onChange={(event) => color.set(event.currentTarget.value.toUpperCase())} p="1" /></Field>)}
          </Grid>
          <Field label="Publishing rule"><Select ariaLabel="Publishing rule" items={[{ label: "Direct publish", value: "none" }, { label: "Approval required", value: "approval_required" }]} value={approvalRule} onValueChange={setApprovalRule} /></Field>
        </Stack>
        <Stack gap="5">
          <Box borderTopWidth="1px" borderColor="border" pt="4"><Text textStyle="title" fontSize="21px">Voice</Text></Box>
          <Field label="Audience"><Textarea aria-label="Audience" value={audience} onChange={(event) => setAudience(event.currentTarget.value)} maxLength={500} resize="vertical" placeholder="Who should this brand sound like it understands?" /></Field>
          <Field label="Tone · comma separated"><Input aria-label="Tone · comma separated" value={tone} onChange={(event) => setTone(event.currentTarget.value)} placeholder="warm, specific, practical" /></Field>
          <Field label="Preferred terms"><Input aria-label="Preferred terms" value={preferredTerms} onChange={(event) => setPreferredTerms(event.currentTarget.value)} placeholder="coffee bar, seasonal menu" /></Field>
          <Field label="Blocked terms"><Input aria-label="Blocked terms" value={blockedTerms} onChange={(event) => setBlockedTerms(event.currentTarget.value)} placeholder="cheap, viral hack" /></Field>
          <Field label="Hashtag guidance"><Textarea aria-label="Hashtag guidance" value={hashtagGuidance} onChange={(event) => setHashtagGuidance(event.currentTarget.value)} maxLength={500} resize="vertical" placeholder="Use two local tags and one campaign tag." /></Field>
        </Stack>
      </Grid>
      <Box borderTopWidth="1px" borderColor="border" pt="5"><Button onClick={submit} disabled={!valid || pending}>{pending ? "Creating…" : "Create Brand Profile"}</Button></Box>
    </Stack>
  );
}
