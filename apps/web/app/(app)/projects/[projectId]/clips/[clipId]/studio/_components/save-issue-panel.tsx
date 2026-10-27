"use client";

import { useState } from "react";
import { Box, Flex, Text } from "@chakra-ui/react";
import { Gem } from "lucide-react";
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

const primary = {
  as: "button" as const,
  h: "36px",
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
};

const quiet = {
  as: "button" as const,
  color: "studio.fgMuted",
  fontSize: "13px",
  cursor: "pointer",
  textDecoration: "underline",
  textUnderlineOffset: "3px",
  _hover: { color: "studio.fg" },
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
  const others: Array<{ label: string; onClick: () => void }> = [];

  switch (issue.kind) {
    case "plan":
      reason = issue.message;
      main = { label: "See plans", onClick: () => actions.upgrade(issue.prompt), gem: true };
      others.push({ label: "Try saving again", onClick: actions.retry });
      if (undo) others.push({ label: "Undo last change", onClick: undo });
      others.push({ label: "Load last saved version", onClick: actions.loadLastSaved });
      break;
    case "deleted-broll":
      reason = "A B-roll image was deleted.";
      main = { label: "Remove it", onClick: () => actions.removeBroll(issue.placementIds) };
      break;
    case "rejected":
      reason = issue.message;
      if (undo) {
        main = { label: "Undo last change", onClick: undo };
        others.push({ label: "Try saving again", onClick: actions.retry });
        others.push({ label: "Load last saved version", onClick: actions.loadLastSaved });
      } else {
        main = { label: "Try saving again", onClick: actions.retry };
        others.push({ label: "Load last saved version", onClick: actions.loadLastSaved });
      }
      break;
    case "signed-out":
      reason = "You were signed out. Your edits are safe on this device.";
      main = signInOpened
        ? { label: "Try saving again", onClick: actions.retry }
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
      others.push({ label: "Load latest", onClick: () => actions.resolveConflict("cloud") });
      break;
  }
  const hasAction = issue.kind !== "conflict" || issue.resolvable;

  return (
    <Box role="alert">
      <Text fontSize="13px" color="studio.fg" lineHeight="1.5">
        {reason}
      </Text>
      {hasAction ? (
        <Flex mt="3" direction="column" gap="2.5" align="stretch">
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
            <Flex gap="4" justify="center" wrap="wrap">
              {others.map((other) => (
                <Box key={other.label} {...quiet} onClick={other.onClick}>
                  {other.label}
                </Box>
              ))}
            </Flex>
          ) : null}
        </Flex>
      ) : null}
    </Box>
  );
}
