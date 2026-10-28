"use client";

import Link from "next/link";
import { Box, chakra, Flex, SimpleGrid, Stack, Text } from "@chakra-ui/react";
import { Checkbox } from "@narriflow/ui/components/checkbox";
import { NumberInput } from "@narriflow/ui/components/number-input";
import { Switch } from "@narriflow/ui/components/switch";
import { clipAspectRatioOptions, PLAN_CATALOG, socialPlatformSchema, type ClipAspectRatio, type SocialPlatform } from "@narriflow/validators";
import { featureUpgradePrompt } from "@/lib/feature-upgrade-prompt";
import { SOCIAL_PLATFORM_LABELS } from "@/lib/social-post-status";
import { PlanLimitNotice } from "../_components/plan-limit-notice";
import { ToggleCard } from "../_shared/settings-fields";
import { UpgradeGem, useUpgrade } from "../_components/upgrade";
import type { FinishingDraft } from "./finishing-form";

function toggle<T>(values: T[], value: T, on: boolean): T[] {
  return on ? [...values.filter((entry) => entry !== value), value] : values.filter((entry) => entry !== value);
}

/** Finishing: export the best clips and write copy for each new video. */
export function FinishingFields({
  idPrefix,
  draft,
  onChange,
  available,
  queueAccounts = [],
}: {
  idPrefix: string;
  draft: FinishingDraft;
  onChange: (draft: FinishingDraft) => void;
  /** Finishing needs the Pro plan; below it the switch stays off. */
  available: boolean;
  /** Connected accounts a finished clip can be proposed to. */
  queueAccounts?: Array<{ id: string; platform: SocialPlatform; displayName: string }>;
}) {
  const { currentTier, openUpgrade } = useUpgrade();
  const set = (patch: Partial<FinishingDraft>) => onChange({ ...draft, ...patch });
  const upgrade = available ? null : featureUpgradePrompt(currentTier, "campaign.operations", "Upgrade to finish clips automatically");
  // Review rounds go out under a Business grant; below it the switch explains the upgrade.
  const reviewUpgrade = featureUpgradePrompt(currentTier, "review.rooms", "Upgrade to send review rounds");
  return (
    <Stack gap="3">
      <ToggleCard
        title="Finish new clips automatically"
        description="Export the best clips and write copy, then leave them ready to review."
      >
        {upgrade?.tier ? <UpgradeGem label={`Needs ${PLAN_CATALOG[upgrade.tier].name}`} /> : null}
        <Switch
          checked={draft.enabled && available}
          // Below Pro the switch stays clickable and explains the upgrade instead of greying out.
          disabled={!available && !draft.enabled && !upgrade?.tier}
          onCheckedChange={(enabled) => {
            if (enabled && !available) {
              if (upgrade) openUpgrade(upgrade);
              return;
            }
            set({ enabled });
          }}
          inputProps={{ "aria-label": "Finish new clips automatically" }}
        />
      </ToggleCard>

      {!available ? (
        <PlanLimitNotice
          message="Finishing needs the Pro plan. Videos still import and generate clips without it."
          upgrade={upgrade}
        />
      ) : null}

      {draft.enabled && available ? (
        <Stack gap="3.5" bg="bg.subtle" borderRadius="l2" p="3.5">
          <SimpleGrid columns={{ base: 1, sm: 2 }} gap="3">
            <Stack gap="1.5">
              <chakra.label htmlFor={`${idPrefix}-top-clips`} fontSize="13px" fontWeight="500" color="fg">
                Top clips
              </chakra.label>
              <NumberInput
                value={draft.topClips}
                onValueChange={(topClips) => set({ topClips })}
                min={1}
                max={10}
                size="sm"
                inputProps={{ id: `${idPrefix}-top-clips` }}
              />
            </Stack>
            <Stack gap="1.5">
              <chakra.label htmlFor={`${idPrefix}-min-score`} fontSize="13px" fontWeight="500" color="fg">
                Minimum score
              </chakra.label>
              <NumberInput
                value={draft.minScore}
                onValueChange={(minScore) => set({ minScore })}
                min={0}
                max={100}
                size="sm"
                inputProps={{ id: `${idPrefix}-min-score` }}
              />
            </Stack>
          </SimpleGrid>

          <Stack gap="2">
            <Text fontSize="13px" fontWeight="500" color="fg">
              Export formats
            </Text>
            <Flex wrap="wrap" columnGap="4" rowGap="2">
              {clipAspectRatioOptions.map((option) => (
                <Checkbox
                  key={option.value}
                  size="sm"
                  checked={draft.aspectRatios.includes(option.value as ClipAspectRatio)}
                  onCheckedChange={(on) => set({ aspectRatios: toggle(draft.aspectRatios, option.value as ClipAspectRatio, on) })}
                >
                  {option.label}
                </Checkbox>
              ))}
            </Flex>
          </Stack>

          <Stack gap="2">
            <Text fontSize="13px" fontWeight="500" color="fg">
              Write copy for
            </Text>
            <Flex wrap="wrap" columnGap="4" rowGap="2">
              {socialPlatformSchema.options.map((platform: SocialPlatform) => (
                <Checkbox
                  key={platform}
                  size="sm"
                  checked={draft.copyPlatforms.includes(platform)}
                  onCheckedChange={(on) => set({ copyPlatforms: toggle(draft.copyPlatforms, platform, on) })}
                >
                  {SOCIAL_PLATFORM_LABELS[platform]}
                </Checkbox>
              ))}
            </Flex>
          </Stack>

          {queueAccounts.length === 0 && draft.delivery !== "propose_to_queue" ? (
            <Text fontSize="12px" color="fg.muted">
              <chakra.span asChild color="fg" fontWeight="500" textDecoration="underline" textUnderlineOffset="3px">
                <Link href="/settings/social-accounts">Connect a social account</Link>
              </chakra.span>{" "}
              to propose finished clips to your publishing queue.
            </Text>
          ) : (
            <Stack gap="2">
              <Flex align="center" justify="space-between" gap="4">
                <Box minW="0">
                  <Text fontSize="13px" fontWeight="500" color="fg">
                    Propose posts to my publishing queue
                  </Text>
                  <Text fontSize="12px" color="fg.muted">
                    Each finished clip waits there with its copy until you accept it into a posting slot. Nothing posts on its own.
                  </Text>
                </Box>
                <Switch
                  size="sm"
                  checked={draft.delivery === "propose_to_queue"}
                  onCheckedChange={(on) => set({ delivery: on ? "propose_to_queue" : "ready_to_review" })}
                  inputProps={{ "aria-label": "Propose posts to my publishing queue" }}
                />
              </Flex>
              {draft.delivery === "propose_to_queue" ? (
                <Flex wrap="wrap" columnGap="4" rowGap="2">
                  {queueAccounts.map((account) => (
                    <Checkbox
                      key={account.id}
                      size="sm"
                      checked={draft.queueAccountIds.includes(account.id)}
                      onCheckedChange={(on) => set({ queueAccountIds: toggle(draft.queueAccountIds, account.id, on) })}
                    >
                      {account.displayName} ({SOCIAL_PLATFORM_LABELS[account.platform]})
                    </Checkbox>
                  ))}
                </Flex>
              ) : null}
            </Stack>
          )}

          <Flex align="center" justify="space-between" gap="4">
            <Box minW="0">
              <Text fontSize="13px" fontWeight="500" color="fg">
                Send a review round to the grant's reviewers
              </Text>
              <Text fontSize="12px" color="fg.muted">
                Sends the finished clips to the reviewers an automation grant names, once per episode.{" "}
                {reviewUpgrade?.tier ? (
                  `Review rounds need the ${PLAN_CATALOG[reviewUpgrade.tier].name} plan; without it the clips wait for you.`
                ) : (
                  <>
                    It needs an active grant for the rule; without one the clips wait for you.{" "}
                    <chakra.span asChild color="fg" fontWeight="500" textDecoration="underline" textUnderlineOffset="3px">
                      <Link href="/settings/automation-grants">Manage grants</Link>
                    </chakra.span>
                  </>
                )}
              </Text>
            </Box>
            <Flex align="center" gap="2" flexShrink={0}>
              {reviewUpgrade?.tier ? <UpgradeGem label={`Needs ${PLAN_CATALOG[reviewUpgrade.tier].name}`} /> : null}
              <Switch
                size="sm"
                checked={draft.delivery === "send_review_round"}
                onCheckedChange={(on) => {
                  if (on && reviewUpgrade?.tier) {
                    openUpgrade(reviewUpgrade);
                    return;
                  }
                  set({ delivery: on ? "send_review_round" : "ready_to_review", queueAccountIds: [] });
                }}
                inputProps={{ "aria-label": "Send a review round to the grant's reviewers" }}
              />
            </Flex>
          </Flex>
        </Stack>
      ) : null}
    </Stack>
  );
}
