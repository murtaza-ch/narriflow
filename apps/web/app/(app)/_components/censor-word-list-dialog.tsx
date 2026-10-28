"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Box, Dialog, Flex, Input, Portal, Stack, Text } from "@chakra-ui/react";
import { Eye, EyeOff, Plus, RotateCcw, ShieldCheck, X } from "lucide-react";
import { toaster } from "@narriflow/ui/components/toaster";
import {
  censorTermIssue,
  maskCensorTermForDisplay,
  PROJECT_CENSOR_TERMS_MAX,
  WORKSPACE_CENSOR_WORDS_MAX,
  type WorkspaceCensorWords,
} from "@narriflow/validators";
import {
  authenticatedActionResultMessage,
  isAuthenticatedActionFailure,
} from "@/lib/authenticated-request-browser";

/**
 * The censored-word list editor: the Workspace list (shared by every project),
 * an optional Project list, and the Brand kit's blocked terms, read-only. One
 * dialog serves the Studio (graphite) and Settings (the app's own theme).
 */

type Tone = "studio" | "app";

const TONES = {
  studio: {
    surface: "studio.surface",
    fg: "studio.fg",
    muted: "studio.fgMuted",
    subtle: "studio.fgSubtle",
    soft: "studio.subtle",
    chip: "studio.raised",
    chipHover: "studio.borderStrong",
    danger: "studio.danger",
  },
  app: {
    surface: "bg.dialog",
    fg: "fg",
    muted: "fg.muted",
    subtle: "fg.subtle",
    soft: "bg.subtle",
    chip: "bg.soft",
    chipHover: "bg.muted",
    danger: "danger.fg",
  },
} as const;

const FIELD_FOCUS = { outline: "none", boxShadow: "none" } as const;

/**
 * The Workspace list and how to change it. The save and reset callbacks are the
 * caller's server actions (this dialog stays free of server imports), and
 * resolve with the action's result.
 */
export interface WorkspaceCensorWordsEditor {
  words: readonly string[];
  /** The server's flag: whether the Workspace has edited its list. Reset follows it. */
  customized: boolean;
  canEdit: boolean;
  save: (words: string[]) => Promise<unknown>;
  reset: () => Promise<unknown>;
  onChange: (state: WorkspaceCensorWords) => void;
}

export interface ProjectCensorTerms {
  terms: readonly string[];
  canEdit: boolean;
  /** Saves the whole list and resolves with what was stored; throws with a user-facing message. */
  save: (terms: string[]) => Promise<string[]>;
}

function foldedTerm(term: string) {
  return term.normalize("NFKC").toLocaleLowerCase("und").trim().replace(/\s+/g, " ");
}

function SoftButton({
  tone,
  children,
  onClick,
  disabled,
  label,
}: {
  tone: Tone;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  label?: string;
}) {
  const t = TONES[tone];
  return (
    <Flex
      as="button"
      aria-label={label}
      align="center"
      justify="center"
      gap="1.5"
      h="32px"
      px="3"
      flexShrink={0}
      borderRadius="8px"
      bg={t.chip}
      border="none"
      color={t.fg}
      fontSize="13px"
      fontWeight="500"
      whiteSpace="nowrap"
      cursor={disabled ? "not-allowed" : "pointer"}
      opacity={disabled ? 0.45 : 1}
      aria-disabled={disabled}
      transition="background 120ms ease"
      _hover={disabled ? undefined : { bg: t.chipHover }}
      onClick={disabled ? undefined : onClick}
    >
      {children}
    </Flex>
  );
}

