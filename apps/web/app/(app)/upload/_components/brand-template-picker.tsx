"use client";

import { useState, type ReactNode } from "react";
import { Box, chakra, Flex, Grid, Popover, Portal, Stack, Text } from "@chakra-ui/react";
import Link from "next/link";
import { PLAN_CATALOG, type BrandTemplateSummary } from "@narriflow/validators";
import { ArrowUpRight, Check, ChevronDown, Plus, Search } from "lucide-react";
import { StyleThumb } from "../../_shared/style-thumb";
import { featureUpgradePrompt } from "@/lib/feature-upgrade-prompt";
import { PlanLimitNotice } from "../../_components/plan-limit-notice";
import { useUpgrade } from "../../_components/upgrade";

type BrandProfileOption = NonNullable<BrandTemplatePickerProps["profiles"]>[number];

interface BrandTemplatePickerProps {
  builtIns: BrandTemplateSummary[];
  mine: BrandTemplateSummary[];
  value: string | null;
  onChange: (id: string | null) => void;
  profiles?: Array<{
    id: string;
    name: string;
    defaultTemplateId: string | null;
    templates: Array<{ id: string; name: string }>;
  }>;
  profileValue?: string | null;
  onProfileChange?: (id: string | null) => void;
  /** Hides the style preset: the intake applies the profile's default style. */
  profileOnly?: boolean;
}

export function BrandTemplatePicker({
  builtIns,
  mine,
  value,
  onChange,
  profiles = [],
  profileValue = null,
  onProfileChange = () => undefined,
  profileOnly = false,
}: BrandTemplatePickerProps) {
  const { currentTier } = useUpgrade();
  // A plan without Brand Profiles explains the empty profile list instead of leaving it bare.
  const profileUpgrade = profiles.length === 0 ? featureUpgradePrompt(currentTier, "brand.profiles", "Upgrade to build your brand kit") : null;
  const activeProfile = profiles.find((profile) => profile.id === profileValue) ?? null;
  const profileTemplateIds = new Set(activeProfile?.templates.map((template) => template.id) ?? []);
  const compatibleMine = activeProfile ? mine.filter((template) => profileTemplateIds.has(template.id)) : mine;
  // A profile limits the styles to its own; without one, the built-ins are on offer too.
  const offeredBuiltIns = activeProfile ? [] : builtIns;

  return (
    <Box>
      <Stack gap="2">
        {profiles.length > 0 ? (
          <ProfilePicker
            profiles={profiles}
            templates={mine}
            value={profileValue}
            onChange={(profileId) => {
              onProfileChange(profileId);
              const profile = profiles.find((candidate) => candidate.id === profileId);
              onChange(profile?.defaultTemplateId ?? null);
            }}
          />
        ) : !profileUpgrade?.tier ? (
          // The plan has profiles, the workspace has none yet: say where they come from.
          <Flex asChild align="center" gap="2" h="10" px="3" borderRadius="l2" bg="bg.soft" fontSize="13px" color="fg.muted" _hover={{ bg: "bg.softHover", color: "fg" }}>
            <Link href="/brand-kit/new">
              <Plus size={14} aria-hidden />
              Create a Brand Profile
            </Link>
          </Flex>
        ) : null}
        {!profileOnly && (
          <StylePicker mine={compatibleMine} builtIns={offeredBuiltIns} value={value} onChange={onChange} />
        )}
      </Stack>

      {profileUpgrade?.tier ? (
        <PlanLimitNotice
          message={`Brand Profiles need the ${PLAN_CATALOG[profileUpgrade.tier].name} plan.`}
          upgrade={profileUpgrade}
        />
      ) : null}

    </Box>
  );
}

/** One look for both pickers' triggers: a playing thumbnail, a name, a line about it. */
const TRIGGER_PROPS = {
  display: "flex",
  alignItems: "center",
  gap: "3",
  w: "full",
  minH: "14",
  ps: "1.5",
  pe: "3",
  py: "1.5",
  borderRadius: "l2",
  bg: "bg.soft",
  textAlign: "left",
  cursor: "pointer",
  transition: "background 120ms ease",
  _hover: { bg: "bg.softHover" },
} as const;

