"use client";

import { Text } from "@chakra-ui/react";
import { MoreHorizontal, Trash2 } from "lucide-react";
import { Button, IconButton } from "@narriflow/ui/components/button";
import { ActionMenu } from "@narriflow/ui/components/menu";
import { useConfirm } from "@narriflow/ui/components/confirm-dialog";
import { Spinner } from "@narriflow/ui/components/spinner";
import { toaster } from "@narriflow/ui/components/toaster";
import { isApiErrorCode } from "@narriflow/api-client";
import {
  invalidateAfterProjectDeleted,
  projectCommands,
  projectMutationOptions,
} from "@narriflow/api-client/projects";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { failureMessage, useLibraryApi } from "../_lib/api";

interface DeleteProjectButtonProps {
  projectId: string;
  projectTitle: string;
  /** "icon" — compact overlay affordance for the project card.
   *  "button" — labeled danger action for the project detail page header. */
  variant?: "icon" | "button" | "menu";
}

/**
 * Delete affordance shared by the project card and the project detail page.
 * Confirms via the shared ConfirmDialog (names the project, states the
 * deletion is permanent and irreversible), then calls
 * the delete command. A Project that is already gone counts as deleted.
 * Success navigates to /projects; a refusal surfaces as a toast instead.
 *
 * Not a solid button in either variant — delete is a danger/ghost action,
 * keeping the one-solid-ultramarine-button-per-view rule intact.
 */
export function DeleteProjectButton({
  projectId,
  projectTitle,
  variant = "button",
}: DeleteProjectButtonProps) {
  const api = useLibraryApi();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { confirm, dialog } = useConfirm();

  const remove = useMutation({
    ...projectMutationOptions,
    mutationFn: async () => {
      if (!api) throw new Error("No Workspace is selected.");
      try {
        await projectCommands.remove(api.projects, projectId);
      } catch (error) {
        if (!isApiErrorCode(error, "project_not_found")) throw error;
      }
    },
    onSuccess: () => {
      router.push("/projects");
      if (api) void invalidateAfterProjectDeleted(queryClient, api.scope, projectId);
    },
    onError: (error) =>
      toaster.create({
        type: "error",
        title: "Could not delete project",
        description: failureMessage(error, "Please try again."),
      }),
  });
  const pending = remove.isPending;
  const disabled = pending || !api;

  async function handleTriggerClick(event?: { preventDefault: () => void; stopPropagation: () => void }) {
    // The card variant's trigger sits over a whole-card <Link> — stop the
    // click from also navigating.
    event?.preventDefault();
    event?.stopPropagation();

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
    if (confirmed) remove.mutate();
  }

  return (
    <>
      {variant === "menu" ? (
        <ActionMenu
          ariaLabel="Project actions"
          trigger={
            <IconButton aria-label="Project actions" variant="subtle" size="sm" disabled={disabled}>
              <MoreHorizontal size={16} />
            </IconButton>
          }
          items={[{
            value: "delete",
            label: "Delete project",
            icon: <Trash2 size={14} />,
            destructive: true,
            busy: pending,
            onSelect: () => { void handleTriggerClick(); },
          }]}
        />
      ) : variant === "icon" ? (
        <IconButton
          className="project-card-action project-delete-action"
          transition="opacity 120ms ease, background 120ms ease"
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
          disabled={disabled}
          onClick={handleTriggerClick}
        >
          {pending ? <Spinner size="xs" /> : <Trash2 size={16} />}
        </IconButton>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          colorPalette="danger"
          disabled={disabled}
          onClick={handleTriggerClick}
        >
          {pending ? <Spinner size="xs" /> : <Trash2 size={16} />}
          <Text ms="1.5">Delete project</Text>
        </Button>
      )}
      {dialog}
    </>
  );
}
