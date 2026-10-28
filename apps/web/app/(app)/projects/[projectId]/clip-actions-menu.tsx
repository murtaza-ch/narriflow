"use client";

import { useEffect, useRef, useState } from "react";
import { Flex, Stack, Text } from "@chakra-ui/react";
import { Button, IconButton } from "@narriflow/ui/components/button";
import { ActionMenu, type ActionMenuItem } from "@narriflow/ui/components/menu";
import { ConfirmDialog } from "@narriflow/ui/components/confirm-dialog";
import { Dialog, Portal } from "@narriflow/ui/components/dialog";
import { Input } from "@narriflow/ui/components/input";
import { Spinner } from "@narriflow/ui/components/spinner";
import { toaster } from "@narriflow/ui/components/toaster";
import {
  CLIP_TITLE_MAX_LENGTH,
  type ClipSnapshot,
} from "@narriflow/validators";
import { AlertTriangle, Copy, MoreVertical, Pencil, Sparkles, Trash2, Wand2 } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { type Intent, invalidateScoped, isApiErrorCode } from "@narriflow/api-client";
import {
  CLIP_RESOURCES,
  clipCommands,
  clipMutationOptions,
  invalidateAfterClipChange,
} from "@narriflow/api-client/clips";
import { invalidateProject } from "@narriflow/api-client/projects";
import { intentIn, requireClipApi, useClipApi } from "@/lib/clip-media";
import { clipActionErrorCopy, failureNeedsStateRefetch } from "./clip-action-error-copy";

function titleSuggestionsFromPayload(payload: unknown): string[] | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>).titles;
  if (!Array.isArray(value)) return null;
  const titles = value.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  );
  return titles.length > 0 ? titles : null;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export interface ClipActionsMenuProps {
  projectId: string;
  clipId: string;
  /** Current title, or null when the clip only ever had its hook text. */
  title: string | null;
  /** Shown wherever a name is needed and `title` is null (the hook text). */
  fallbackTitle: string;
  /** Where the trigger lives — the row's hairline header, or the studio's
   *  mode-invariant dark chrome, which needs `studio.*` colours. */
  surface?: "row" | "studio";
  /** Called with the duplicate's snapshot instead of just refreshing the list.
   *  The studio uses this to navigate into the copy. */
  onDuplicated?: (clip: ClipSnapshot) => void;
  /** Called after a successful delete instead of just refreshing. The studio
   *  uses this to leave a page whose clip no longer exists. */
  onDeleted?: () => void;
}

/**
 * The clip overflow menu: Rename title (AI), Rename, Duplicate, Delete.
 *
 * Shared by the project's clip rows and the studio top bar so both surfaces
 * stay in step — a rename reachable from one and not the other is how the two
 * views drift apart.
 *
 * Every action is a typed API call; a confirmed change invalidates the clip
 * and Project reads it touched, so the row list and the studio pick it up
 * without reloading the page.
 */
