"use client";

import { useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Box, chakra, Flex, SimpleGrid, Stack, Text } from "@chakra-ui/react";
import {
  AlertTriangle,
  ChevronDown,
  Pencil,
  Plus,
  RotateCw,
  Rss,
  Trash2,
  UserCheck,
  X,
} from "lucide-react";
import { Button, IconButton } from "@narriflow/ui/components/button";
import { Dialog, Portal } from "@narriflow/ui/components/dialog";
import { useConfirm } from "@narriflow/ui/components/confirm-dialog";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { Input } from "@narriflow/ui/components/input";
import { NumberInput } from "@narriflow/ui/components/number-input";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Select } from "@narriflow/ui/components/select";
import { Switch } from "@narriflow/ui/components/switch";
import { toaster } from "@narriflow/ui/components/toaster";
import {
  type AutopilotRuleSnapshot,
  type AutopilotStatus,
  type RecipeSnapshot,
  type ZoomConnectionSnapshot,
} from "@narriflow/validators";
import { formatDateTime } from "@/lib/format";
import { SOCIAL_PLATFORM_LABELS } from "@/lib/social-post-status";
import { ZoomConnections } from "./zoom-connections";
import { describeFinishing } from "../recipes/finishing-form";

const INTERVAL_OPTIONS = [
  { label: "Every 6 hours", value: "360" },
  { label: "Every 12 hours", value: "720" },
  { label: "Daily", value: "1440" },
  { label: "Weekly", value: "10080" },
];

const INITIAL_IMPORT_OPTIONS = [
  {
    label: "Future episodes only",
    value: "future_only",
  },
  {
    label: "Import latest episodes",
    value: "latest",
  },
];

function intervalLabel(minutes: number): string {
  return (
    INTERVAL_OPTIONS.find((option) => option.value === String(minutes))?.label ??
    `Every ${minutes} min`
  );
}

/** Status voice: 3px stripe + text label — never hue alone. */
const STATUS_META: Record<
  AutopilotStatus,
  { stripe: string; label: string; color: string }
> = {
  active: { stripe: "success.solid", label: "Active", color: "success.fg" },
  running: { stripe: "accent.solid", label: "Running", color: "fg.accent" },
  paused: { stripe: "fg.subtle", label: "Paused", color: "fg.muted" },
  failed: { stripe: "danger.solid", label: "Failed", color: "danger.fg" },
};

type RuleAction = "toggle" | "run" | "delete" | "takeover";

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

/** The Recipe a rule imports with. Its settings are edited on the Recipes page. */
export function RecipeSelect({
  recipes,
  value,
  onChange,
}: {
  recipes: Array<Pick<RecipeSnapshot, "id" | "name">>;
  value: string | null;
  onChange: (id: string) => void;
}) {
  if (recipes.length === 0) {
    return (
      <Box bg="bg.subtle" borderRadius="l2" px="3" py="2.5">
        <Text fontSize="12.5px" color="fg.muted">
          Rules import with a Recipe.{" "}
          <chakra.span asChild color="fg.accent" fontWeight="600" textDecoration="underline" textUnderlineOffset="3px">
            <Link href="/recipes">Create one first</Link>
          </chakra.span>
          .
        </Text>
      </Box>
    );
  }
  return (
    <Stack gap="1.5">
      <Select
        label="Recipe"
        items={recipes.map((recipe) => ({ label: recipe.name, value: recipe.id }))}
        value={value ?? undefined}
        onValueChange={onChange}
        placeholder="Choose a Recipe"
        size="sm"
      />
      <Text fontSize="12px" color="fg.muted">
        Brand Profile, language, clip settings, and finishing come from the Recipe.{" "}
        <chakra.span asChild color="fg.accent" fontWeight="500" textDecoration="underline" textUnderlineOffset="3px">
          <Link href="/recipes">Manage Recipes</Link>
        </chakra.span>
      </Text>
    </Stack>
  );
}

function FieldGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box>
      <Text textStyle="eyebrow" color="fg.muted" mb="2.5">
        {label}
      </Text>
      <Stack gap="3">{children}</Stack>
    </Box>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <Box>
      <chakra.label
        htmlFor={htmlFor}
        display="block"
        fontSize="13px"
        fontWeight="500"
        color="fg"
        mb="1.5"
      >
        {label}
      </chakra.label>
      {children}
    </Box>
  );
}

