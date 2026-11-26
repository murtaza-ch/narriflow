"use client";

import { useEffect, useMemo, useState } from "react";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { RotateCw, Sparkles } from "lucide-react";
import { Spinner } from "@narriflow/ui/components/spinner";
import { CAPTION_EMOJI_LIMIT, captionEmojiPalette, captionEmojiTemplateColours, userErrorMessage, type CaptionEmojiDensity } from "@narriflow/validators";
import { PanelSegmented, SectionLabel } from "../tool-panels/panel-ui";
import { captionEmojiRunBusy, type CaptionEmojiRun, type CaptionEmojiRunFailure } from "./caption-emoji-runs";
import { captionEmojiWordShows } from "./caption-emoji-words";
import { LiveCueEmojiChips, type LiveCueSource } from "./emoji-chips";
import { warmEmojiPicker } from "./emoji-picker-host";
import { EmojiStyleControls, EmojiSwitch, type EmojiColourField } from "./emoji-style-controls";
import type { CaptionEmojiEditor } from "./use-caption-emojis";

// The Captions panel's Emojis section, for every preset kind: the switch, the AI action with its
// density, the count with Regenerate and Remove all, "On screen now" word chips and the style. The
// AI run never blocks the section: chips and style stay usable while it is out.

const DENSITIES: readonly { value: CaptionEmojiDensity; label: string; title: string }[] = [
  { value: "light", label: "Light", title: "Only the surest matches, at most one about every 5 seconds" },
  { value: "balanced", label: "Balanced", title: "Clear matches, at most one about every 2.5 seconds" },
  { value: "expressive", label: "Expressive", title: "Every match, at most one about every 1.5 seconds" },
];

/** What the section shows besides the run's own state. */
export type EmojisSectionView = "off" | "no-words" | "none" | "some";

export function emojisSectionView(editor: Pick<CaptionEmojiEditor, "enabled" | "model" | "placement">): EmojisSectionView {
  if (!editor.enabled) return "off";
  if (!editor.model.words.some(captionEmojiWordShows)) return "no-words";
  return editor.placement.shown > 0 ? "some" : "none";
}

/** A failed run's message, and whether trying again can help (a missing key or clip cannot). */
export function emojiRunFailure(failure: CaptionEmojiRunFailure): { readonly message: string; readonly retry: boolean } {
  switch (failure.reason) {
    case "save":
      return { message: "Couldn’t save your latest edits, so no emojis were added.", retry: true };
    case "read_only":
      return { message: "Read-only here. Take over editing, then try again.", retry: false };
    case "incomplete":
      return { message: "Couldn’t finish. Your emojis are unchanged.", retry: true };
    case "closed":
      return { message: "The clip was closed before the emojis arrived. Try again.", retry: true };
    case "request":
      if (failure.code === null) return { message: "Couldn't reach Narriflow. Check your connection and try again.", retry: true };
      return { message: userErrorMessage(failure.code) ?? "We couldn't add emojis just now. Please try again.", retry: failure.code !== "openai_not_configured" && failure.code !== "clip_not_found" };
  }
}

/**
 * Add with AI and Regenerate: the panel's button surface (`PanelButton`) in every state. While a run
 * is out the surface stays and the progress shows inside it.
 */
function RunButton({ label, icon, busy, disabled, onClick }: { label: string; icon: React.ReactNode; busy: boolean; disabled: boolean; onClick: () => void }) {
  const inactive = busy || disabled;
  return (
    <Flex
      as="button"
      w="full"
      h="44px"
      align="center"
      justify="center"
      gap="2"
      borderRadius="10px"
      bg="studio.raised"
      border="none"
      color="studio.fg"
      fontSize="14px"
      fontWeight="500"
      cursor={busy ? "progress" : disabled ? "not-allowed" : "pointer"}
      opacity={disabled && !busy ? 0.45 : 1}
      aria-disabled={inactive}
      aria-busy={busy}
      transition="background 120ms ease"
      _hover={inactive ? undefined : { bg: "studio.borderStrong" }}
      onClick={inactive ? undefined : onClick}
    >
      {busy ? <Spinner size="xs" color="studio.fgMuted" /> : icon}
      {busy ? "Adding emojis…" : label}
    </Flex>
  );
}

