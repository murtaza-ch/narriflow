"use client";

import { useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import type { AutomationActions } from "@narriflow/api-client/automation";
import { isApiError, type Intent } from "@narriflow/api-client/core";
import { useMutation } from "@tanstack/react-query";
import { PlanLimitNotice } from "../_components/plan-limit-notice";
import { LockedButton, UpgradeHero, useUpgrade, type UpgradePrompt } from "../_components/upgrade";
import { AutopilotVisual } from "../_components/upgrade-visuals";
import { FeatureHero } from "../_components/feature-hero";
import { lowestTierWithFeature, planUpgradeHighlight, type PricingTier, type WorkspaceAccessStatus } from "@narriflow/validators";
import { Box, chakra, Flex, SimpleGrid, Stack, Text } from "@chakra-ui/react";
import {
  AlertTriangle,
  ArrowRight,
  BookMarked,
  CalendarClock,
  Check,
  ChevronDown,
  Download,
  History,
  Pencil,
  Plus,
  RotateCw,
  Rss,
  Sparkles,
  Timer,
  Trash2,
  UserCheck,
  Video,
  X,
} from "lucide-react";
import { Button, IconButton } from "@narriflow/ui/components/button";
import { Dialog, Portal } from "@narriflow/ui/components/dialog";
import { useConfirm } from "@narriflow/ui/components/confirm-dialog";
import { Input } from "@narriflow/ui/components/input";
import { NumberInput } from "@narriflow/ui/components/number-input";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Select } from "@narriflow/ui/components/select";
import { SegmentedControl } from "@narriflow/ui/components/segmented-control";
import { Slider } from "@narriflow/ui/components/slider";
import { Switch } from "@narriflow/ui/components/switch";
import { toaster } from "@narriflow/ui/components/toaster";
import {
  type AutopilotRuleSnapshot,
  type AutopilotStatus,
  type RecipeSnapshot,
  type ZoomConnectionSnapshot,
} from "@narriflow/validators";
import type { AutopilotRuleInput, AutopilotRuleUpdate } from "@narriflow/validators/api/automation";
import { formatDateTime } from "@/lib/format";
import { SOCIAL_PLATFORM_LABELS } from "@/lib/social-post-status";
import { useConnectZoom, ZoomConnections } from "./zoom-connections";
import { describeFinishing } from "../recipes/finishing-form";

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

function failureMessage(error: unknown): string {
  if (isApiError(error)) return error.code === "network_error" ? "Network error — please try again." : error.message;
  return error instanceof Error && error.message ? error.message : "Request failed";
}

/** Runs one command; `null` on success, the message to show otherwise. */
async function attempt(task: () => Promise<unknown>): Promise<string | null> {
  try {
    await task();
    return null;
  } catch (error) {
    return failureMessage(error);
  }
}

/** What the panel needs to change rules and connections: the commands, one idempotency intent per create or run-now, and the cache refresh. */
export interface AutopilotPanelApi {
  actions: AutomationActions;
  createIntent<TInput>(): Intent<TInput>;
  /** Refreshes what a changed rule, grant or Zoom connection touches. */
  changed(): Promise<void>;
}

