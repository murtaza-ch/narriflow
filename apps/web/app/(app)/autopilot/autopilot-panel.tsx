"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Box, Flex, SimpleGrid, Stack, Text } from "@chakra-ui/react";
import {
  AlertTriangle,
  ChevronDown,
  Plus,
  RotateCw,
  Rss,
  Trash2,
} from "lucide-react";
import { Button, IconButton } from "@narriflow/ui/components/button";
import { CloseButton, Dialog, Portal } from "@narriflow/ui/components/dialog";
import { useConfirm } from "@narriflow/ui/components/confirm-dialog";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { Input } from "@narriflow/ui/components/input";
import { NumberInput } from "@narriflow/ui/components/number-input";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Select } from "@narriflow/ui/components/select";
import { Switch } from "@narriflow/ui/components/switch";
import { toaster } from "@narriflow/ui/components/toaster";
import {
  BRAND_DEFAULT_CAPTION_PRESET_ID,
  contentPackSchema,
  type AutopilotRuleSnapshot,
  type AutopilotStatus,
  type ContentPack,
} from "@narriflow/validators";
import { formatDateTime } from "@/lib/format";

const INTERVAL_OPTIONS = [
  { label: "Every 6 hours", value: "360" },
  { label: "Every 12 hours", value: "720" },
  { label: "Daily", value: "1440" },
  { label: "Weekly", value: "10080" },
];

function intervalLabel(minutes: number): string {
  return (
    INTERVAL_OPTIONS.find((option) => option.value === String(minutes))?.label ??
    `Every ${minutes} min`
  );
}

/** Status voice: 3px stripe + eyebrow label — never hue alone. */
const STATUS_META: Record<
  AutopilotStatus,
  { stripe: string; label: string; color: string }
> = {
  active: { stripe: "success.solid", label: "Active", color: "success.fg" },
  running: { stripe: "accent.solid", label: "Running", color: "fg.accent" },
  paused: { stripe: "fg.subtle", label: "Paused", color: "fg.muted" },
  failed: { stripe: "danger.solid", label: "Failed", color: "danger.fg" },
};

type RuleAction = "toggle" | "run" | "delete";

function buildContentPack(input: {
  clipCountTarget: number;
  autoRenderClips: boolean;
}): ContentPack {
  return contentPackSchema.parse({
    outputTypes: ["short_clip"],
    clipGenerationMode: "best",
    clipCountTarget: input.clipCountTarget,
    clipDurationSecTarget: 45,
    minDurationSec: 15,
    preferredMinDurationSec: 30,
    preferredMaxDurationSec: 60,
    maxDurationSec: 90,
    platformTargets: ["tiktok", "youtube_shorts", "instagram_reels"],
    autoRenderClips: input.autoRenderClips,
    toneConstraints: ["concise", "conversational"],
    captionPreset: BRAND_DEFAULT_CAPTION_PRESET_ID,
    platformPlaybookVersion: "2026.2",
    mode: "clip",
    autoHook: true,
    specificMoments: "",
    processingStartSec: null,
    processingEndSec: null,
    clipLengthPreset: "auto",
  });
}

async function request(
  url: string,
  init?: RequestInit,
): Promise<string | null> {
  try {
    const response = await fetch(url, init);
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        message?: string;
        error?: string;
      } | null;
      return payload?.message ?? payload?.error ?? "Request failed";
    }
    return null;
  } catch {
    return "Network error — please try again.";
  }
}

function FieldGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box>
      <Text textStyle="eyebrow" color="fg.subtle" mb="1.5">
        {label}
      </Text>
      <Box h="1px" bg="border" mb="3" />
      <Stack gap="3">{children}</Stack>
    </Box>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box>
      <Text fontSize="13px" fontWeight="500" color="fg" mb="1.5">
        {label}
      </Text>
      {children}
    </Box>
  );
}