function doneMessage(run: Extract<CaptionEmojiRun, { status: "done" }>): string {
  const parts = [`Added ${run.added} emoji${run.added === 1 ? "" : "s"}.`];
  if (run.leftOut > 0) parts.push(`${run.leftOut} more didn’t fit: a clip holds up to ${CAPTION_EMOJI_LIMIT}.`);
  if (run.partial) parts.push("Part of this clip couldn’t be tagged.");
  return parts.join(" ");
}

function RunMessage({ run, onRetry, onDismiss }: { run: CaptionEmojiRun; onRetry: () => void; onDismiss: () => void }) {
  // A plain "Added" is a passing confirmation (the count above stays); one that left something out stays.
  const passing = run.status === "done" && run.added > 0 && run.leftOut === 0 && !run.partial;
  useEffect(() => {
    if (!passing) return;
    const timer = window.setTimeout(onDismiss, 5000);
    return () => window.clearTimeout(timer);
  }, [passing, onDismiss]);
  if (run.status === "done" && run.added > 0) {
    return (
      <Text fontSize="12px" color="studio.fgMuted" lineHeight="1.5">
        {doneMessage(run)}
      </Text>
    );
  }
  if (run.status === "done") {
    return (
      <Box px="3" py="2.5" bg="studio.subtle" borderRadius="10px">
        <Text fontSize="13px" fontWeight="500" color="studio.fg">
          No emojis fit this clip
        </Text>
        <Text fontSize="12px" color="studio.fgMuted" lineHeight="1.5" mt="0.5">
          Try Expressive, or tap a word below to add one.
        </Text>
      </Box>
    );
  }
  if (run.status === "failed") {
    const failure = emojiRunFailure(run.failure);
    return (
      <Flex px="3" py="2.5" gap="3" align="center" justify="space-between" bg="studio.subtle" borderRadius="10px">
        <Text fontSize="12px" color="studio.danger" lineHeight="1.5">
          {failure.message}
        </Text>
        {failure.retry ? (
          <Box as="button" flexShrink={0} h="28px" px="2.5" borderRadius="8px" bg="studio.raised" color="studio.fg" fontSize="12px" fontWeight="500" cursor="pointer" _hover={{ bg: "studio.borderStrong" }} onClick={onRetry}>
            Try again
          </Box>
        ) : null}
      </Flex>
    );
  }
  return null;
}

function TextButton({ children, onClick, disabled = false }: { children: string; onClick: () => void; disabled?: boolean }) {
  return (
    <Box
      as="button"
      fontSize="12px"
      fontWeight="500"
      color="studio.fgMuted"
      cursor={disabled ? "default" : "pointer"}
      opacity={disabled ? 0.45 : 1}
      aria-disabled={disabled}
      _hover={disabled ? undefined : { color: "studio.fg" }}
      onClick={disabled ? undefined : onClick}
    >
      {children}
    </Box>
  );
}

function RegenerateConfirm({ onReplace, onCancel }: { onReplace: () => void; onCancel: () => void }) {
  return (
    <Box px="3" py="3" bg="studio.subtle" borderRadius="10px" role="group" aria-label="Replace your emoji edits">
      <Text fontSize="13px" fontWeight="500" color="studio.fg">
        Replace your emoji edits?
      </Text>
      <Text fontSize="12px" color="studio.fgMuted" lineHeight="1.5" mt="0.5">
        Regenerate replaces every emoji in this clip, including the ones you placed or changed. You can undo it.
      </Text>
      <Flex gap="2" mt="2.5">
        <Box as="button" h="30px" px="3" borderRadius="8px" bg="studio.fg" color="studio.canvas" fontSize="12px" fontWeight="500" cursor="pointer" _hover={{ opacity: 0.9 }} onClick={onReplace}>
          Replace
        </Box>
        <Box as="button" h="30px" px="3" borderRadius="8px" bg="studio.raised" color="studio.fg" fontSize="12px" fontWeight="500" cursor="pointer" _hover={{ bg: "studio.borderStrong" }} onClick={onCancel}>
          Cancel
        </Box>
      </Flex>
    </Box>
  );
}