/**
 * The Brand Profile, chosen by its look: each row plays the profile's default
 * caption style and shows its colors, so profiles read apart at a glance.
 */
function ProfilePicker({
  profiles,
  templates,
  value,
  onChange,
}: {
  profiles: BrandProfileOption[];
  /** The workspace's own styles, to find each profile's default one. */
  templates: BrandTemplateSummary[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = profiles.find((profile) => profile.id === value) ?? null;
  const defaultStyle = (profile: BrandProfileOption) =>
    templates.find((template) => template.id === profile.defaultTemplateId) ?? null;
  const choose = (id: string | null) => {
    onChange(id);
    setOpen(false);
  };
  const describe = (profile: BrandProfileOption) => {
    const count = profile.templates.length;
    const style = defaultStyle(profile);
    return [`${count} ${count === 1 ? "style" : "styles"}`, style ? `Default ${style.name}` : null].filter(Boolean).join(" · ");
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(details) => setOpen(details.open)}
      positioning={{ placement: "bottom-start", sameWidth: true, offset: { mainAxis: 6 }, fitViewport: true }}
      lazyMount
      unmountOnExit
    >
      <Popover.Trigger asChild>
        <chakra.button type="button" aria-label={`Brand profile: ${selected?.name ?? "No Brand Profile"}`} {...TRIGGER_PROPS}>
          <ProfileThumb style={selected ? defaultStyle(selected) : null} />
          <Stack gap="0" flex="1" minW="0">
            <Text fontSize="13px" fontWeight="500" color="fg" truncate>
              {selected?.name ?? "No Brand Profile"}
            </Text>
            <Text fontSize="12px" color="fg.muted" truncate>
              {selected ? describe(selected) : "Any style, no brand defaults"}
            </Text>
          </Stack>
          {selected ? <Palette style={defaultStyle(selected)} /> : null}
          <Box color="fg.muted" flexShrink={0}>
            <ChevronDown size={15} />
          </Box>
        </chakra.button>
      </Popover.Trigger>
      <Portal>
        <Popover.Positioner>
          <Popover.Content display="block" w="var(--reference-width)" maxH="min(420px, var(--available-height, 60vh))" overflowY="auto" p="1.5">
            <Stack gap="0.5" role="group" aria-label="Brand profiles">
              {[null, ...profiles].map((profile) => {
                const isSelected = (profile?.id ?? null) === value;
                return (
                  <chakra.button
                    key={profile?.id ?? "none"}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => choose(profile?.id ?? null)}
                    display="flex"
                    alignItems="center"
                    gap="3"
                    w="full"
                    p="1.5"
                    pe="3"
                    borderRadius="l2"
                    textAlign="left"
                    cursor="pointer"
                    bg={isSelected ? "accent.subtle" : "transparent"}
                    transition="background 120ms ease"
                    _hover={{ bg: isSelected ? "accent.subtle" : "bg.softHover" }}
                  >
                    <ProfileThumb style={profile ? defaultStyle(profile) : null} />
                    <Stack gap="0" flex="1" minW="0">
                      <Text fontSize="13px" fontWeight="500" color="fg" truncate>
                        {profile?.name ?? "No Brand Profile"}
                      </Text>
                      <Text fontSize="12px" color="fg.muted" truncate>
                        {profile ? describe(profile) : "Any style, no brand defaults"}
                      </Text>
                    </Stack>
                    {profile ? <Palette style={defaultStyle(profile)} /> : null}
                    <Box w="4" flexShrink={0} color="accent.fg">
                      {isSelected ? <Check size={15} aria-hidden /> : null}
                    </Box>
                  </chakra.button>
                );
              })}
            </Stack>
            <ManageLink href="/brand-kit">Manage Brand Profiles</ManageLink>
          </Popover.Content>
        </Popover.Positioner>
      </Portal>
    </Popover.Root>
  );
}