/** The Recipe a rule imports with, as a list of choice cards. Its settings are edited on the Recipes page. */
export function RecipeSelect({
  recipes,
  value,
  onChange,
}: {
  recipes: Array<Pick<RecipeSnapshot, "id" | "name"> & Partial<Pick<RecipeSnapshot, "contentPack">>>;
  value: string | null;
  onChange: (id: string) => void;
}) {
  if (recipes.length === 0) {
    return (
      <Flex align="center" gap="3" bg="bg.soft" borderRadius="l2" px="3.5" py="3">
        <Flex boxSize="8" flexShrink={0} align="center" justify="center" borderRadius="8px" bg="bg.soft" color="fg.muted">
          <BookMarked size={15} />
        </Flex>
        <Text fontSize="13px" color="fg.muted">
          Rules import with a Recipe.{" "}
          <chakra.span asChild color="fg.accent" fontWeight="600" textDecoration="underline" textUnderlineOffset="3px">
            <Link href="/recipes">Create one first</Link>
          </chakra.span>
          .
        </Text>
      </Flex>
    );
  }
  return (
    <Stack gap="2">
      <Stack role="radiogroup" aria-label="Recipe" gap="1.5" maxH="216px" overflowY="auto" mx="-1" px="1" py="1">
        {recipes.map((recipe) => (
          <ChoiceCard
            key={recipe.id}
            selected={value === recipe.id}
            onSelect={() => onChange(recipe.id)}
            icon={<BookMarked size={15} />}
            title={recipe.name}
            description={recipe.contentPack ? `${recipe.contentPack.clipCountTarget} clips · ${recipe.contentPack.defaultAspectRatio}` : undefined}
          />
        ))}
      </Stack>
      <Text fontSize="12px" color="fg.muted">
        {value ? "" : "Choose a Recipe. "}
        Brand Profile, language, clip settings, and finishing come from the Recipe.{" "}
        <chakra.span asChild color="fg.accent" fontWeight="500" textDecoration="underline" textUnderlineOffset="3px">
          <Link href="/recipes">Manage Recipes</Link>
        </chakra.span>
      </Text>
    </Stack>
  );
}

/** One option in a set, as a soft card: the chosen one gets the accent tint and a check. */
function ChoiceCard({
  selected,
  onSelect,
  icon,
  title,
  description,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: ReactNode;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <chakra.div
      role="radio"
      aria-checked={selected}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          onSelect();
        }
      }}
      display="flex"
      alignItems="flex-start"
      gap="3"
      px="3.5"
      py="3"
      borderRadius="l2"
      cursor="pointer"
      bg={selected ? "accent.subtle" : "bg.soft"}
      outline="1.5px solid"
      outlineColor={selected ? "accent.solid" : "transparent"}
      outlineOffset="-1.5px"
      transition="background 120ms ease, outline-color 120ms ease"
      _hover={{ bg: selected ? "accent.subtle" : "bg.softHover" }}
      _focusVisible={{ outlineColor: "accent.solid" }}
      textAlign="left"
      minW="0"
    >
      <Flex boxSize="8" flexShrink={0} align="center" justify="center" borderRadius="8px" bg={selected ? "accent.muted" : "bg.soft"} color={selected ? "accent.fg" : "fg.muted"}>
        {icon}
      </Flex>
      <Stack gap="0.5" flex="1" minW="0" pt="0.5">
        <Text fontSize="13.5px" fontWeight="500" color="fg" truncate>
          {title}
        </Text>
        {description ? (
          <Text fontSize="12px" color="fg.muted">
            {description}
          </Text>
        ) : null}
        {children}
      </Stack>
      <Flex boxSize="4.5" mt="1.5" flexShrink={0} align="center" justify="center" borderRadius="full" bg={selected ? "accent.solid" : "transparent"} borderWidth={selected ? "0" : "1.5px"} borderColor="border.emphasized" color="accent.contrast">
        {selected ? <Check size={11} strokeWidth={3} /> : null}
      </Flex>
    </chakra.div>
  );
}

/** One fact about a rule as a soft chip. */
function RuleChip({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <Flex align="center" gap="1.5" h="7" px="2.5" borderRadius="8px" bg="bg.soft" fontSize="12px" color="fg.muted" fontVariantNumeric="tabular-nums" maxW="full">
      <Flex flexShrink={0}>{icon}</Flex>
      <Text as="span" truncate>{children}</Text>
    </Flex>
  );
}