export function AutopilotPanel({
  initialRules,
}: {
  initialRules: AutopilotRuleSnapshot[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const { confirm, dialog: confirmDialog } = useConfirm();

  // New-rule dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [name, setName] = useState("Podcast autopilot");
  const [rssUrl, setRssUrl] = useState("");
  const [titlePrefix, setTitlePrefix] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState("1440");
  const [maxEpisodesPerRun, setMaxEpisodesPerRun] = useState("3");
  const [clipCountTarget, setClipCountTarget] = useState("10");
  const [autoRenderClips, setAutoRenderClips] = useState(true);

  // Per-rule pending state — one in-flight action per rule, never global.
  const [pendingRules, setPendingRules] = useState<
    Record<string, RuleAction | undefined>
  >({});
  const [expandedErrors, setExpandedErrors] = useState<
    Record<string, boolean>
  >({});

  function setRulePending(ruleId: string, action: RuleAction | undefined) {
    setPendingRules((current) => ({ ...current, [ruleId]: action }));
  }

  function resetForm() {
    setName("Podcast autopilot");
    setRssUrl("");
    setTitlePrefix("");
    setIntervalMinutes("1440");
    setMaxEpisodesPerRun("3");
    setClipCountTarget("10");
    setAutoRenderClips(true);
    setFormError(null);
  }

  async function createRule() {
    if (!name.trim()) {
      setFormError("Rule name is required.");
      return;
    }
    if (!rssUrl.trim()) {
      setFormError("RSS feed URL is required.");
      return;
    }
    const maxEpisodes = Number(maxEpisodesPerRun);
    const clipCount = Number(clipCountTarget);
    if (!Number.isInteger(maxEpisodes) || maxEpisodes < 1 || maxEpisodes > 10) {
      setFormError("Max episodes must be between 1 and 10.");
      return;
    }
    if (!Number.isInteger(clipCount) || clipCount < 3 || clipCount > 30) {
      setFormError("Clips per episode must be between 3 and 30.");
      return;
    }

    setFormError(null);
    setCreating(true);
    const error = await request("/api/autopilot/rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        rssUrl: rssUrl.trim(),
        titlePrefix: titlePrefix.trim() || null,
        intervalMinutes: Number(intervalMinutes),
        maxEpisodesPerRun: maxEpisodes,
        contentPack: buildContentPack({
          clipCountTarget: clipCount,
          autoRenderClips,
        }),
      }),
    });
    setCreating(false);

    if (error) {
      setFormError(error);
      return;
    }
    setDialogOpen(false);
    resetForm();
    toaster.create({
      type: "success",
      title: "Rule created",
      description: "New episodes from this feed will be clipped automatically.",
    });
    startTransition(() => router.refresh());
  }

  async function toggleRule(rule: AutopilotRuleSnapshot, enabled: boolean) {
    setRulePending(rule.id, "toggle");
    const error = await request(`/api/autopilot/rules/${rule.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: enabled ? "active" : "paused" }),
    });
    setRulePending(rule.id, undefined);
    if (error) {
      toaster.create({
        type: "error",
        title: enabled ? "Could not resume rule" : "Could not pause rule",
        description: error,
      });
      return;
    }
    toaster.create({
      type: "success",
      title: enabled ? "Rule resumed" : "Rule paused",
      description: rule.name,
    });
    startTransition(() => router.refresh());
  }

  async function runNow(rule: AutopilotRuleSnapshot) {
    setRulePending(rule.id, "run");
    const error = await request(`/api/autopilot/rules/${rule.id}/run-now`, {
      method: "POST",
    });
    setRulePending(rule.id, undefined);
    if (error) {
      toaster.create({
        type: "error",
        title: "Could not queue run",
        description: error,
      });
      return;
    }
    toaster.create({
      type: "success",
      title: "Run queued",
      description: `${rule.name} will check its feed shortly.`,
    });
    startTransition(() => router.refresh());
  }

  async function deleteRule(rule: AutopilotRuleSnapshot) {
    const confirmed = await confirm({
      title: "Delete this autopilot rule?",
      description:
        "New episodes from this feed will no longer be imported. Existing projects are kept.",
      confirmLabel: "Delete rule",
      destructive: true,
    });
    if (!confirmed) return;

    setRulePending(rule.id, "delete");
    const error = await request(`/api/autopilot/rules/${rule.id}`, {
      method: "DELETE",
    });
    setRulePending(rule.id, undefined);
    if (error) {
      toaster.create({
        type: "error",
        title: "Could not delete rule",
        description: error,
      });
      return;
    }
    toaster.create({
      type: "success",
      title: "Rule deleted",
      description: rule.name,
    });
    startTransition(() => router.refresh());
  }

  return (
    <Stack gap="8" maxW="1080px" mx="auto">
      <Box animation="fade-up" animationFillMode="backwards">
        <PageHeader
          eyebrow="Automation"
          title="Autopilot"
          description="Watch RSS feeds and automatically queue new episodes for clipping."
          actions={
            <Button onClick={() => setDialogOpen(true)}>
              <Plus size={15} strokeWidth={2} aria-hidden />
              New rule
            </Button>
          }
        />
      </Box>

      <Box
        as="section"
        animation="fade-up"
        animationDelay="80ms"
        animationFillMode="backwards"
      >
        <Flex align="center" gap="2.5" mb="2">
          <Text textStyle="eyebrow" color="fg.subtle">
            Rules
          </Text>
          {/* Count rides next to the eyebrow as a quiet mono chip; omitted at zero. */}
          {initialRules.length > 0 ? (
            <Text
              textStyle="data"
              fontSize="11px"
              lineHeight="1"
              color="fg.muted"
              px="1.5"
              py="1"
              bg="bg.subtle"
              borderWidth="1px"
              borderColor="border"
              borderRadius="l1"
            >
              {initialRules.length}
            </Text>
          ) : null}
        </Flex>

        {initialRules.length === 0 ? (
          <Box layerStyle="band">
            <EmptyState
              icon={<Rss size={20} strokeWidth={1.75} />}
              title="No autopilot rules yet"
              description="Point a rule at an RSS feed and new episodes will be imported and clipped automatically."
              action={
                /* Header owns the solid CTA — this is a quiet accent link. */
                <Button
                  variant="plain"
                  size="sm"
                  color="fg.accent"
                  fontWeight="600"
                  textDecoration="underline"
                  textUnderlineOffset="3px"
                  _hover={{ color: "fg" }}
                  onClick={() => setDialogOpen(true)}
                >
                  Create your first rule
                </Button>
              }
            />
          </Box>
        ) : (
          <Box layerStyle="band" pt="0">
            {initialRules.map((rule) => {
              const meta = STATUS_META[rule.status];
              const pending = pendingRules[rule.id];
              const enabled = rule.status !== "paused";
              const expanded = Boolean(expandedErrors[rule.id]);

              return (
                <Box
                  key={rule.id}
                  position="relative"
                  borderBottomWidth="1px"
                  borderBottomColor="border.subtle"
                  transition="background 120ms ease"
                  _hover={{ bg: "bg.subtle" }}
                >
                  <Box
                    aria-hidden
                    position="absolute"
                    insetInlineStart="0"
                    top="4"
                    bottom="4"
                    w="3px"
                    borderRadius="full"
                    bg={meta.stripe}
                  />
                  <Flex ps="5" pe="2" py="4" gap="4" align="center" wrap="wrap">
                    <Box minW="0" flex="1">
                      <Flex align="center" gap="2.5" minW="0">
                        <Text
                          fontSize="14px"
                          textStyle="title"
                          color="fg"
                          truncate
                        >
                          {rule.name}
                        </Text>
                        <Text
                          textStyle="eyebrow"
                          color={meta.color}
                          flexShrink={0}
                        >
                          {meta.label}
                        </Text>
                      </Flex>
                      <Text
                        textStyle="data"
                        fontSize="12px"
                        color="fg.muted"
                        truncate
                        mt="1"
                      >
                        {rule.rssUrl}
                      </Text>
                      <Text
                        mt="1.5"
                        textStyle="data"
                        fontSize="12px"
                        color="fg.subtle"
                      >
                        {intervalLabel(rule.intervalMinutes)} ·{" "}
                        {rule.importedEpisodeCount} imported · last{" "}
                        {rule.lastCheckedAt
                          ? formatDateTime(rule.lastCheckedAt)
                          : "never"}{" "}
                        · next {formatDateTime(rule.nextRunAt)}
                      </Text>

                      {rule.lastError ? (
                        <Box mt="2">
                          <Flex
                            align="center"
                            gap="1.5"
                            color="danger.fg"
                            fontSize="12px"
                            fontWeight="600"
                            cursor="pointer"
                            _hover={{ textDecoration: "underline" }}
                            asChild
                          >
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedErrors((current) => ({
                                  ...current,
                                  [rule.id]: !expanded,
                                }))
                              }
                              aria-expanded={expanded}
                            >
                              <AlertTriangle
                                size={12}
                                strokeWidth={2}
                                aria-hidden
                              />
                              Last run failed
                              <ChevronDown
                                size={12}
                                aria-hidden
                                style={{
                                  transform: expanded
                                    ? "rotate(180deg)"
                                    : undefined,
                                  transition: "transform 120ms ease",
                                }}
                              />
                            </button>
                          </Flex>
                          {expanded ? (
                            <Box
                              mt="2"
                              me="4"
                              p="3"
                              bg="danger.subtle"
                              borderWidth="1px"
                              borderColor="danger.emphasized"
                              borderRadius="l2"
                            >
                              <Text
                                textStyle="data"
                                fontSize="12px"
                                color="danger.fg"
                                whiteSpace="pre-wrap"
                                wordBreak="break-word"
                              >
                                {rule.lastError}
                              </Text>
                            </Box>
                          ) : null}
                        </Box>
                      ) : null}
                    </Box>

                    <Flex gap="2" align="center" flexShrink={0}>
                      <Switch
                        size="sm"
                        checked={enabled}
                        disabled={pending !== undefined}
                        onCheckedChange={(checked) =>
                          void toggleRule(rule, checked)
                        }
                        inputProps={{
                          "aria-label": `${rule.name} — ${
                            enabled ? "enabled" : "paused"
                          }`,
                        }}
                      />
                      <Button
                        size="xs"
                        variant="outline"
                        loading={pending === "run"}
                        disabled={pending !== undefined && pending !== "run"}
                        onClick={() => void runNow(rule)}
                      >
                        <RotateCw size={12} strokeWidth={2} aria-hidden />
                        Run now
                      </Button>
                      <IconButton
                        size="xs"
                        variant="ghost"
                        colorPalette="danger"
                        aria-label={`Delete rule ${rule.name}`}
                        loading={pending === "delete"}
                        disabled={pending !== undefined && pending !== "delete"}
                        onClick={() => void deleteRule(rule)}
                      >
                        <Trash2 size={13} strokeWidth={1.75} />
                      </IconButton>
                    </Flex>
                  </Flex>
                </Box>
              );
            })}
          </Box>
        )}
      </Box>

      {/* New rule dialog — Feed → Schedule → Output */}
      <Dialog.Root
        open={dialogOpen}
        onOpenChange={(details) => {
          if (creating) return;
          setDialogOpen(details.open);
          if (!details.open) setFormError(null);
        }}
        placement="center"
        scrollBehavior="inside"
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content
              maxW="480px"
              bg="bg.panel"
              borderWidth="1px"
              borderColor="border"
              borderRadius="l3"
              boxShadow="cardHover"
            >
              <Dialog.Header
                px="6"
                pt="5"
                pb="4"
                flexDirection="column"
                alignItems="stretch"
                gap="1"
              >
                <Text textStyle="eyebrow" color="fg.subtle">
                  Automation
                </Text>
                <Dialog.Title textStyle="title" fontSize="17px" color="fg">
                  New autopilot rule
                </Dialog.Title>
              </Dialog.Header>
              <Dialog.CloseTrigger asChild>
                <CloseButton
                  size="sm"
                  position="absolute"
                  top="3"
                  insetInlineEnd="3"
                />
              </Dialog.CloseTrigger>

              <Dialog.Body px="6" py="0">
                <Stack gap="5">
                  <FieldGroup label="Feed">
                    <Field label="Rule name">
                      <Input
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        fontSize="13px"
                        size="sm"
                      />
                    </Field>
                    <Field label="RSS feed URL">
                      <Input
                        value={rssUrl}
                        onChange={(event) => setRssUrl(event.target.value)}
                        placeholder="https://feeds.example.com/podcast.xml"
                        textStyle="data"
                        fontSize="13px"
                        size="sm"
                      />
                    </Field>
                    <Field label="Title prefix (optional)">
                      <Input
                        value={titlePrefix}
                        onChange={(event) => setTitlePrefix(event.target.value)}
                        placeholder="Weekly show —"
                        fontSize="13px"
                        size="sm"
                      />
                    </Field>
                  </FieldGroup>

                  <FieldGroup label="Schedule">
                    <SimpleGrid columns={{ base: 1, sm: 2 }} gap="3">
                      <Select
                        label="Check interval"
                        items={INTERVAL_OPTIONS}
                        value={intervalMinutes}
                        onValueChange={setIntervalMinutes}
                        size="sm"
                      />
                      <Field label="Max episodes per run">
                        <NumberInput
                          value={maxEpisodesPerRun}
                          onValueChange={(value) =>
                            setMaxEpisodesPerRun(value)
                          }
                          min={1}
                          max={10}
                          size="sm"
                        />
                      </Field>
                    </SimpleGrid>
                  </FieldGroup>

                  <FieldGroup label="Output">
                    <SimpleGrid columns={{ base: 1, sm: 2 }} gap="3">
                      <Field label="Clips per episode">
                        <NumberInput
                          value={clipCountTarget}
                          onValueChange={(value) => setClipCountTarget(value)}
                          min={3}
                          max={30}
                          size="sm"
                        />
                      </Field>
                      <Flex align="end" pb="1">
                        <Switch
                          size="sm"
                          checked={autoRenderClips}
                          onCheckedChange={setAutoRenderClips}
                        >
                          Render clips after detection
                        </Switch>
                      </Flex>
                    </SimpleGrid>
                  </FieldGroup>

                  {formError ? (
                    <Flex align="center" gap="2" color="danger.fg">
                      <AlertTriangle size={13} strokeWidth={2} aria-hidden />
                      <Text fontSize="12.5px" fontWeight="500">
                        {formError}
                      </Text>
                    </Flex>
                  ) : null}
                </Stack>
              </Dialog.Body>

              <Dialog.Footer px="6" py="4" gap="2">
                <Button
                  variant="outline"
                  size="sm"
                  colorPalette="gray"
                  disabled={creating}
                  onClick={() => setDialogOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  loading={creating}
                  onClick={() => void createRule()}
                >
                  Create rule
                </Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      {confirmDialog}
    </Stack>
  );
}