export function ClipActionsMenu({
  projectId,
  clipId,
  title,
  fallbackTitle,
  surface = "row",
  onDuplicated,
  onDeleted,
}: ClipActionsMenuProps) {
  const api = useClipApi();
  // One intent per Duplicate press: a retry after a timeout or lost response
  // replays the same copy instead of making a second one.
  const duplicateIntent = useRef<Intent<{ projectId: string; clipId: string }> | null>(null);

  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState(title ?? fallbackTitle);
  const [renameSaving, setRenameSaving] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [applyingTitle, setApplyingTitle] = useState<string | null>(null);
  const suggestAbortRef = useRef<AbortController | null>(null);
  // Monotonic request id. A response whose generation is stale must not write
  // state, even if its abort didn't land first.
  const suggestGenerationRef = useRef(0);

  const [duplicating, setDuplicating] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const displayTitle = title ?? fallbackTitle;

  // Re-seed the rename field whenever the clip's own title changes underneath
  // us (an SSE-driven refresh, or a rename applied from the other surface).
  useEffect(() => {
    setRenameValue(title ?? fallbackTitle);
  }, [title, fallbackTitle]);

  // Don't leave an LLM call running for a row that no longer exists — a
  // delete unmounts these mid-request.
  useEffect(() => {
    return () => suggestAbortRef.current?.abort();
  }, []);

  const renameClip = useMutation({
    ...clipMutationOptions,
    mutationFn: async (nextTitle: string) => {
      const { studio, scope, queryClient } = requireClipApi(api);
      await studio.projects[":id"].clips[":clipId"].$patch({
        param: { id: projectId, clipId },
        json: { title: nextTitle },
      });
      // The list, the Project's clip rows and the studio's title read this clip's name.
      await Promise.all([
        invalidateScoped(queryClient, scope, "clips", CLIP_RESOURCES.list, projectId),
        invalidateScoped(queryClient, scope, "studio"),
        invalidateProject(queryClient, scope, projectId),
      ]);
      return true;
    },
  });

  async function saveTitle(nextTitle: string): Promise<boolean> {
    try {
      return await renameClip.mutateAsync(nextTitle);
    } catch (error) {
      console.warn(JSON.stringify({ level: "error", message: "clip_rename_failed" }));
      throw new Error(clipActionErrorCopy(error, "Could not rename this clip."));
    }
  }

  async function handleRenameSubmit() {
    const nextTitle = renameValue.trim();
    if (nextTitle.length === 0) {
      setRenameError("Enter a title.");
      return;
    }
    if (nextTitle === displayTitle) {
      setRenameOpen(false);
      return;
    }

    setRenameSaving(true);
    setRenameError(null);
    try {
      await saveTitle(nextTitle);
      setRenameOpen(false);
    } catch (error) {
      setRenameError(
        error instanceof Error ? error.message : "Could not rename this clip.",
      );
    } finally {
      setRenameSaving(false);
    }
  }

  /**
   * Fetches suggestions, superseding any in-flight request.
   *
   * Cancelling used to leave the request running: the LLM call kept going (a
   * paid call nobody would read), and if it resolved after the dialog was
   * reopened — or after "Try again" started a second one — its titles could land
   * in the newly opened dialog. The abort controller cancels the old request and
   * the generation counter makes any straggler's state updates no-ops.
   */
  async function loadSuggestions() {
    suggestAbortRef.current?.abort();
    const controller = new AbortController();
    suggestAbortRef.current = controller;
    const generation = ++suggestGenerationRef.current;
    const isCurrent = () => generation === suggestGenerationRef.current;

    setSuggestLoading(true);
    setSuggestError(null);
    setSuggestions([]);
    try {
      const { clips } = requireClipApi(api);
      const payload: unknown = await clips.projects[":id"].clips[":clipId"]["title-suggestions"]
        .$post({ param: { id: projectId, clipId } }, { init: { signal: controller.signal } })
        .then((response) => response.json());
      if (!isCurrent()) return;

      const titles = titleSuggestionsFromPayload(payload);
      if (!titles) {
        console.warn(JSON.stringify({ level: "error", message: "clip_title_suggestions_invalid_response" }));
        setSuggestError("Could not come up with title ideas.");
        return;
      }
      setSuggestions(titles);
    } catch (error) {
      // An abort is a deliberate cancel, not a failure to report.
      if (isAbort(error) || !isCurrent()) return;
      console.warn(JSON.stringify({ level: "error", message: "clip_title_suggestions_failed" }));
      setSuggestError(clipActionErrorCopy(error, "Could not come up with title ideas."));
    } finally {
      if (isCurrent()) setSuggestLoading(false);
    }
  }

  function openSuggestions() {
    setSuggestOpen(true);
    void loadSuggestions();
  }

  /** Closing must abort — otherwise the request outlives the dialog. */
  function closeSuggestions() {
    suggestAbortRef.current?.abort();
    suggestAbortRef.current = null;
    suggestGenerationRef.current++;
    setSuggestLoading(false);
    setSuggestions([]);
    setSuggestError(null);
    setSuggestOpen(false);
  }

  async function applySuggestion(nextTitle: string) {
    setApplyingTitle(nextTitle);
    setSuggestError(null);
    try {
      await saveTitle(nextTitle);
      closeSuggestions();
      toaster.create({ type: "success", title: "Clip renamed" });
    } catch (error) {
      setSuggestError(
        error instanceof Error ? error.message : "Could not rename this clip.",
      );
    } finally {
      setApplyingTitle(null);
    }
  }

  /** After a lost response or a conflict, the domain state says whether the command took effect. */
  function refetchWhenUncertain(failure: unknown) {
    if (api && failureNeedsStateRefetch(failure)) void invalidateAfterClipChange(api.queryClient, api.scope, projectId);
  }

  const duplicateClip = useMutation({
    ...clipMutationOptions,
    mutationFn: async () => {
      const { runtime, clips, scope, queryClient } = requireClipApi(api);
      const intent = intentIn(duplicateIntent, runtime);
      const copy = await clipCommands.duplicate(clips, projectId, clipId, intent.keyFor({ projectId, clipId }));
      // Confirmed: the next Duplicate press is a new intent.
      intent.complete();
      await invalidateAfterClipChange(queryClient, scope, projectId);
      return copy;
    },
    onError: refetchWhenUncertain,
  });

  async function handleDuplicate() {
    if (duplicating) return;
    setDuplicating(true);
    try {
      const copy = await duplicateClip.mutateAsync();
      toaster.create({
        type: "success",
        title: "Clip duplicated",
        description: "The copy keeps this clip's edits and rendered video.",
      });
      onDuplicated?.(copy);
    } catch (error) {
      console.warn(JSON.stringify({ level: "error", message: "clip_duplicate_failed" }));
      toaster.create({
        type: "error",
        title: "Could not duplicate clip",
        description: clipActionErrorCopy(error, "Please try again."),
      });
    } finally {
      setDuplicating(false);
    }
  }

  const deleteClip = useMutation({
    ...clipMutationOptions,
    mutationFn: async () => {
      const { clips, scope, queryClient } = requireClipApi(api);
      try {
        await clipCommands.remove(clips, projectId, clipId);
      } catch (error) {
        // A retry after a lost response finds the clip already gone: that is the goal.
        if (!isApiErrorCode(error, "clip_not_found")) throw error;
      }
      await invalidateAfterClipChange(queryClient, scope, projectId);
    },
    onError: refetchWhenUncertain,
  });

  async function handleDelete() {
    setDeleting(true);
    try {
      await deleteClip.mutateAsync();
      setDeleteOpen(false);
      toaster.create({ type: "success", title: "Clip deleted" });
      onDeleted?.();
    } catch (error) {
      console.warn(JSON.stringify({ level: "error", message: "clip_delete_failed" }));
      toaster.create({
        type: "error",
        title: "Could not delete clip",
        description: clipActionErrorCopy(error, "Please try again."),
      });
    } finally {
      setDeleting(false);
    }
  }

  const items: ActionMenuItem[] = [
    {
      value: "rename-ai",
      label: "Rename title",
      icon: <Wand2 size={14} />,
      hint: (
        <Flex as="span" align="center" gap="1" h="5" px="1.5" borderRadius="full" bg="accent.subtle" color="accent.fg" fontSize="11px" fontWeight="500">
          <Sparkles size={10} aria-hidden /> AI
        </Flex>
      ),
      onSelect: openSuggestions,
    },
    {
      value: "rename",
      label: "Rename",
      icon: <Pencil size={14} />,
      onSelect: () => {
        setRenameError(null);
        setRenameValue(displayTitle);
        setRenameOpen(true);
      },
    },
    {
      value: "duplicate",
      label: "Duplicate",
      icon: <Copy size={14} />,
      busy: duplicating,
      onSelect: () => void handleDuplicate(),
    },
    {
      value: "delete",
      label: "Delete",
      icon: <Trash2 size={14} />,
      destructive: true,
      onSelect: () => setDeleteOpen(true),
    },
  ];

  return (
    <>
      <ActionMenu
        ariaLabel={`Actions for "${displayTitle}"`}
        items={items}
        trigger={
          <IconButton
            type="button"
            size="xs"
            variant="ghost"
            borderRadius="l1"
            aria-label={`Actions for "${displayTitle}"`}
            color={surface === "studio" ? "studio.fgMuted" : "fg.muted"}
            _hover={
              surface === "studio"
                ? { bg: "studio.raised", color: "studio.fg" }
                : { bg: "bg.softHover", color: "fg" }
            }
          >
            <MoreVertical size={15} />
          </IconButton>
        }
      />

      {/* Manual rename */}
      <Dialog.Root
        open={renameOpen}
        onOpenChange={(details) => {
          if (renameSaving) return;
          setRenameOpen(details.open);
        }}
        placement="center"
        initialFocusEl={() => renameInputRef.current}
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content
              maxW="md"
            >
              <Dialog.Header pt="5" pb="0" px="5">
                <Dialog.Title textStyle="title" fontSize="18px" fontWeight="500" color="fg">
                  Rename clip
                </Dialog.Title>
              </Dialog.Header>
              <Dialog.Body pt="3" pb="4" px="5">
                <Input
                  ref={renameInputRef}
                  value={renameValue}
                  maxLength={CLIP_TITLE_MAX_LENGTH}
                  disabled={renameSaving}
                  aria-label="Clip title"
                  onChange={(event) => setRenameValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void handleRenameSubmit();
                    }
                  }}
                />
                <Flex justify="space-between" gap="3" mt="1.5">
                  <Text fontSize="12px" color="fg.subtle">
                    Shown in your clip list and the studio. Not burned into the
                    video.
                  </Text>
                  <Text fontSize="12px" color="fg.subtle" fontVariantNumeric="tabular-nums" flexShrink={0}>
                    {renameValue.trim().length}/{CLIP_TITLE_MAX_LENGTH}
                  </Text>
                </Flex>
                {renameError ? (
                  <Flex role="alert" align="center" gap="1.5" color="danger.fg" mt="2">
                    <AlertTriangle size={12} aria-hidden />
                    <Text fontSize="xs">{renameError}</Text>
                  </Flex>
                ) : null}
              </Dialog.Body>
              <Dialog.Footer px="5" pb="4" pt="0" gap="2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={renameSaving}
                  onClick={() => {
                    setSuggestOpen(true);
                    setRenameOpen(false);
                    void loadSuggestions();
                  }}
                >
                  <Sparkles size={16} />
                  <Text ms="1.5">Suggest with AI</Text>
                </Button>
                <Dialog.ActionTrigger asChild>
                  <Button variant="subtle" size="sm" disabled={renameSaving}>
                    Cancel
                  </Button>
                </Dialog.ActionTrigger>
                <Button
                  variant="solid"
                  size="sm"
                  colorPalette="brand"
                  loading={renameSaving}
                  onClick={() => void handleRenameSubmit()}
                >
                  Save
                </Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      {/* AI suggestions — picking one applies it immediately. */}
      <Dialog.Root
        open={suggestOpen}
        onOpenChange={(details) => {
          if (applyingTitle) return;
          // Covers Esc and backdrop clicks, not just the Cancel button.
          if (!details.open) closeSuggestions();
          else setSuggestOpen(true);
        }}
        placement="center"
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content
              maxW="md"
            >
              <Dialog.Header pt="5" pb="0" px="5">
                <Dialog.Title textStyle="title" fontSize="18px" fontWeight="500" color="fg">
                  Title ideas
                </Dialog.Title>
              </Dialog.Header>
              <Dialog.Body pt="2" pb="4" px="5">
                <Text fontSize="13px" color="fg.muted" mb="3">
                  Written from what this clip actually says. Pick one to rename
                  it.
                </Text>

                {suggestLoading ? (
                  <Flex align="center" gap="2" py="6" justify="center">
                    <Spinner size="sm" />
                    <Text fontSize="13px" color="fg.muted">
                      Reading the clip…
                    </Text>
                  </Flex>
                ) : suggestions.length > 0 ? (
                  <Stack gap="1">
                    {suggestions.map((suggestion) => (
                      <Flex
                        key={suggestion}
                        as="button"
                        align="center"
                        justify="space-between"
                        gap="3"
                        textAlign="start"
                        w="full"
                        py="2.5"
                        px="3"
                        borderRadius="l1"
                        cursor={applyingTitle ? "progress" : "pointer"}
                        transition="background 120ms ease"
                        _hover={{ bg: "bg.soft" }}
                        // Chakra's `as="button"` doesn't carry native button
                        // props through its types, so this is aria-disabled plus
                        // a no-op handler rather than the `disabled` attribute —
                        // which also keeps the row focusable while one applies.
                        aria-disabled={applyingTitle ? true : undefined}
                        onClick={
                          applyingTitle
                            ? undefined
                            : () => void applySuggestion(suggestion)
                        }
                      >
                        <Text fontSize="13.5px" color="fg" lineHeight="1.45">
                          {suggestion}
                        </Text>
                        {applyingTitle === suggestion ? (
                          <Spinner size="xs" />
                        ) : (
                          <Text textStyle="eyebrow" color="accent.fg" flexShrink={0}>
                            Use
                          </Text>
                        )}
                      </Flex>
                    ))}
                  </Stack>
                ) : null}

                {suggestError ? (
                  <Flex role="alert" align="center" gap="1.5" color="danger.fg" mt="3">
                    <AlertTriangle size={12} aria-hidden />
                    <Text fontSize="xs">{suggestError}</Text>
                  </Flex>
                ) : null}
              </Dialog.Body>
              <Dialog.Footer px="5" pb="4" pt="0" gap="2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={suggestLoading || Boolean(applyingTitle)}
                  onClick={() => void loadSuggestions()}
                >
                  Try again
                </Button>
                <Dialog.ActionTrigger asChild>
                  <Button
                    variant="subtle"
                    size="sm"
                    disabled={Boolean(applyingTitle)}
                  >
                    Cancel
                  </Button>
                </Dialog.ActionTrigger>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (deleting) return;
          setDeleteOpen(open);
        }}
        title={`Delete "${displayTitle}"?`}
        // Names every asset class that goes with it, the way the project delete
        // confirm does — a vague "this can't be undone" is how people find out
        // afterwards that their renders were included.
        description="This permanently deletes this clip and its rendered videos, preview, and dubs. Other clips in this project aren't affected. This can't be undone."
        confirmLabel="Delete clip"
        destructive
        loading={deleting}
        onConfirm={() => void handleDelete()}
      />
    </>
  );
}
