"use client";

import { useTransition } from "react";
import { Text } from "@chakra-ui/react";
import { Trash2 } from "lucide-react";
import { Button, IconButton } from "@narriflow/ui/components/button";
import { useConfirm } from "@narriflow/ui/components/confirm-dialog";
import { Spinner } from "@narriflow/ui/components/spinner";
import { toaster } from "@narriflow/ui/components/toaster";
import { deleteProjectFormAction } from "../actions";

/**
 * Server-action redirects surface as a thrown NEXT_REDIRECT error when the
 * action is awaited directly (outside a `<form action>`) — rethrow so
 * Next's own navigation handling takes over instead of our error toast.
 */
function isNextRedirect(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    String((error as { digest?: unknown }).digest).startsWith("NEXT_REDIRECT")
  );
}

interface DeleteProjectButtonProps {
  projectId: string;
  projectTitle: string;
  /** "icon" — compact overlay affordance for the project card.
   *  "button" — labeled danger action for the project detail page header. */
  variant?: "icon" | "button";
}

/**
 * Delete affordance shared by the project card and the project detail page.
 * Confirms via the shared ConfirmDialog (names the project, states the
 * deletion is permanent and irreversible), then calls
 * deleteProjectFormAction directly. Success redirects to /projects (thrown
 * as NEXT_REDIRECT, re-thrown below so Next handles the navigation);
 * expected failures come back as {ok:false, error} and surface as a toast
 * instead of navigating.
 *
 * Not a solid button in either variant — delete is a danger/ghost action,
 * keeping the one-solid-ultramarine-button-per-view rule intact.
 */
export function DeleteProjectButton({
  projectId,
  projectTitle,
  variant = "button",
}: DeleteProjectButtonProps) {
  const [pending, startTransition] = useTransition();
  const { confirm, dialog } = useConfirm();

  function runDelete() {
    startTransition(async () => {
      const formData = new FormData();
      formData.set("projectId", projectId);

      try {
        const result = await deleteProjectFormAction(formData);
        if (result && !result.ok) {
          toaster.create({
            type: "error",
            title: "Could not delete project",
            description: result.error ?? "Please try again.",
          });
        }
        // Otherwise the action redirected on success — nothing left to do.
      } catch (error) {
        if (isNextRedirect(error)) throw error;
        toaster.create({
          type: "error",
          title: "Could not delete project",
          description: "Please try again.",
        });
      }
    });
  }

  async function handleTriggerClick(event: { preventDefault: () => void; stopPropagation: () => void }) {
    // The card variant's trigger sits over a whole-card <Link> — stop the
    // click from also navigating.
    event.preventDefault();
    event.stopPropagation();

    const confirmed = await confirm({
      title: `Delete "${projectTitle}"?`,
      description:
        // Scheduled social posts cascade-delete with the project too. Leaving
        // them out of this list is how you get a support ticket from someone
        // whose queued posts silently vanished.
        "This permanently deletes the original source, transcript, and every clip, render, and dub for this project, and cancels any scheduled social posts. This can't be undone.",
      confirmLabel: "Delete project",
      destructive: true,
    });
    if (confirmed) runDelete();
  }

  return (
    <>
      {variant === "icon" ? (
        <IconButton
          type="button"
          size="xs"
          variant="ghost"
          colorPalette="brand"
          position="absolute"
          top="2"
          right="2"
          zIndex={1}
          borderRadius="l1"
          // Mode-invariant scrim — this sits on footage, which never flips
          // with the colour mode. Same ground as MediaWell/SourceChip.
          bg="studio.scrim"
          color="studio.fg"
          _hover={{ bg: "studio.scrimStrong", color: "studio.danger" }}
          aria-label={`Delete "${projectTitle}"`}
          disabled={pending}
          onClick={handleTriggerClick}
        >
          {pending ? <Spinner size="xs" /> : <Trash2 size={13} />}
        </IconButton>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          colorPalette="danger"
          disabled={pending}
          onClick={handleTriggerClick}
        >
          {pending ? <Spinner size="xs" /> : <Trash2 size={13} />}
          <Text ms="1.5">Delete project</Text>
        </Button>
      )}
      {dialog}
    </>
  );
}
