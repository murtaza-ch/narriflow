"use client";

import { useState } from "react";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { CircleAlert, CloudDownload, Gem, History, RefreshCw, Undo2 } from "lucide-react";
import type { ReactNode } from "react";
import type { UpgradePrompt } from "@/app/(app)/_components/upgrade";
import type { SaveIssue } from "./save-issue";

/** The actions only the session can perform; the top bar supplies the rest. */
export type SaveIssueSessionActions = Pick<
  SaveIssueActions,
  "retry" | "loadLastSaved" | "removeBroll" | "resolveConflict"
>;

export interface SaveIssueActions {
  /** Undo the last edit (only offered when there is one to undo). */
  undo: (() => void) | null;
  upgrade: (prompt: UpgradePrompt) => void;
  retry: () => void;
  loadLastSaved: () => void;
  removeBroll: (placementIds: readonly string[]) => void;
  resolveConflict: (choice: "cloud" | "device") => void;
  openSignIn: () => void;
  backToProject: () => void;
}

const focusRing = { outline: "2px solid", outlineColor: "studio.ring", outlineOffset: "1px" } as const;

/** The one fix this problem is asking for: a solid, full-width action. */
const primary = {
  as: "button" as const,
  w: "full",
  h: "38px",
  px: "4",
  borderRadius: "10px",
  bg: "studio.fg",
  color: "studio.canvas",
  fontSize: "13px",
  fontWeight: "500",
  alignItems: "center",
  justifyContent: "center",
  gap: "1.5",
  cursor: "pointer",
  transition: "opacity 120ms ease",
  _hover: { opacity: 0.9 },
  _focusVisible: focusRing,
};

/** The other ways forward: quiet rows that fill on hover. */
const secondary = {
  as: "button" as const,
  w: "full",
  h: "32px",
  px: "2.5",
  gap: "2.5",
  alignItems: "center",
  borderRadius: "8px",
  color: "studio.fgMuted",
  fontSize: "13px",
  textAlign: "left" as const,
  cursor: "pointer",
  transition: "background 120ms ease, color 120ms ease",
  _hover: { bg: "studio.raised", color: "studio.fg" },
  _focusVisible: focusRing,
};

/** The popover behind a blocked save status: the reason and what to do next. */
export function SaveIssueBody({
  issue,
  actions,
}: {
  issue: SaveIssue;
  actions: SaveIssueActions;
}) {
  const [signInOpened, setSignInOpened] = useState(false);
  const undo = actions.undo;
  let reason: string;
  let main: { label: string; onClick: () => void; gem?: boolean };
  const others: Array<{ label: string; icon: ReactNode; onClick: () => void }> = [];
  const retry = { label: "Try saving again", icon: <RefreshCw size={14} />, onClick: actions.retry };
  const loadLastSaved = { label: "Load last saved version", icon: <History size={14} />, onClick: actions.loadLastSaved };

  switch (issue.kind) {
    case "plan":
      reason = issue.message;
      main = { label: "See plans", onClick: () => actions.upgrade(issue.prompt), gem: true };
      others.push(retry);
      if (undo) others.push({ label: "Undo last change", icon: <Undo2 size={14} />, onClick: undo });
      others.push(loadLastSaved);
      break;
    case "deleted-broll":
      reason = "A B-roll image was deleted.";
      main = { label: "Remove it", onClick: () => actions.removeBroll(issue.placementIds) };
      break;
    case "rejected":
      reason = issue.message;
      if (undo) {
        main = { label: "Undo last change", onClick: undo };
        others.push(retry, loadLastSaved);
      } else {
        main = { label: retry.label, onClick: retry.onClick };
        others.push(loadLastSaved);
      }
      break;
    case "signed-out":
      reason = "You were signed out. Your edits are safe on this device.";
      main = signInOpened
        ? { label: retry.label, onClick: retry.onClick }
        : {
            label: "Sign in again",
            onClick: () => {
              actions.openSignIn();
              setSignInOpened(true);
            },
          };
      break;
    case "missing":
      reason = "This clip is no longer available.";
      main = { label: "Back to project", onClick: actions.backToProject };
      break;
    case "conflict":
      reason = issue.resolvable
        ? "A newer version of this clip was saved elsewhere."
        : "Checking for a newer version…";
      // Keeping local edits is the default; loading the latest discards them.
      main = { label: "Keep mine", onClick: () => actions.resolveConflict("device") };
      others.push({ label: "Load latest", icon: <CloudDownload size={14} />, onClick: () => actions.resolveConflict("cloud") });
      break;
  }
  const hasAction = issue.kind !== "conflict" || issue.resolvable;

  return (
    <Box role="alert">
      <Flex gap="3" align="flex-start">
        <Flex boxSize="28px" flexShrink={0} align="center" justify="center" borderRadius="full" bg="studio.raised" color="studio.fgMuted" aria-hidden>
          <CircleAlert size={15} />
        </Flex>
        <Text fontSize="13px" color="studio.fg" lineHeight="1.5" pt="1">
          {reason}
        </Text>
      </Flex>
      {hasAction ? (
        <Stack mt="4" gap="2">
          <Flex
            {...primary}
            {...(main.gem
              ? { bg: "upgrade.solid", color: "upgrade.fg", _hover: { bg: "upgrade.solidHover" } }
              : {})}
            aria-haspopup={main.gem ? "dialog" : undefined}
            onClick={main.onClick}
          >
            {main.gem ? <Gem size={14} aria-hidden /> : null}
            {main.label}
          </Flex>
          {others.length > 0 ? (
            <Stack gap="0.5">
              {others.map((other) => (
                <Flex key={other.label} {...secondary} onClick={other.onClick}>
                  <Flex boxSize="14px" align="center" justify="center" flexShrink={0} aria-hidden>
                    {other.icon}
                  </Flex>
                  {other.label}
                </Flex>
              ))}
            </Stack>
          ) : null}
        </Stack>
      ) : null}
    </Box>
  );
}