/** A masked list: each word a chip, with a remove button when the list is editable. */
function WordChips({
  tone,
  words,
  reveal,
  onRemove,
  busy,
}: {
  tone: Tone;
  words: readonly string[];
  reveal: boolean;
  onRemove: ((word: string) => void) | null;
  busy: boolean;
}) {
  const t = TONES[tone];
  return (
    // A long list scrolls inside its own box so the sections below stay in reach.
    <Flex gap="2" flexWrap="wrap" maxH="236px" overflowY="auto" alignContent="flex-start">
      {words.map((word) => {
        const shown = reveal ? word : maskCensorTermForDisplay(word);
        return (
          <Flex
            key={word}
            align="center"
            gap="1.5"
            h="30px"
            ps="2.5"
            pe={onRemove ? "1.5" : "2.5"}
            borderRadius="8px"
            bg={t.chip}
            color={t.fg}
            fontSize="13px"
            fontVariantNumeric="tabular-nums"
          >
            <Text as="span">{shown}</Text>
            {onRemove ? (
              <Flex
                as="button"
                aria-label={`Remove ${shown}`}
                align="center"
                justify="center"
                boxSize="20px"
                borderRadius="full"
                bg="transparent"
                border="none"
                color={t.muted}
                cursor={busy ? "not-allowed" : "pointer"}
                opacity={busy ? 0.5 : 1}
                _hover={busy ? undefined : { color: t.fg, bg: t.chipHover }}
                onClick={busy ? undefined : () => onRemove(word)}
              >
                <X size={12} />
              </Flex>
            ) : null}
          </Flex>
        );
      })}
    </Flex>
  );
}

function AddWordRow({
  tone,
  placeholder,
  ariaLabel,
  existing,
  max,
  onAdd,
  busy,
}: {
  tone: Tone;
  placeholder: string;
  ariaLabel: string;
  existing: readonly string[];
  max: number;
  onAdd: (term: string) => Promise<boolean>;
  busy: boolean;
}) {
  const t = TONES[tone];
  const [draft, setDraft] = useState("");
  const term = draft.trim();
  const issue = !term
    ? null
    : term.length > 80
      ? "Keep it to 80 characters."
      : censorTermIssue(term) ??
        (existing.some((word) => foldedTerm(word) === foldedTerm(term)) ? "Already in the list." : null) ??
        (existing.length >= max ? `The list is full (${max} words).` : null);
  const submit = async () => {
    if (!term || issue || busy) return;
    if (await onAdd(term)) setDraft("");
  };
  return (
    <Stack gap="1.5">
      <Flex gap="2">
        <Input
          aria-label={ariaLabel}
          aria-invalid={issue ? true : undefined}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") void submit(); }}
          placeholder={placeholder}
          h="40px"
          px="3"
          fontSize="14px"
          {...(tone === "studio"
            ? {
                bg: t.soft,
                borderWidth: "1px",
                borderColor: "transparent",
                borderRadius: "10px",
                color: t.fg,
                focusVisibleRing: "none" as const,
                _placeholder: { color: t.subtle },
                _focus: { ...FIELD_FOCUS, borderColor: "studio.borderFocus" },
                _focusVisible: { ...FIELD_FOCUS, borderColor: "studio.borderFocus" },
              }
            : {})}
        />
        <Flex
          as="button"
          aria-label={`${ariaLabel}: add`}
          align="center"
          gap="1.5"
          h="40px"
          px="3.5"
          flexShrink={0}
          borderRadius="10px"
          bg={t.chip}
          border="none"
          color={t.fg}
          fontSize="14px"
          fontWeight="500"
          cursor={!term || issue || busy ? "not-allowed" : "pointer"}
          opacity={!term || issue || busy ? 0.45 : 1}
          aria-disabled={!term || Boolean(issue) || busy}
          _hover={!term || issue || busy ? undefined : { bg: t.chipHover }}
          onClick={() => void submit()}
        >
          <Plus size={15} /> Add
        </Flex>
      </Flex>
      {issue ? (
        <Text role="alert" fontSize="12px" color={t.danger}>{issue}</Text>
      ) : (
        <Text fontSize="12px" color={t.subtle}>
          End a word with * to match its variants, e.g. fuck* also catches fucked.
        </Text>
      )}
    </Stack>
  );
}

function SectionHeader({
  tone,
  title,
  count,
  max,
  note,
  action,
}: {
  tone: Tone;
  title: string;
  count: number;
  max: number;
  note?: string;
  action?: ReactNode;
}) {
  const t = TONES[tone];
  return (
    <Flex align="center" justify="space-between" gap="3" minH="32px">
      <Flex align="baseline" gap="2" minW="0">
        <Text fontSize="14px" fontWeight="500" color={t.fg}>{title}</Text>
        <Text fontSize="12px" color={t.subtle} fontVariantNumeric="tabular-nums">
          {count} / {max}
        </Text>
        {note ? <Text fontSize="12px" color={t.subtle}>· {note}</Text> : null}
      </Flex>
      {action}
    </Flex>
  );
}