/** The quiet way out of a picker to where its options are made. */
function ManageLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Flex asChild align="center" gap="1.5" mt="2" px="2.5" h="9" borderRadius="l1" fontSize="12px" color="fg.muted" _hover={{ bg: "bg.softHover", color: "fg" }}>
      <Link href={href}>
        {children}
        <ArrowUpRight size={13} aria-hidden />
      </Link>
    </Flex>
  );
}

/** A profile's default style playing small, or the neutral stand-in. */
function ProfileThumb({ style }: { style: BrandTemplateSummary | null }) {
  return (
    <Box w="30px" flexShrink={0} borderRadius="6px" overflow="hidden">
      {style ? (
        <StyleThumb preset={style.captionPreset} seed={style.id} boost={2.2} imageSizes="40px" />
      ) : (
        <DefaultStyleThumb compact />
      )}
    </Box>
  );
}

/** The profile's two brand colors (user values, so literal by design). */
function Palette({ style }: { style: BrandTemplateSummary | null }) {
  if (!style) return null;
  return (
    <Flex flexShrink={0} gap="1" aria-hidden>
      {[style.primaryColor, style.secondaryColor].map((color, index) => (
        <Box key={`${color}-${index}`} w="2.5" h="4" borderRadius="3px" bg={color} />
      ))}
    </Flex>
  );
}

/** Neutral stand-in for "System default": captions without a brand style. */
function DefaultStyleThumb({ compact = false }: { compact?: boolean }) {
  return (
    <Flex
      aspectRatio={9 / 16}
      w="full"
      align="center"
      justify="center"
      bgGradient="to-b"
      gradientFrom="bg.muted"
      gradientTo="bg.soft"
      color="fg.muted"
      fontSize={compact ? "11px" : "18px"}
      fontWeight="600"
      letterSpacing="-0.02em"
    >
      Aa
    </Flex>
  );
}

/**
 * The caption style, chosen by seeing it: the trigger plays the current style,
 * and the panel is a grid of every offered style playing over footage. Only
 * on-screen previews animate, and the panel mounts only while open.
 */