/** A numbered step of the new-rule form. */
function Step({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return (
    <Stack as="section" gap="3.5">
      <Flex align="center" gap="2.5">
        <Flex boxSize="6" borderRadius="full" bg="bg.soft" color="fg" align="center" justify="center" fontSize="12px" fontWeight="600" fontVariantNumeric="tabular-nums">
          {number}
        </Flex>
        <Text as="h3" fontSize="14px" fontWeight="500" color="fg">
          {title}
        </Text>
      </Flex>
      <Stack gap="3.5" ps={{ base: "0", sm: "8.5" }}>{children}</Stack>
    </Stack>
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
  api,
  rules,
  recipes,
  canTakeOver,
  finishingAvailable = true,
  grants = [],
  zoomEnabled = false,
  zoomConnections = [],
  canConnectZoom = false,
  zoomNotice,
  newRuleRequirement = null,
  newRuleUpgradeTier = null,
  autopilotIncluded = true,
  canManageBilling = false,
  canEdit = true,
  canRun = true,
  workspaceStatus = "active",
}: {
  api: AutopilotPanelApi;
  /** Editors and up in an active Workspace create, change, pause and delete rules. */
  canEdit?: boolean;
  /** Running a rule now spends processing. */
  canRun?: boolean;
  workspaceStatus?: WorkspaceAccessStatus;
  /** Why the plan can't add another active rule, computed server-side; `null` when it can. */
  newRuleRequirement?: string | null;
  /** The cheapest plan that allows another active rule; `null` on the top plan. */
  newRuleUpgradeTier?: PricingTier | null;
  /** Whether the plan includes Autopilot at all; when it doesn't, the page leads with an upgrade banner. */
  autopilotIncluded?: boolean;
  canManageBilling?: boolean;
  zoomEnabled?: boolean;
  zoomConnections?: ZoomConnectionSnapshot[];
  canConnectZoom?: boolean;
  zoomNotice?: string;
  rules: AutopilotRuleSnapshot[];
  recipes: RecipeSnapshot[];
  /** Workspace Owners and Admins can take over a paused rule. */
  canTakeOver: boolean;
  /** Finishing needs the Pro plan; rules below it still import and generate. */
  finishingAvailable?: boolean;
  /** The Workspace's automation grants that are in force or paused, by the rule they cover. */
  grants?: AutopilotRuleGrant[];
}) {
  const autopilotTier = lowestTierWithFeature("automation.autopilot");
  const { confirm, dialog: confirmDialog } = useConfirm();
  const { openUpgrade } = useUpgrade();
  // Turning a rule on takes a slot, exactly like a new rule.
  const slotUpgrade: UpgradePrompt | null =
    newRuleRequirement && newRuleUpgradeTier
      ? {
          tier: newRuleUpgradeTier,
          headline: autopilotIncluded ? "Upgrade to run more Autopilot rules" : "Upgrade to turn on Autopilot",
          highlight: planUpgradeHighlight(newRuleUpgradeTier, "autopilotRules"),
          canManageBilling,
        }
      : null;
  const liveZoomConnections = zoomConnections.filter((entry) => !entry.revoked);
  const zoom = useConnectZoom(api.actions);

  // One idempotency key per new-rule form and per run-now click, kept through a failed or lost
  // attempt so a retry replays the first acceptance instead of creating or queueing twice.
  const [createIntent] = useState(() => api.createIntent<AutopilotRuleInput>());
  const runIntents = useRef(new Map<string, Intent<string>>());
  const create = useMutation({
    mutationFn: (input: AutopilotRuleInput) => api.actions.createRule(input, createIntent.keyFor(input)),
    onSuccess: async () => {
      createIntent.complete();
      await api.changed();
    },
  });
  const toggle = useMutation({
    mutationFn: ({ rule, enabled }: { rule: AutopilotRuleSnapshot; enabled: boolean }) =>
      api.actions.updateRule(rule.id, { status: enabled ? "active" : "paused" }),
    onSuccess: () => api.changed(),
  });
  const takeOverRule = useMutation({
    mutationFn: (rule: AutopilotRuleSnapshot) => api.actions.takeOverRule(rule.id),
    onSuccess: () => api.changed(),
  });
  const runRuleNow = useMutation({
    mutationFn: (rule: AutopilotRuleSnapshot) => {
      const intent = runIntents.current.get(rule.id) ?? api.createIntent<string>();
      runIntents.current.set(rule.id, intent);
      return api.actions.runRuleNow(rule.id, intent.keyFor(rule.id));
    },
    onSuccess: async (_run, rule) => {
      runIntents.current.delete(rule.id);
      await api.changed();
    },
  });
  const removeRule = useMutation({
    mutationFn: (rule: AutopilotRuleSnapshot) => api.actions.deleteRule(rule.id),
    onSuccess: () => api.changed(),
  });

  /** Explains a resume or run the plan has no slot for, instead of letting it fail. */
  function refuseForSlot(): boolean {
    if (!newRuleRequirement) return false;
    if (slotUpgrade) openUpgrade(slotUpgrade);
    else toaster.create({ type: "info", title: "No free Autopilot slot", description: `${newRuleRequirement} Pause or delete a rule to make room.` });
    return true;
  }

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
    const input: AutopilotRuleInput = {
      name: name.trim(),
      sourceKind,
      ...(sourceKind === "rss" ? { rssUrl: rssUrl.trim() } : { zoomConnectionId, zoomTopicFilter: zoomTopicFilter.trim() || null }),
      titlePrefix: titlePrefix.trim() || null,
      recipeId,
      intervalMinutes: Number(intervalMinutes),
      maxEpisodesPerRun: maxEpisodes,
      initialImportMode: sourceKind === "zoom" ? "future_only" : initialImportMode,
      initialImportCount: initialCount,
    };
    const error = await attempt(() => create.mutateAsync(input));
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
  }

  async function toggleRule(rule: AutopilotRuleSnapshot, enabled: boolean) {
    if (enabled && refuseForSlot()) return;
    setRulePending(rule.id, "toggle");
    const error = await attempt(() => toggle.mutateAsync({ rule, enabled }));
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
  }

  async function takeOver(rule: AutopilotRuleSnapshot) {
    // Taking over resumes the paused rule, so it needs a slot too.
    if (refuseForSlot()) return;
    setRulePending(rule.id, "takeover");
    const error = await attempt(() => takeOverRule.mutateAsync(rule));
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
  }

  async function runNow(rule: AutopilotRuleSnapshot) {
    // Running turns a paused rule back on; with no Autopilot at all, nothing runs.
    if ((!autopilotIncluded || rule.status === "paused" || rule.status === "failed") && refuseForSlot()) return;
    setRulePending(rule.id, "run");
    const error = await attempt(() => runRuleNow.mutateAsync(rule));
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
    const error = await attempt(() => removeRule.mutateAsync(rule));
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
  }

  return (
    <Stack gap="8">
      <Box animation="fade-up" animationFillMode="backwards">
        <PageHeader
          title="Autopilot"
          description={zoomEnabled ? "New episodes and Zoom recordings become clips on their own." : "New episodes become clips on their own."}
          actions={
            !canEdit ? undefined : slotUpgrade ? (
              <LockedButton prompt={slotUpgrade}>
                <Plus size={15} strokeWidth={2} aria-hidden />
                New rule
              </LockedButton>
            ) : (
              <Button onClick={() => setDialogOpen(true)} disabled={newRuleRequirement !== null}>
                <Plus size={15} strokeWidth={2} aria-hidden />
                New rule
              </Button>
            )
          }
        />
        {/* No plan raises this ceiling: explain how to make room instead of offering an upgrade. */}
        {!canEdit || newRuleUpgradeTier || !newRuleRequirement ? null : (
          <PlanLimitNotice message={`${newRuleRequirement} Pause or delete a rule to create another.`} upgrade={null} />
        )}
      </Box>


      {!autopilotIncluded ? (
        <UpgradeHero
          title="Clip new episodes automatically"
          points={[zoomEnabled ? "Watch an RSS feed or Zoom account for new recordings." : "Watch an RSS feed for new episodes.", "Every new recording becomes captioned clips, ready to schedule."]}
          ctaLabel="Upgrade to turn on Autopilot"
          visual={<AutopilotVisual />}
          prompt={{
            tier: autopilotTier,
            headline: "Upgrade to turn on Autopilot",
            highlight: autopilotTier ? planUpgradeHighlight(autopilotTier, "autopilotRules") : undefined,
            canManageBilling,
          }}
        />
      ) : null}

      {zoomEnabled ? <ZoomConnections
          api={api}
          connections={zoomConnections}
          canConnect={canConnectZoom}
          askToConnect={!canConnectZoom && workspaceStatus === "active"}
          // Connecting needs the plan that runs the rules it feeds; the server refuses it otherwise.
          connectUpgrade={autopilotIncluded ? null : {
            tier: autopilotTier,
            headline: "Upgrade to clip Zoom recordings",
            highlight: autopilotTier ? planUpgradeHighlight(autopilotTier, "automation.autopilot") : undefined,
            canManageBilling,
          }}
          notice={zoomNotice}
        /> : null}

      <Box
        as="section"
        animation="fade-up"
        animationDelay="80ms"
        animationFillMode="backwards"
      >
        {rules.length === 0 && !autopilotIncluded ? null : rules.length === 0 ? (
          <FeatureHero
            title="No autopilot rules yet"
            points={[
              zoomEnabled ? "Watch an RSS feed or a Zoom account for new recordings." : "Watch an RSS feed for new episodes.",
              "Each new one becomes captioned clips with a Recipe's settings.",
              recipes.length > 0
                ? `Pick one of your ${recipes.length} ${recipes.length === 1 ? "Recipe" : "Recipes"} when you create the rule.`
                : "Rules import with a Recipe, so create one first.",
            ]}
            visual={<AutopilotVisual />}
            action={
              !canEdit ? undefined : recipes.length === 0 ? (
                <Button asChild size="sm">
                  <Link href="/recipes">
                    Create a Recipe <ArrowRight size={14} aria-hidden />
                  </Link>
                </Button>
              ) : (
                <Button size="sm" onClick={() => setDialogOpen(true)} disabled={newRuleRequirement !== null}>
                  <Plus size={15} strokeWidth={2} aria-hidden />
                  Create your first rule
                </Button>
              )
            }
          />
        ) : (
          <Box display="grid" gap="2.5">
            {rules.map((rule) => {
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
                <Box key={rule.id} borderRadius="l3" bg="bg.subtle" p="4" ps="5">
                  <Flex gap="4" align="flex-start" wrap="wrap">
                    {/* The source, marked with the rule's status. */}
                    <Box position="relative" flexShrink={0}>
                      <Flex boxSize="11" borderRadius="12px" bg="bg.soft" color="fg" align="center" justify="center" aria-hidden>
                        {rule.sourceKind === "zoom" ? <Video size={18} /> : <Rss size={18} />}
                      </Flex>
                      <Box position="absolute" right="-0.5" bottom="-0.5" boxSize="3" borderRadius="full" bg={meta.stripe} boxShadow="0 0 0 2px var(--chakra-colors-bg-subtle)" aria-hidden />
                    </Box>
                    <Box minW="0" flex="1">
                      <Flex align="center" gap="2.5" minW="0">
                        <Text
                          fontSize="15px"
                          fontWeight="500"
                          color="fg"
                          truncate
                        >
                          {rule.name}
                        </Text>
                        <Flex align="center" gap="1.5" h="6" px="2" borderRadius="full" bg="bg.soft" flexShrink={0}>
                          <Box boxSize="1.5" borderRadius="full" bg={meta.stripe} />
                          <Text fontSize="11.5px" fontWeight="500" color={meta.color}>
                            {meta.label}
                          </Text>
                        </Flex>
                      </Flex>
                      <Text fontSize="13px" color="fg.muted" truncate mt="1">
                        {rule.sourceKind === "zoom" ? `Zoom: ${zoomConnections.find((entry) => entry.id === rule.zoomConnectionId)?.displayName ?? "connected member"}${rule.zoomTopicFilter ? ` • Topics containing “${rule.zoomTopicFilter}”` : ""}` : `${rule.feedTitle ? `${rule.feedTitle} · ` : ""}${rule.rssUrl}`}
                      </Text>
                      <Flex mt="3" gap="1.5" wrap="wrap">
                        <RuleChip icon={<Timer size={12} />}>{rule.sourceKind === "zoom" ? "When a recording completes" : intervalLabel(rule.intervalMinutes)}</RuleChip>
                        <RuleChip icon={<Download size={12} />}>{`${rule.importedEpisodeCount} imported`}</RuleChip>
                        <RuleChip icon={<Check size={12} />}>
                          {`last ${rule.lastSuccessAt ? `healthy ${formatDateTime(rule.lastSuccessAt)}` : rule.lastCheckedAt ? formatDateTime(rule.lastCheckedAt) : "never"}`}
                        </RuleChip>
                        {rule.sourceKind === "rss" ? <RuleChip icon={<CalendarClock size={12} />}>{`next ${formatDateTime(rule.nextRunAt)}`}</RuleChip> : null}
                        <RuleChip icon={<BookMarked size={12} />}>{`Recipe: ${rule.recipeName}`}</RuleChip>
                      </Flex>

                      {recipe?.finishing ? (
                        <Flex mt="3" gap="2.5" align="flex-start" px="3" py="2.5" borderRadius="l2" bg={finishingAvailable ? "accent.subtle" : "upgrade.subtle"}>
                          <Box mt="0.5" color={finishingAvailable ? "accent.fg" : "upgrade.fg"} flexShrink={0}>
                            <Sparkles size={13} />
                          </Box>
                          <Text fontSize="12.5px" color={finishingAvailable ? "fg" : "upgrade.fg"} lineHeight="1.45">
                            {finishingAvailable
                              ? `Finishing: ${describeFinishing(recipe.finishing, (platform) => SOCIAL_PLATFORM_LABELS[platform])}`
                              : "Finishing is off: it needs the Pro plan. New episodes still import and generate clips."}
                          </Text>
                        </Flex>
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

                    {canEdit || canRun ? <Flex gap="2" align="center" flexShrink={0}>
                      {canEdit ? <Switch
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
                      /> : null}
                      {canRun && rule.sourceKind === "rss" ? <Button
                        size="sm"
                        variant="subtle"
                        loading={pending === "run"}
                        disabled={pending !== undefined && pending !== "run"}
                        onClick={() => void runNow(rule)}
                      >
                        <RotateCw size={12} strokeWidth={2} aria-hidden />
                        Run now
                      </Button> : null}
                      {canEdit ? <>
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
                      </> : null}
                    </Flex> : null}
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
              maxW="600px"
            >
              <Dialog.Header
                px="6"
                pt="5"
                pb="5"
                flexDirection="column"
                alignItems="stretch"
                gap="1"
              >
                <Dialog.Title textStyle="title" fontSize="18px" color="fg">
                  New autopilot rule
                </Dialog.Title>
                <Text fontSize="13px" color="fg.muted">
                  New {sourceKind === "zoom" ? "recordings" : "episodes"} become clips on their own.
                </Text>
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
                <Stack gap="7" pb="2">
                  <Step number={1} title="Source">
                    {zoomEnabled ? (
                      <SimpleGrid role="radiogroup" aria-label="Import from" columns={{ base: 1, sm: 2 }} gap="2">
                        {([
                          { value: "rss", title: "RSS feed", description: "Podcasts and shows", icon: <Rss size={15} /> },
                          { value: "zoom", title: "Zoom recordings", description: "Cloud recordings", icon: <Video size={15} /> },
                        ] as const).map((option) => (
                          <ChoiceCard
                            key={option.value}
                            selected={sourceKind === option.value}
                            onSelect={() => {
                              setSourceKind(option.value);
                              if (name === "Podcast autopilot" || name === "Zoom autopilot") setName(option.value === "zoom" ? "Zoom autopilot" : "Podcast autopilot");
                            }}
                            icon={option.icon}
                            title={option.title}
                            description={option.description}
                          />
                        ))}
                      </SimpleGrid>
                    ) : null}
                    {sourceKind === "rss" ? <Field label="RSS feed URL" htmlFor="autopilot-rss-url">
                      <Flex align="center" gap="2.5" ps="3" bg="bg.soft" borderRadius="control" color="fg.muted" borderWidth="1px" borderColor="transparent" _focusWithin={{ borderColor: "border.focus" }}>
                        <Rss size={14} aria-hidden />
                        <Input
                          id="autopilot-rss-url"
                          value={rssUrl}
                          onChange={(event) => setRssUrl(event.target.value)}
                          placeholder="https://feeds.example.com/podcast.xml"
                          fontSize="13px"
                          size="md"
                          ps="0"
                          bg="transparent"
                          borderWidth="0"
                          _hover={{ bg: "transparent" }}
                          _focus={{ borderColor: "transparent" }}
                          _focusVisible={{ borderColor: "transparent" }}
                        />
                      </Flex>
                    </Field> : <Stack gap="3">
                      {liveZoomConnections.length === 0 ? (
                        <Box bg="bg.soft" borderRadius="l2" px="3.5" py="3">
                          <Text fontSize="12.5px" color="fg.muted">
                            Zoom rules watch a connected Zoom account.{" "}
                            {canConnectZoom ? (
                              <chakra.span asChild color="fg.accent" fontWeight="600" textDecoration="underline" textUnderlineOffset="3px" cursor="pointer">
                                <button type="button" onClick={() => void zoom.connect()} disabled={zoom.connecting}>Connect Zoom first</button>
                              </chakra.span>
                            ) : (
                              "Ask a workspace editor or admin to connect Zoom."
                            )}
                          </Text>
                        </Box>
                      ) : (
                        <Select label="Zoom connection" items={liveZoomConnections.map((entry) => ({ label: entry.displayName, value: entry.id }))} value={zoomConnectionId || undefined} onValueChange={setZoomConnectionId} placeholder="Choose a connected member" size="md" />
                      )}
                      <Field label="Topic contains (optional)" htmlFor="autopilot-zoom-topic"><Input id="autopilot-zoom-topic" value={zoomTopicFilter} onChange={(event) => setZoomTopicFilter(event.target.value)} maxLength={200} size="md" fontSize="13px" placeholder="e.g. webinar" /></Field>
                      <Text fontSize="12px" color="fg.muted">Watches future cloud recordings hosted by this Zoom user. Topic matching ignores letter case. Shared screen with speaker view is preferred.</Text>
                    </Stack>}
                    <SimpleGrid columns={{ base: 1, sm: 2 }} gap="3">
                      <Field label="Rule name" htmlFor="autopilot-rule-name">
                        <Input
                          id="autopilot-rule-name"
                          value={name}
                          onChange={(event) => setName(event.target.value)}
                          fontSize="13px"
                          size="md"
                        />
                      </Field>
                      <Field
                        label="Title prefix (optional)"
                        htmlFor="autopilot-title-prefix"
                      >
                        <Input
                          id="autopilot-title-prefix"
                          value={titlePrefix}
                          onChange={(event) => setTitlePrefix(event.target.value)}
                          placeholder="e.g. Weekly show —"
                          fontSize="13px"
                          size="md"
                        />
                      </Field>
                    </SimpleGrid>
                  </Step>

                  {sourceKind === "rss" ? <Step number={2} title="Schedule">
                    <Stack gap="1.5">
                      <Text fontSize="13px" fontWeight="500" color="fg">Check the feed</Text>
                      <SegmentedControl
                        aria-label="Check interval"
                        items={INTERVAL_OPTIONS.map((option) => ({ label: option.label.replace("Every ", ""), value: option.value }))}
                        value={intervalMinutes}
                        onValueChange={setIntervalMinutes}
                        size="md"
                        w="full"
                        css={{ "& > [data-part=item]": { flex: "1", justifyContent: "center" } }}
                      />
                    </Stack>
                    <Slider
                      label="Max episodes per run"
                      showValueText
                      min={1}
                      max={10}
                      step={1}
                      value={Number(maxEpisodesPerRun) || 1}
                      onValueChange={(value) => setMaxEpisodesPerRun(String(Array.isArray(value) ? (value[0] ?? 1) : value))}
                    />
                    <Stack gap="1.5">
                      <Text fontSize="13px" fontWeight="500" color="fg">Existing episodes</Text>
                      <SimpleGrid role="radiogroup" aria-label="Existing episodes" columns={{ base: 1, sm: 2 }} gap="2">
                        <ChoiceCard
                          selected={initialImportMode === "future_only"}
                          onSelect={() => setInitialImportMode("future_only")}
                          icon={<Sparkles size={15} />}
                          title="Future episodes only"
                          description="Episodes already out are skipped."
                        />
                        <ChoiceCard
                          selected={initialImportMode === "latest"}
                          onSelect={() => setInitialImportMode("latest")}
                          icon={<History size={15} />}
                          title="Start with the latest"
                          description="Import recent episodes now."
                        >
                          {initialImportMode === "latest" ? (
                            <Box pt="2" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                              <NumberInput
                                value={initialImportCount}
                                onValueChange={setInitialImportCount}
                                min={1}
                                max={10}
                                size="sm"
                                w="24"
                                inputProps={{ id: "autopilot-initial-episodes", "aria-label": "Initial episodes" }}
                              />
                            </Box>
                          ) : null}
                        </ChoiceCard>
                      </SimpleGrid>
                    </Stack>
                  </Step> : null}

                  <Step number={sourceKind === "rss" ? 3 : 2} title="Recipe">
                    <RecipeSelect recipes={recipes} value={recipeId} onChange={setRecipeId} />
                  </Step>

                  {/* What the rule will do, in one sentence, as the form changes. */}
                  <Flex gap="2.5" align="flex-start" px="4" py="3" borderRadius="l2" bg="bg.subtle">
                    <Box mt="0.5" color="accent.fg" flexShrink={0}><RotateCw size={14} /></Box>
                    <Text fontSize="13px" color="fg.muted" lineHeight="1.5">
                      {sourceKind === "rss"
                        ? `Checks ${intervalLabel(Number(intervalMinutes)).toLowerCase()} and imports up to ${maxEpisodesPerRun} new episode${maxEpisodesPerRun === "1" ? "" : "s"} each time${initialImportMode === "latest" ? `, starting with the latest ${initialImportCount}` : ""}`
                        : "Imports each new Zoom cloud recording as it completes"}
                      {recipeId ? `, using “${recipes.find((entry) => entry.id === recipeId)?.name ?? "the Recipe"}”.` : ". Choose a Recipe to finish."}
                    </Text>
                  </Flex>

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
        api={api}
        rule={editingRule}
        recipes={recipes}
        zoomConnections={zoomConnections}
        onClose={() => setEditingRule(null)}
      />

      {confirmDialog}
    </Stack>
  );
}

function EditRuleDialog({
  api,
  rule,
  recipes,
  zoomConnections,
  onClose,
}: {
  api: AutopilotPanelApi;
  rule: AutopilotRuleSnapshot | null;
  recipes: RecipeSnapshot[];
  zoomConnections: ZoomConnectionSnapshot[];
  onClose: () => void;
}) {
  // The parent keys this dialog by rule, so every open starts a fresh draft.
  const [name, setName] = useState(rule?.name ?? "");
  const [recipeId, setRecipeId] = useState<string | null>(rule?.recipeId ?? null);
  const [connectionId, setConnectionId] = useState(rule?.zoomConnectionId ?? "");
  const [topicFilter, setTopicFilter] = useState(rule?.zoomTopicFilter ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = useMutation({
    mutationFn: (changes: AutopilotRuleUpdate) => api.actions.updateRule(rule?.id ?? "", changes),
    onSuccess: () => api.changed(),
  });

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
    const failure = await attempt(() => update.mutateAsync(changes));
    setSaving(false);
    if (failure) {
      setError(failure);
      return;
    }
    toaster.create({ type: "success", title: "Rule updated", description: name.trim() });
    onClose();
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