export interface AutopilotRuleGrant {
  id: string;
  ruleId: string;
  kind: "publish" | "review_send";
  status: "active" | "paused";
  /** The account it posts to, or the reviewer count. */
  destination: string;
  expiresAt: string;
}

/** Which automation grants cover a rule, with a way to manage them. */
function RuleGrants({ ruleId, grants, canManage }: { ruleId: string; grants: AutopilotRuleGrant[]; canManage: boolean }) {
  const covering = grants.filter((grant) => grant.ruleId === ruleId);
  if (covering.length === 0 && !canManage) return null;
  return (
    <Text mt="1" fontSize="12px" color="fg.subtle">
      {covering.length > 0
        ? covering.map((grant) => `${grant.kind === "publish" ? "Posts to" : "Reviews by"} ${grant.destination}: ${grant.status === "paused" ? "paused" : `until ${formatDateTime(grant.expiresAt)}`}`).join(" · ")
        : "No automation grant: posts and review rounds wait for a person."}
      {" "}
      <Link href={canManage ? `/settings/automation-grants?rule=${ruleId}` : "/settings/automation-grants"}>
        <Text as="span" color="fg.muted" textDecoration="underline" textUnderlineOffset="3px">
          {canManage ? "Manage grants" : "View grants"}
        </Text>
      </Link>
    </Text>
  );
}

