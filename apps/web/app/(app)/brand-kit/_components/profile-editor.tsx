"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Flex, Stack, Text } from "@chakra-ui/react";
import { useMutation } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { describeApiFailure } from "@narriflow/api-client";
import type { BrandProfileUpdateInput } from "@narriflow/validators";
import { Button } from "@narriflow/ui/components/button";
import { SegmentedControl } from "@narriflow/ui/components/segmented-control";
import { toaster } from "@narriflow/ui/components/toaster";
import { PlanLimitNotice } from "../../_components/plan-limit-notice";
import { LockedButton, type UpgradePrompt } from "../../_components/upgrade";
import { failureMessage, useBrandApi } from "./brand-api";
import { Panel, type BrandColors } from "./brand-kit-ui";
import { BrandColorPreview, BrandColorTiles, EMPTY_VOICE, VoiceFields, type VoiceDraft } from "./profile-fields";

type Patch = Omit<BrandProfileUpdateInput, "revision">;

const ProfilePatchContext = createContext<((patch: Patch, title: string) => Promise<boolean>) | null>(null);

/**
 * One writer for the profile's `PATCH`: it sends the latest revision it knows
 * (the response's, until the refetched profile arrives), so saving two panels
 * in a row doesn't conflict with itself.
 */
export function ProfileEditorProvider({ profileId, revision, children }: { profileId: string; revision: number; children: ReactNode }) {
  const { mutations, invalidate } = useBrandApi();
  const latest = useRef(revision);
  useEffect(() => {
    latest.current = Math.max(latest.current, revision);
  }, [revision]);

  const save = useMutation({
    mutationFn: ({ body }: { body: Patch; title: string }) =>
      mutations.updateProfile(profileId, { ...body, revision: latest.current }),
    onSuccess: async (updated, { title }) => {
      if (updated.revision) latest.current = updated.revision;
      toaster.create({ type: "success", title });
      await invalidate();
    },
    onError: async (error) => {
      // Changed elsewhere: load the latest revision so the next save can succeed.
      if (describeApiFailure(error).kind === "conflict") await invalidate();
      toaster.create({ type: "error", title: "Could not save the profile", description: failureMessage(error) });
    },
  });
  const patch = (body: Patch, title: string) =>
    save.mutateAsync({ body, title }).then(
      () => true,
      () => false,
    );
  return <ProfilePatchContext.Provider value={patch}>{children}</ProfilePatchContext.Provider>;
}

export function useProfilePatch() {
  const patch = useContext(ProfilePatchContext);
  if (!patch) throw new Error("useProfilePatch needs a ProfileEditorProvider");
  return patch;
}

/** What the viewer may do with the profile's own fields. */
export type ProfileEditAccess =
  | { mode: "edit" }
  /** The plan no longer includes Brand Profiles: fields stay readable, editing offers the upgrade. */
  | { mode: "locked"; upgrade: UpgradePrompt }
  | { mode: "read" };

function SaveBar({ dirty, saving, onReset, onSave, label }: { dirty: boolean; saving: boolean; onReset: () => void; onSave: () => void; label: string }) {
  if (!dirty) return null;
  return (
    <Flex gap="2" animation="fade-up">
      <Button size="sm" variant="ghost" disabled={saving} onClick={onReset}>
        Reset
      </Button>
      <Button size="sm" loading={saving} onClick={onSave}>
        {label}
      </Button>
    </Flex>
  );
}

function LockedEdit({ access, label }: { access: ProfileEditAccess; label: string }) {
  return access.mode === "locked" ? (
    <LockedButton size="sm" variant="subtle" prompt={access.upgrade}>
      <Pencil size={13} /> {label}
    </LockedButton>
  ) : null;
}

export function ProfileColorsPanel({
  name,
  identity,
  access,
}: {
  name: string;
  /** The whole identity: a PATCH replaces it, so logos travel along unchanged. */
  identity: BrandColors & { primaryLogoAssetId: string | null; alternateLogoAssetId: string | null };
  access: ProfileEditAccess;
}) {
  const patch = useProfilePatch();
  const saved: BrandColors = { primaryColor: identity.primaryColor, secondaryColor: identity.secondaryColor, accentColor: identity.accentColor };
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);
  const savedKey = JSON.stringify(saved);
  // A refresh after saving (or another editor's change) becomes the new baseline.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the serialized key tracks the saved colors.
  useEffect(() => setDraft(saved), [savedKey]);
  const dirty = JSON.stringify(draft) !== savedKey;

  async function save() {
    setSaving(true);
    await patch({ identity: { ...identity, ...draft } }, "Colors saved");
    setSaving(false);
  }
  return (
    <Panel
      title="Colors"
      action={access.mode === "edit" ? <SaveBar dirty={dirty} saving={saving} label="Save colors" onReset={() => setDraft(saved)} onSave={() => void save()} /> : <LockedEdit access={access} label="Edit" />}
    >
      <BrandColorTiles colors={draft} onChange={access.mode === "edit" ? setDraft : undefined} />
      <BrandColorPreview colors={draft} name={name} />
    </Panel>
  );
}