export function EmojisSection({ editor, live, ColourField }: { editor: CaptionEmojiEditor; live: LiveCueSource; ColourField: EmojiColourField }) {
  const view = emojisSectionView(editor);
  const running = captionEmojiRunBusy(editor.run);
  const [confirming, setConfirming] = useState(false);
  const matchPalette = useMemo(() => captionEmojiPalette(captionEmojiTemplateColours(editor.preset)), [editor.preset]);

  // The picker's chunk loads while the user looks at the section, so the first tap opens at once.
  useEffect(() => {
    if (view === "off") return;
    const handle = window.setTimeout(warmEmojiPicker, 800);
    return () => window.clearTimeout(handle);
  }, [view]);

  const generate = () => {
    setConfirming(false);
    editor.generate(editor.density);
  };
  const regenerate = () => (editor.confirmRegenerate ? setConfirming(true) : generate());
  const subtitlesHidden = editor.preset.visible === false;

  return (
    <Box>
      <SectionLabel action={<EmojiSwitch label="Emojis" checked={editor.enabled} disabled={editor.readOnly} onChange={editor.setEnabled} />}>Emojis</SectionLabel>

      {view === "off" ? (
        <Text fontSize="12px" color="studio.fgMuted" lineHeight="1.5">
          Stickers above your captions, drawn in your caption colors.
        </Text>
      ) : view === "no-words" ? (
        <Text fontSize="12px" color="studio.fgMuted" lineHeight="1.5">
          This clip has no caption words yet, so there is nothing to add emojis to.
        </Text>
      ) : (
        <Stack gap="5" inert={editor.readOnly || undefined} opacity={editor.readOnly ? 0.55 : 1}>
          {subtitlesHidden ? (
            <Text fontSize="12px" color="studio.fgMuted" lineHeight="1.5">
              Subtitles are hidden, so emojis are hidden too.
            </Text>
          ) : null}

          <Stack gap="2.5">
            {view === "some" ? (
              <Flex align="center" justify="space-between" gap="3" minH="20px">
                <Text fontSize="13px" color="studio.fg" fontVariantNumeric="tabular-nums">
                  {editor.placement.shown} emoji{editor.placement.shown === 1 ? "" : "s"}
                </Text>
                <TextButton disabled={running} onClick={editor.removeAll}>
                  Remove all
                </TextButton>
              </Flex>
            ) : null}
            <PanelSegmented
              ariaLabel="How many emojis"
              size="sm"
              value={editor.density}
              onChange={editor.setDensity}
              items={DENSITIES.map((item) => ({ ...item, disabled: running }))}
            />
            {confirming ? (
              <RegenerateConfirm onReplace={generate} onCancel={() => setConfirming(false)} />
            ) : view === "some" ? (
              <RunButton label="Regenerate" icon={<RotateCw size={14} />} busy={running} disabled={editor.readOnly} onClick={regenerate} />
            ) : (
              <RunButton label="Add with AI" icon={<Sparkles size={15} />} busy={running} disabled={editor.readOnly} onClick={generate} />
            )}
            <Box aria-live="polite" _empty={{ display: "none" }}>
              {running ? null : <RunMessage run={editor.run} onRetry={generate} onDismiss={editor.dismissRun} />}
              {view === "none" && (editor.run.status === "idle" || running) ? (
                <Text fontSize="12px" color="studio.fgMuted" lineHeight="1.5">
                  {editor.run.status === "saving" ? "Saving your edits first." : running ? "This takes a few seconds. You can keep editing." : "Or tap a word below to add one by hand."}
                </Text>
              ) : null}
            </Box>
          </Stack>

          <Box>
            <Text fontSize="12px" color="studio.fgMuted" mb="2">
              On screen now
            </Text>
            <LiveCueEmojiChips editor={editor} live={live} />
          </Box>

          <EmojiStyleControls preset={editor.preset} matchPalette={matchPalette} update={editor.updatePreset} ColourField={ColourField} />
        </Stack>
      )}
    </Box>
  );
}