export function AutopilotPanel({
  initialRules,
  recipes,
  canTakeOver,
  finishingAvailable = true,
  grants = [],
  zoomEnabled = false,
  zoomConnections = [],
  canConnectZoom = false,
  zoomNotice,
}: {
  zoomEnabled?: boolean;
  zoomConnections?: ZoomConnectionSnapshot[];
  canConnectZoom?: boolean;
  zoomNotice?: string;
  initialRules: AutopilotRuleSnapshot[];
  recipes: RecipeSnapshot[];
  /** Workspace Owners and Admins can take over a paused rule. */
  canTakeOver: boolean;
  /** Finishing needs the Pro plan; rules below it still import and generate. */
  finishingAvailable?: boolean;
  /** The Workspace's automation grants that are in force or paused, by the rule they cover. */
  grants?: AutopilotRuleGrant[];
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
  const [sourceKind, setSourceKind] = useState<"rss" | "zoom">("rss");
  const [zoomConnectionId, setZoomConnectionId] = useState("");
  const [zoomTopicFilter, setZoomTopicFilter] = useState("");
  const [titlePrefix, setTitlePrefix] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState("1440");
  const [maxEpisodesPerRun, setMaxEpisodesPerRun] = useState("3");
  const [initialImportMode, setInitialImportMode] = useState<
    "future_only" | "latest"
  >("future_only");
  const [initialImportCount, setInitialImportCount] = useState("3");
  const [recipeId, setRecipeId] = useState<string | null>(null);
  const [editingRule, setEditingRule] = useState<AutopilotRuleSnapshot | null>(
    null,
  );

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
    setSourceKind("rss");
    setZoomConnectionId("");
    setZoomTopicFilter("");
    setTitlePrefix("");
    setIntervalMinutes("1440");
    setMaxEpisodesPerRun("3");
    setInitialImportMode("future_only");
    setInitialImportCount("3");
    setRecipeId(null);
    setFormError(null);
  }

  async function createRule() {
    if (!name.trim()) {
      setFormError("Rule name is required.");
      return;
    }
    if (sourceKind === "rss" && !rssUrl.trim()) {
      setFormError("RSS feed URL is required.");
      return;
    }
    if (!recipeId) {
      setFormError("Choose a Recipe for this rule.");
      return;
    }
    if (sourceKind === "zoom" && !zoomConnectionId) { setFormError("Choose a Zoom connection."); return; }
    const maxEpisodes = Number(maxEpisodesPerRun);
    const initialCount = Number(initialImportCount);
    if (!Number.isInteger(maxEpisodes) || maxEpisodes < 1 || maxEpisodes > 10) {
      setFormError("Max episodes must be between 1 and 10.");
      return;
    }
    if (!Number.isInteger(initialCount) || initialCount < 1 || initialCount > 10) {
      setFormError("Initial episode count must be between 1 and 10.");
      return;
    }

    setFormError(null);
    setCreating(true);
    const error = await request("/api/autopilot/rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        sourceKind,
        ...(sourceKind === "rss" ? { rssUrl: rssUrl.trim() } : { zoomConnectionId, zoomTopicFilter: zoomTopicFilter.trim() || null }),
        titlePrefix: titlePrefix.trim() || null,
        recipeId,
        intervalMinutes: Number(intervalMinutes),
        maxEpisodesPerRun: maxEpisodes,
        initialImportMode: sourceKind === "zoom" ? "future_only" : initialImportMode,
        initialImportCount: initialCount,
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
      description:
        sourceKind === "zoom" ? "Future cloud recordings will be clipped when Zoom finishes processing them." : initialImportMode === "future_only"
          ? "The feed baseline is saved; only future episodes will be clipped."
          : `The latest ${initialCount} episode${initialCount === 1 ? "" : "s"} will be queued first.`,
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

  async function takeOver(rule: AutopilotRuleSnapshot) {
    setRulePending(rule.id, "takeover");
    const error = await request(`/api/autopilot/rules/${rule.id}/take-over`, {
      method: "POST",
    });
    setRulePending(rule.id, undefined);
    if (error) {
      toaster.create({
        type: "error",
        title: "Could not take over rule",
        description: error,
      });
      return;
    }
    toaster.create({
      type: "success",
      title: "You now run this rule",
      description: `${rule.name} will check its feed shortly.`,
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
          title="Autopilot"
          actions={
            <Button onClick={() => setDialogOpen(true)}>
              <Plus size={15} strokeWidth={2} aria-hidden />
              New rule
            </Button>
          }
        />
      </Box>

      {zoomEnabled ? <ZoomConnections connections={zoomConnections} canConnect={canConnectZoom} notice={zoomNotice} /> : null}

      <Box
        as="section"
        animation="fade-up"
        animationDelay="80ms"
        animationFillMode="backwards"
      >
        {initialRules.length === 0 ? (
          <EmptyState
            icon={<Rss size={20} strokeWidth={1.75} />}
            title="No autopilot rules yet"
            description={zoomEnabled ? "Add an RSS feed or Zoom connection to clip new recordings automatically." : "Add an RSS feed to clip new episodes automatically."}
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
        ) : (
          <Box display="grid" gap="3">
            {initialRules.map((rule) => {
              // A paused rule with an error was stopped by Autopilot itself.
              const pauseReason = rule.status === "paused" ? rule.lastError : null;
              const meta = pauseReason
                ? { stripe: "warning.solid", label: "Paused", color: "warning.fg" }
                : STATUS_META[rule.status];
              const recipe = recipes.find((entry) => entry.id === rule.recipeId);
              const pending = pendingRules[rule.id];
              const enabled = rule.status !== "paused";
              const expanded = Boolean(expandedErrors[rule.id]);

              return (
                <Box
                  key={rule.id}
                  position="relative"
                  borderRadius="l3"
                  borderWidth="1px"
                  borderColor="border.card"
                  bg="bg.panel"
                  px="4"
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
                          fontSize="12px"
                          fontWeight="500"
                          color={meta.color}
                          flexShrink={0}
                        >
                          {meta.label}
                        </Text>
                      </Flex>
                      <Text fontSize="13px" color="fg.muted" truncate mt="1">
                        {rule.sourceKind === "zoom" ? `Zoom: ${zoomConnections.find((entry) => entry.id === rule.zoomConnectionId)?.displayName ?? "connected member"}${rule.zoomTopicFilter ? ` • Topics containing “${rule.zoomTopicFilter}”` : ""}` : `${rule.feedTitle ? `${rule.feedTitle} · ` : ""}${rule.rssUrl}`}
                      </Text>
                      <Text
                        mt="1.5"
                        fontSize="12px"
                        color="fg.subtle"
                        fontVariantNumeric="tabular-nums"
                      >
                        {rule.sourceKind === "zoom" ? "When a recording completes" : intervalLabel(rule.intervalMinutes)} ·{" "}
                        {rule.importedEpisodeCount} imported · last{" "}
                        {rule.lastSuccessAt
                          ? `healthy ${formatDateTime(rule.lastSuccessAt)}`
                          : rule.lastCheckedAt
                          ? formatDateTime(rule.lastCheckedAt)
                          : "never"}{" "}
                        {rule.sourceKind === "rss" ? ` · next ${formatDateTime(rule.nextRunAt)}` : ""}
                        {` · Recipe: ${rule.recipeName}`}
                      </Text>

                      {recipe?.finishing ? (
                        <Text mt="1" fontSize="12px" color={finishingAvailable ? "fg.subtle" : "warning.fg"}>
                          {finishingAvailable
                            ? `Finishing: ${describeFinishing(recipe.finishing, (platform) => SOCIAL_PLATFORM_LABELS[platform])}`
                            : "Finishing is off: it needs the Pro plan. New episodes still import and generate clips."}
                        </Text>
                      ) : null}

                      <RuleGrants ruleId={rule.id} grants={grants} canManage={canTakeOver} />

                      {pauseReason ? (
                        <Box mt="2" me="4" p="3" bg="warning.subtle" borderRadius="l2">
                          <Text
                            fontSize="12px"
                            color="warning.fg"
                            whiteSpace="pre-wrap"
                            wordBreak="break-word"
                          >
                            {pauseReason}
                          </Text>
                          {canTakeOver && rule.pauseKind === "acting_member" ? (
                            <Button
                              mt="2.5"
                              size="xs"
                              variant="subtle"
                              loading={pending === "takeover"}
                              disabled={pending !== undefined && pending !== "takeover"}
                              onClick={() => void takeOver(rule)}
                            >
                              <UserCheck size={12} strokeWidth={2} aria-hidden />
                              Take over
                            </Button>
                          ) : null}
                        </Box>
                      ) : rule.lastError ? (
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
                              {rule.consecutiveFailures > 0
                                ? ` · attempt ${rule.consecutiveFailures}`
                                : ""}
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
                              borderRadius="l2"
                            >
                              <Text
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
                      {rule.sourceKind === "rss" ? <Button
                        size="sm"
                        variant="subtle"
                        loading={pending === "run"}
                        disabled={pending !== undefined && pending !== "run"}
                        onClick={() => void runNow(rule)}
                      >
                        <RotateCw size={12} strokeWidth={2} aria-hidden />
                        Run now
                      </Button> : null}
                      <IconButton
                        size="xs"
                        variant="ghost"
                        aria-label={`Edit rule ${rule.name}`}
                        disabled={pending !== undefined}
                        onClick={() => setEditingRule(rule)}
                      >
                        <Pencil size={13} strokeWidth={1.75} />
                      </IconButton>
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
            >
              <Dialog.Header
                px="6"
                pt="5"
                pb="4"
                flexDirection="column"
                alignItems="stretch"
                gap="1"
              >
                <Dialog.Title textStyle="title" fontSize="18px" color="fg">
                  New autopilot rule
                </Dialog.Title>
              </Dialog.Header>
              <Dialog.CloseTrigger asChild>
                <IconButton
                  aria-label="Close"
                  size="sm"
                  variant="ghost"
                  borderRadius="full"
                  position="absolute"
                  top="3"
                  insetInlineEnd="3"
                >
                  <X size={16} />
                </IconButton>
              </Dialog.CloseTrigger>

              <Dialog.Body px="6" py="0">
                <Stack gap="5">
                  <FieldGroup label="Source">
                    {zoomEnabled ? <Select label="Import from" items={[{ label: "RSS feed", value: "rss" }, { label: "Zoom cloud recordings", value: "zoom" }]} value={sourceKind} onValueChange={(value) => { setSourceKind(value as "rss" | "zoom"); if (name === "Podcast autopilot" || name === "Zoom autopilot") setName(value === "zoom" ? "Zoom autopilot" : "Podcast autopilot"); }} size="sm" /> : null}
                    <Field label="Rule name" htmlFor="autopilot-rule-name">
                      <Input
                        id="autopilot-rule-name"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        fontSize="13px"
                        size="sm"
                      />
                    </Field>
                    {sourceKind === "rss" ? <Field label="RSS feed URL" htmlFor="autopilot-rss-url">
                      <Input
                        id="autopilot-rss-url"
                        value={rssUrl}
                        onChange={(event) => setRssUrl(event.target.value)}
                        placeholder="https://feeds.example.com/podcast.xml"
                        fontSize="13px"
                        size="sm"
                      />
                    </Field> : <Stack gap="3">
                      <Select label="Zoom connection" items={zoomConnections.filter((entry) => !entry.revoked).map((entry) => ({ label: entry.displayName, value: entry.id }))} value={zoomConnectionId || undefined} onValueChange={setZoomConnectionId} placeholder="Choose a connected member" size="sm" />
                      <Field label="Topic contains (optional)" htmlFor="autopilot-zoom-topic"><Input id="autopilot-zoom-topic" value={zoomTopicFilter} onChange={(event) => setZoomTopicFilter(event.target.value)} maxLength={200} size="sm" /></Field>
                      <Text fontSize="12px" color="fg.muted">Watches future cloud recordings hosted by this Zoom user. Topic matching ignores letter case. Shared screen with speaker view is preferred.</Text>
                    </Stack>}
                    <Field
                      label="Title prefix (optional)"
                      htmlFor="autopilot-title-prefix"
                    >
                      <Input
                        id="autopilot-title-prefix"
                        value={titlePrefix}
                        onChange={(event) => setTitlePrefix(event.target.value)}
                        placeholder="Weekly show —"
                        fontSize="13px"
                        size="sm"
                      />
                    </Field>
                  </FieldGroup>

                  {sourceKind === "rss" ? <FieldGroup label="Schedule">
                    <SimpleGrid columns={{ base: 1, sm: 2 }} gap="3">
                      <Select
                        label="Check interval"
                        items={INTERVAL_OPTIONS}
                        value={intervalMinutes}
                        onValueChange={setIntervalMinutes}
                        size="sm"
                      />
                      <Field
                        label="Max episodes per run"
                        htmlFor="autopilot-max-episodes"
                      >
                        <NumberInput
                          value={maxEpisodesPerRun}
                          onValueChange={(value) =>
                            setMaxEpisodesPerRun(value)
                          }
                          min={1}
                          max={10}
                          size="sm"
                          inputProps={{ id: "autopilot-max-episodes" }}
                        />
                      </Field>
                    </SimpleGrid>
                    <SimpleGrid columns={{ base: 1, sm: 2 }} gap="3">
                      <Select
                        label="Existing episodes"
                        items={INITIAL_IMPORT_OPTIONS}
                        value={initialImportMode}
                        onValueChange={(value) =>
                          setInitialImportMode(value as "future_only" | "latest")
                        }
                        size="sm"
                      />
                      {initialImportMode === "latest" ? (
                        <Field
                          label="Initial episodes"
                          htmlFor="autopilot-initial-episodes"
                        >
                          <NumberInput
                            value={initialImportCount}
                            onValueChange={setInitialImportCount}
                            min={1}
                            max={10}
                            size="sm"
                            inputProps={{ id: "autopilot-initial-episodes" }}
                          />
                        </Field>
                      ) : (
                        <Flex align="end" pb="2">
                          <Text fontSize="12px" color="fg.muted">
                            Current episodes establish the baseline and are not imported.
                          </Text>
                        </Flex>
                      )}
                    </SimpleGrid>
                  </FieldGroup> : null}

                  <FieldGroup label="Output">
                    <RecipeSelect recipes={recipes} value={recipeId} onChange={setRecipeId} />
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
                <Dialog.ActionTrigger asChild>
                  <Button variant="subtle" size="sm" disabled={creating}>
                    Cancel
                  </Button>
                </Dialog.ActionTrigger>
                <Button
                  size="sm"
                  loading={creating}
                  disabled={recipes.length === 0}
                  onClick={() => void createRule()}
                >
                  Create rule
                </Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      <EditRuleDialog
        key={editingRule?.id ?? "closed"}
        rule={editingRule}
        recipes={recipes}
        zoomConnections={zoomConnections}
        onClose={() => setEditingRule(null)}
        onSaved={() => {
          setEditingRule(null);
          startTransition(() => router.refresh());
        }}
      />

      {confirmDialog}
    </Stack>
  );
}

function EditRuleDialog({
  rule,
  recipes,
  zoomConnections,
  onClose,
  onSaved,
}: {
  rule: AutopilotRuleSnapshot | null;
  recipes: RecipeSnapshot[];
  zoomConnections: ZoomConnectionSnapshot[];
  onClose: () => void;
  onSaved: () => void;
}) {
  // The parent keys this dialog by rule, so every open starts a fresh draft.
  const [name, setName] = useState(rule?.name ?? "");
  const [recipeId, setRecipeId] = useState<string | null>(rule?.recipeId ?? null);
  const [connectionId, setConnectionId] = useState(rule?.zoomConnectionId ?? "");
  const [topicFilter, setTopicFilter] = useState(rule?.zoomTopicFilter ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!rule) return;
    if (!name.trim()) {
      setError("Rule name is required.");
      return;
    }
    // Send only what changed: a rule whose Recipe's profile is gone can still
    // be renamed, and choosing a Recipe resumes a rule paused over its profile.
    const changes = {
      ...(name.trim() !== rule.name && { name: name.trim() }),
      ...(recipeId && recipeId !== rule.recipeId && { recipeId }),
      ...(rule.sourceKind === "zoom" && connectionId && connectionId !== rule.zoomConnectionId && { zoomConnectionId: connectionId }),
      ...(rule.sourceKind === "zoom" && (topicFilter.trim() || null) !== rule.zoomTopicFilter && { zoomTopicFilter: topicFilter.trim() || null }),
    };
    if (Object.keys(changes).length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    const failure = await request(`/api/autopilot/rules/${rule.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(changes),
    });
    setSaving(false);
    if (failure) {
      setError(failure);
      return;
    }
    toaster.create({ type: "success", title: "Rule updated", description: name.trim() });
    onSaved();
  }

  return (
    <Dialog.Root
      open={rule !== null}
      onOpenChange={(details) => {
        if (saving || details.open) return;
        onClose();
      }}
      placement="center"
      scrollBehavior="inside"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content maxW="480px">
            <Dialog.Header px="6" pt="5" pb="4">
              <Dialog.Title textStyle="title" fontSize="18px" color="fg">
                Edit autopilot rule
              </Dialog.Title>
            </Dialog.Header>
            <Dialog.CloseTrigger asChild>
              <IconButton
                aria-label="Close"
                size="sm"
                variant="ghost"
                borderRadius="full"
                position="absolute"
                top="3"
                insetInlineEnd="3"
              >
                <X size={16} />
              </IconButton>
            </Dialog.CloseTrigger>
            <Dialog.Body px="6" py="0">
              <Stack gap="4">
                <Field label="Rule name" htmlFor="autopilot-edit-name">
                  <Input
                    id="autopilot-edit-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    fontSize="13px"
                    size="sm"
                  />
                </Field>
                <RecipeSelect recipes={recipes} value={recipeId} onChange={setRecipeId} />
                {rule?.sourceKind === "zoom" ? <Stack gap="3">
                  <Select label="Zoom connection" items={zoomConnections.filter((entry) => !entry.revoked).map((entry) => ({ label: entry.displayName, value: entry.id }))} value={connectionId || undefined} onValueChange={setConnectionId} size="sm" />
                  <Field label="Topic contains (optional)" htmlFor="autopilot-edit-zoom-topic"><Input id="autopilot-edit-zoom-topic" value={topicFilter} onChange={(event) => setTopicFilter(event.target.value)} maxLength={200} size="sm" /></Field>
                </Stack> : null}
                {error ? (
                  <Flex align="center" gap="2" color="danger.fg">
                    <AlertTriangle size={13} strokeWidth={2} aria-hidden />
                    <Text fontSize="12.5px" fontWeight="500">
                      {error}
                    </Text>
                  </Flex>
                ) : null}
              </Stack>
            </Dialog.Body>
            <Dialog.Footer px="6" py="4" gap="2">
              <Dialog.ActionTrigger asChild>
                <Button variant="subtle" size="sm" disabled={saving}>
                  Cancel
                </Button>
              </Dialog.ActionTrigger>
              <Button size="sm" loading={saving} onClick={() => void save()}>
                Save
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