const APPROVAL_OPTIONS = [
  { label: "Direct publish", value: "none" },
  { label: "Approval required", value: "approval_required" },
];

export function ProfilePublishingPanel({
  approvalRule,
  access,
  governance,
}: {
  approvalRule: "none" | "approval_required";
  access: ProfileEditAccess;
  /** Why the plan can't require approval; `null` when it can. Turning approval off stays possible. */
  governance: { message: string; upgrade: UpgradePrompt | null } | null;
}) {
  const patch = useProfilePatch();
  const [value, setValue] = useState(approvalRule);
  const [saving, setSaving] = useState(false);
  useEffect(() => setValue(approvalRule), [approvalRule]);
  const editable = access.mode === "edit" && (!governance || approvalRule === "approval_required");

  async function choose(next: string) {
    const rule = next as typeof approvalRule;
    if (rule === value) return;
    setValue(rule);
    setSaving(true);
    const ok = await patch({ approvalRule: rule }, rule === "approval_required" ? "Posts now need approval" : "Posts publish directly");
    if (!ok) setValue(approvalRule);
    setSaving(false);
  }
  return (
    <Panel title="Publishing" action={<LockedEdit access={access} label="Edit" />}>
      <Stack gap="3">
        {editable ? (
          <SegmentedControl aria-label="Publishing rule" items={APPROVAL_OPTIONS} value={value} disabled={saving} onValueChange={(next) => void choose(next)} alignSelf="flex-start" />
        ) : (
          <Text fontSize="14px" fontWeight="500">
            {approvalRule === "approval_required" ? "Approval required" : "Direct publish"}
          </Text>
        )}
        <Text fontSize="13px" color="fg.muted">
          {value === "approval_required" ? "Clips in new projects with this brand need review approval before they publish." : "Clips in new projects with this brand publish without a review."}
        </Text>
        {access.mode === "edit" && governance && approvalRule !== "approval_required" ? <PlanLimitNotice message={governance.message} upgrade={governance.upgrade} /> : null}
      </Stack>
    </Panel>
  );
}

function voiceDraft(voice: VoiceDraft): VoiceDraft {
  return { ...EMPTY_VOICE, ...voice };
}

export function ProfileVoicePanel({ voice, access }: { voice: VoiceDraft; access: ProfileEditAccess }) {
  const patch = useProfilePatch();
  const saved = voiceDraft(voice);
  const savedKey = JSON.stringify(saved);
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the serialized key tracks the saved voice.
  useEffect(() => setDraft(saved), [savedKey]);
  const dirty = JSON.stringify(draft) !== savedKey;

  async function save() {
    setSaving(true);
    await patch({ voice: { ...draft, audience: draft.audience.trim(), hashtagGuidance: draft.hashtagGuidance.trim() } }, "Voice saved");
    setSaving(false);
  }
  return (
    <Panel
      title="Voice"
      action={access.mode === "edit" ? <SaveBar dirty={dirty} saving={saving} label="Save voice" onReset={() => setDraft(saved)} onSave={() => void save()} /> : <LockedEdit access={access} label="Edit" />}
    >
      <Text fontSize="13px" color="fg.muted" mt="-2">
        Post copy written for you follows this voice. Blocked terms are also offered to auto-censor.
      </Text>
      {access.mode === "edit" ? <VoiceFields value={draft} onChange={setDraft} /> : <VoiceSummary voice={saved} />}
    </Panel>
  );
}

function VoiceSummary({ voice }: { voice: VoiceDraft }) {
  const rows: [string, ReactNode][] = [
    ["Audience", voice.audience || null],
    ["Tone", voice.tone.length ? <Terms key="tone" values={voice.tone} /> : null],
    ["Preferred terms", voice.preferredTerms.length ? <Terms key="preferred" values={voice.preferredTerms} /> : null],
    ["Blocked terms", voice.blockedTerms.length ? <Terms key="blocked" values={voice.blockedTerms} blocked /> : null],
    ["Hashtags", voice.hashtagGuidance || null],
  ];
  return (
    <Stack gap="5">
      {rows.map(([label, value]) => (
        <Flex key={label} direction={{ base: "column", md: "row" }} gap={{ base: "1.5", md: "6" }}>
          <Text w={{ md: "200px" }} flexShrink={0} fontSize="13px" color="fg.muted">
            {label}
          </Text>
          {value === null ? (
            <Text fontSize="13px" color="fg.subtle">
              Not set
            </Text>
          ) : typeof value === "string" ? (
            <Text fontSize="13px" lineHeight="1.6">
              {value}
            </Text>
          ) : (
            value
          )}
        </Flex>
      ))}
    </Stack>
  );
}

function Terms({ values, blocked = false }: { values: string[]; blocked?: boolean }) {
  return (
    <Flex gap="1.5" wrap="wrap">
      {values.map((value) => (
        <Text
          key={value}
          as="span"
          px="2"
          h="6"
          display="inline-flex"
          alignItems="center"
          borderRadius="6px"
          fontSize="12.5px"
          fontWeight="500"
          bg={blocked ? "danger.subtle" : "bg.soft"}
          color={blocked ? "danger.fg" : "fg"}
        >
          {value}
        </Text>
      ))}
    </Flex>
  );
}