function StylePicker({
  mine,
  builtIns,
  value,
  onChange,
}: {
  mine: BrandTemplateSummary[];
  builtIns: BrandTemplateSummary[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = [...mine, ...builtIns].find((template) => template.id === value) ?? null;
  const needle = query.trim().toLowerCase();
  const match = (template: BrandTemplateSummary) => !needle || template.name.toLowerCase().includes(needle);
  const sections = [
    { title: "Your styles", templates: mine.filter(match) },
    { title: "Built-in", templates: builtIns.filter(match) },
  ].filter((section) => section.templates.length > 0);
  const choose = (id: string | null) => {
    onChange(id);
    setOpen(false);
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(details) => {
        setOpen(details.open);
        if (!details.open) setQuery("");
      }}
      positioning={{ placement: "bottom-start", offset: { mainAxis: 6 }, fitViewport: true }}
      lazyMount
      unmountOnExit
    >
      <Popover.Trigger asChild>
        <chakra.button
          type="button"
          aria-label={`Caption style: ${selected?.name ?? "System default"}`}
          {...TRIGGER_PROPS}
        >
          <Box w="30px" flexShrink={0} borderRadius="6px" overflow="hidden">
            {selected ? (
              <StyleThumb preset={selected.captionPreset} seed={selected.id} boost={2.2} imageSizes="40px" />
            ) : (
              <DefaultStyleThumb compact />
            )}
          </Box>
          <Stack gap="0" flex="1" minW="0">
            <Text fontSize="13px" fontWeight="500" color="fg" truncate>
              {selected?.name ?? "System default"}
            </Text>
            <Text fontSize="12px" color="fg.muted" truncate>
              {selected
                ? `${selected.isBuiltIn ? "Built-in" : "Your style"} · ${selected.captionPreset.fontName}`
                : "Standard Narriflow captions"}
            </Text>
          </Stack>
          <Box color="fg.muted" flexShrink={0}>
            <ChevronDown size={15} />
          </Box>
        </chakra.button>
      </Popover.Trigger>
      <Portal>
        <Popover.Positioner>
          {/* Block, not the default flex column: a capped flex column shrinks its rows instead of scrolling. */}
          <Popover.Content display="block" w="min(560px, calc(100vw - 24px))" maxH="min(560px, var(--available-height, 70vh))" overflowY="auto" p="4">
            {/* A short list reads at a glance; search only earns its place in a long one. */}
            {mine.length + builtIns.length > 8 ? (
            <Flex
              align="center"
              gap="2"
              h="9"
              px="3"
              mb="4"
              borderRadius="l2"
              bg="bg.soft"
              color="fg.subtle"
              transition="background 120ms ease, color 120ms ease"
              // No outline in a panel this visual: focus just lifts the fill.
              _focusWithin={{ bg: "bg.softHover", color: "fg.muted" }}
            >
              <Search size={14} aria-hidden />
              <chakra.input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search styles"
                aria-label="Search caption styles"
                flex="1"
                minW="0"
                h="full"
                bg="transparent"
                outline="none"
                fontSize="13px"
                color="fg"
                _placeholder={{ color: "fg.subtle" }}
              />
            </Flex>
            ) : null}

            <Stack gap="5">
              {(needle ? sections : sections.length > 0 ? sections : [{ title: "Styles", templates: [] }]).map((section, index) => (
                <Box key={section.title}>
                  <Text textStyle="eyebrow" color="fg.muted" mb="2.5">
                    {section.title}
                  </Text>
                  <StyleGrid>
                    {index === 0 && !needle ? (
                      <StyleTile name="System default" selected={value === null} onSelect={() => choose(null)}>
                        <DefaultStyleThumb />
                      </StyleTile>
                    ) : null}
                    {section.templates.map((template) => (
                      <StyleTile
                        key={template.id}
                        name={template.name}
                        selected={template.id === value}
                        onSelect={() => choose(template.id)}
                      >
                        <StyleThumb preset={template.captionPreset} seed={template.id} boost={1.5} imageSizes="120px" />
                      </StyleTile>
                    ))}
                  </StyleGrid>
                </Box>
              ))}
              {needle && sections.length === 0 ? (
                <Text fontSize="13px" color="fg.muted" textAlign="center" py="6">
                  No styles match “{query.trim()}”.
                </Text>
              ) : null}
            </Stack>
            <ManageLink href="/brand-kit?tab=styles">Create or edit styles</ManageLink>
          </Popover.Content>
        </Popover.Positioner>
      </Portal>
    </Popover.Root>
  );
}

function StyleGrid({ children }: { children: ReactNode }) {
  return (
    <Grid templateColumns="repeat(auto-fill, minmax(92px, 1fr))" gap="3">
      {children}
    </Grid>
  );
}

function StyleTile({
  name,
  selected,
  onSelect,
  children,
}: {
  name: string;
  selected: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <chakra.button
      type="button"
      aria-pressed={selected}
      aria-label={name}
      onClick={onSelect}
      display="flex"
      flexDirection="column"
      gap="1.5"
      textAlign="left"
      cursor="pointer"
      className="group"
    >
      <Box
        position="relative"
        w="full"
        borderRadius="l2"
        overflow="hidden"
        outline={selected ? "2px solid" : "none"}
        outlineColor="accent.solid"
        outlineOffset="2px"
        transition="transform 150ms ease"
        _groupHover={{ transform: "translateY(-2px)" }}
      >
        {children}
        {selected ? (
          <Flex
            position="absolute"
            top="1.5"
            right="1.5"
            boxSize="5"
            align="center"
            justify="center"
            borderRadius="full"
            bg="accent.solid"
            color="accent.contrast"
          >
            <Check size={12} strokeWidth={3} aria-hidden />
          </Flex>
        ) : null}
      </Box>
      <Text fontSize="12px" color={selected ? "accent.fg" : "fg.muted"} fontWeight={selected ? "500" : "400"} truncate w="full">
        {name}
      </Text>
    </chakra.button>
  );
}