export function CensorWordListDialog({
  open,
  onOpenChange,
  tone,
  workspace,
  project,
  onProjectTermsChange,
  brandTerms = [],
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tone: Tone;
  workspace: WorkspaceCensorWordsEditor;
  project?: ProjectCensorTerms;
  onProjectTermsChange?: (terms: string[]) => void;
  brandTerms?: readonly string[];
}) {
  const t = TONES[tone];
  const { words: workspaceWords, canEdit: canEditWorkspace, customized } = workspace;
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  // Words stay hidden each time the dialog opens.
  useEffect(() => {
    if (open) setReveal(false);
  }, [open]);

  const fail = (title: string, description: string) =>
    toaster.create({ type: "error", title, description });

  async function saveWorkspace(
    run: () => Promise<unknown>,
    failure: string,
  ): Promise<boolean> {
    setBusy(true);
    try {
      const result = await run();
      const saved = result as { words?: unknown; customized?: unknown } | null;
      if (
        isAuthenticatedActionFailure(result) ||
        !saved ||
        typeof saved !== "object" ||
        !Array.isArray(saved.words) ||
        typeof saved.customized !== "boolean"
      ) {
        fail("Word list not saved", authenticatedActionResultMessage(result, failure));
        return false;
      }
      workspace.onChange({ words: saved.words as string[], customized: saved.customized });
      return true;
    } catch {
      fail("Word list not saved", failure);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const saveWorkspaceList = (next: string[]) =>
    saveWorkspace(() => workspace.save(next), "Try again. Your list is unchanged.");

  async function saveProject(next: string[]): Promise<boolean> {
    if (!project) return false;
    setBusy(true);
    try {
      onProjectTermsChange?.(await project.save(next));
      return true;
    } catch (error) {
      fail("Project words not saved", error instanceof Error ? error.message : "Try again. Your list is unchanged.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const revealToggle = (
    <SoftButton tone={tone} onClick={() => setReveal((current) => !current)}>
      {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
      {reveal ? "Hide words" : "Show words"}
    </SoftButton>
  );

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(event) => onOpenChange(event.open)}
      placement="center"
      scrollBehavior="inside"
    >
      <Portal>
        <Dialog.Backdrop zIndex={300} />
        <Dialog.Positioner zIndex={310}>
          <Dialog.Content
            w="min(560px, 94vw)"
            maxW="min(560px, 94vw)"
            maxH="min(720px, 92vh)"
            bg={t.surface}
            color={t.fg}
            borderRadius="14px"
          >
            <Flex px="6" pt="5" pb="3" align="flex-start" justify="space-between" gap="3">
              <Stack gap="1">
                <Dialog.Title asChild>
                  <Text fontSize="18px" fontWeight="500" letterSpacing="-0.01em">Censored words</Text>
                </Dialog.Title>
                <Dialog.Description asChild>
                  <Text fontSize="13px" color={t.muted} lineHeight="1.5">
                    Words are shown masked. Auto-censor scans every clip for these, plus the project and brand words below.
                  </Text>
                </Dialog.Description>
              </Stack>
              <Dialog.CloseTrigger asChild>
                <Flex
                  as="button"
                  aria-label="Close"
                  align="center"
                  justify="center"
                  boxSize="32px"
                  flexShrink={0}
                  borderRadius="full"
                  bg="transparent"
                  border="none"
                  color={t.muted}
                  cursor="pointer"
                  position="static"
                  _hover={{ color: t.fg, bg: t.chip }}
                >
                  <X size={17} />
                </Flex>
              </Dialog.CloseTrigger>
            </Flex>

            <Dialog.Body px="6" pb="6" pt="2">
              <Stack gap="7">
                <Stack gap="3">
                  <SectionHeader
                    tone={tone}
                    title="Workspace words"
                    count={workspaceWords.length}
                    max={WORKSPACE_CENSOR_WORDS_MAX}
                    note={customized ? "Edited" : "Default list"}
                    action={
                      <Flex gap="2">
                        {canEditWorkspace ? (
                          <SoftButton
                            tone={tone}
                            disabled={!customized || busy}
                            onClick={() => void saveWorkspace(() => workspace.reset(), "Try again. Your list is unchanged.")}
                          >
                            <RotateCcw size={13} /> Reset to defaults
                          </SoftButton>
                        ) : null}
                        {revealToggle}
                      </Flex>
                    }
                  />
                  {canEditWorkspace ? (
                    <AddWordRow
                      tone={tone}
                      ariaLabel="Workspace word"
                      placeholder="Add a word or phrase"
                      existing={workspaceWords}
                      max={WORKSPACE_CENSOR_WORDS_MAX}
                      busy={busy}
                      onAdd={(term) => saveWorkspaceList([...workspaceWords, term])}
                    />
                  ) : (
                    <Text fontSize="13px" color={t.muted}>
                      Shared by every project here. Only owners and admins can change this list.
                    </Text>
                  )}
                  {workspaceWords.length === 0 ? (
                    <Flex direction="column" align="center" textAlign="center" gap="1.5" px="4" py="6" bg={t.soft} borderRadius="12px">
                      <Box color={t.subtle} aria-hidden><ShieldCheck size={20} /></Box>
                      <Text fontSize="14px" fontWeight="500">The list is empty</Text>
                      <Text fontSize="12.5px" color={t.muted} maxW="300px" lineHeight="1.5">
                        Nothing is censored from the workspace list.
                        {canEditWorkspace ? " Add a word, or reset to the defaults." : ""}
                      </Text>
                    </Flex>
                  ) : (
                    <WordChips
                      tone={tone}
                      words={workspaceWords}
                      reveal={reveal}
                      busy={busy}
                      onRemove={canEditWorkspace
                        ? (word) => void saveWorkspaceList(workspaceWords.filter((candidate) => candidate !== word))
                        : null}
                    />
                  )}
                </Stack>

                {project ? (
                  <Stack gap="3">
                    <SectionHeader
                      tone={tone}
                      title="Project words"
                      count={project.terms.length}
                      max={PROJECT_CENSOR_TERMS_MAX}
                    />
                    {project.canEdit ? (
                      <AddWordRow
                        tone={tone}
                        ariaLabel="Project word"
                        placeholder="Add a word for this project only"
                        existing={project.terms}
                        max={PROJECT_CENSOR_TERMS_MAX}
                        busy={busy}
                        onAdd={(term) => saveProject([...project.terms, term])}
                      />
                    ) : null}
                    {project.terms.length === 0 ? (
                      <Text fontSize="13px" color={t.muted}>No words for this project yet.</Text>
                    ) : (
                      <WordChips
                        tone={tone}
                        words={project.terms}
                        reveal={reveal}
                        busy={busy}
                        onRemove={project.canEdit
                          ? (word) => void saveProject(project.terms.filter((candidate) => candidate !== word))
                          : null}
                      />
                    )}
                  </Stack>
                ) : null}

                {project ? (
                  <Stack gap="3">
                    <Flex align="center" justify="space-between" gap="3" minH="32px">
                      <Text fontSize="14px" fontWeight="500">Brand words</Text>
                      <Box
                        as="a"
                        // Opens beside the editor so unsaved work stays put.
                        {...{ href: "/brand-kit", target: "_blank", rel: "noreferrer" }}
                        fontSize="13px"
                        fontWeight="500"
                        color={t.muted}
                        _hover={{ color: t.fg }}
                      >
                        Edit in Brand kit
                      </Box>
                    </Flex>
                    {brandTerms.length === 0 ? (
                      <Text fontSize="13px" color={t.muted}>
                        This project's brand has no blocked words. Add them in Brand kit under voice guidance.
                      </Text>
                    ) : (
                      <WordChips tone={tone} words={brandTerms} reveal={reveal} busy={busy} onRemove={null} />
                    )}
                  </Stack>
                ) : null}
              </Stack>
            </Dialog.Body>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
