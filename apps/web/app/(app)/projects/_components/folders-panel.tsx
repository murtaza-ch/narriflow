"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { Flex, Grid, Input, Menu, Portal, Stack, Text, Tooltip } from "@chakra-ui/react";
import { Folder, FolderInput, Info, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { IconButton } from "@narriflow/ui/components/button";
import { useConfirm } from "@narriflow/ui/components/confirm-dialog";
import { Spinner } from "@narriflow/ui/components/spinner";
import { folderCommands, libraryMutationOptions } from "@narriflow/api-client/library";
import { invalidateAfterProjectMoved, projectCommands, projectMutationOptions } from "@narriflow/api-client/projects";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { failureMessage, invalidateAfterFolderChanged, type LibraryApi, usePrefetchExplorer } from "../_lib/api";
import { FOLDER_NAME_TAKEN_MESSAGE, isFolderNameTaken } from "../_lib/folder-names";

/** The drag payload a project card or row carries: its id. */
export const PROJECT_DRAG_TYPE = "application/x-narriflow-project";

export function FoldersPanel({
  api,
  folders,
  canEdit,
}: {
  api: LibraryApi;
  folders: Array<{ id: string; name: string; count: number }>;
  canEdit: boolean;
}) {
  const queryClient = useQueryClient();
  const prefetchExplorer = usePrefetchExplorer();
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  // The rename field's own problem (a taken name), shown under the field rather than below the grid.
  const [renameError, setRenameError] = useState<string | null>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();

  const rename = useMutation({
    ...libraryMutationOptions,
    mutationFn: (input: { folderId: string; name: string }) =>
      folderCommands.rename(api.library, input.folderId, input.name),
    onSuccess: () => {
      setEditingId(null);
      setEditingName("");
      setError(null);
      setRenameError(null);
      void invalidateAfterFolderChanged(queryClient, api.scope);
    },
    onError: (failure) => {
      const message = failureMessage(failure, "The folder could not be renamed.");
      if (message === FOLDER_NAME_TAKEN_MESSAGE) {
        // Stay in the field so the name can be fixed right away.
        setRenameError(message);
        requestAnimationFrame(() => renameInput.current?.focus());
      } else {
        setError(message);
      }
    },
  });
  const remove = useMutation({
    ...libraryMutationOptions,
    mutationFn: (folderId: string) => folderCommands.remove(api.library, folderId),
    onSuccess: () => {
      setError(null);
      void invalidateAfterFolderChanged(queryClient, api.scope);
    },
    onError: (failure) => setError(failureMessage(failure, "The folder could not be deleted.")),
  });
  const move = useMutation({
    ...projectMutationOptions,
    mutationFn: (input: { projectId: string; folderId: string }) =>
      projectCommands.moveToFolder(api.projects, input.projectId, input.folderId),
    onSuccess: () => setError(null),
    onError: (failure) => setError(failureMessage(failure, "The project could not be moved.")),
    // A refused move may still have changed what is shown; ordinary refusals need no refresh.
    onSettled: (_data, _failure, input) => {
      void invalidateAfterProjectMoved(queryClient, api.scope, input.projectId);
    },
  });
  const pending = rename.isPending || remove.isPending || move.isPending;

  function saveRename(folderId: string) {
    if (!editingName.trim()) {
      setError("Enter a folder name");
      return;
    }
    if (rename.isPending) return;
    if (isFolderNameTaken(editingName, folders, folderId)) {
      setRenameError(FOLDER_NAME_TAKEN_MESSAGE);
      renameInput.current?.focus();
      return;
    }
    rename.mutate({ folderId, name: editingName });
  }

  async function deleteFolder(folderId: string, folderName: string) {
    const confirmed = await confirm({
      title: `Delete “${folderName}”?`,
      description:
        "Projects inside this folder will be moved back to Projects. The folder will be permanently deleted.",
      confirmLabel: "Delete folder",
      destructive: true,
    });
    if (!confirmed) return;
    remove.mutate(folderId);
  }

  function dropProject(event: React.DragEvent, folderId: string) {
    event.preventDefault();
    setDropTargetId(null);
    const projectId = event.dataTransfer.getData(PROJECT_DRAG_TYPE);
    if (!projectId) return;
    move.mutate({ projectId, folderId });
  }

  if (folders.length === 0) return null;
  const liveRenameError =
    editingId && isFolderNameTaken(editingName, folders, editingId) ? FOLDER_NAME_TAKEN_MESSAGE : renameError;

  return (
    <Stack gap="3">
      <Flex align="center" gap="1.5">
        <Text textStyle="eyebrow" color="fg.muted">
          Folders
        </Text>
        {canEdit ? (
          <Tooltip.Root openDelay={150} closeDelay={0} positioning={{ placement: "right" }}>
            <Tooltip.Trigger asChild>
              <Flex
                as="button"
                aria-label="Drag a project onto a folder to move it."
                boxSize="5"
                align="center"
                justify="center"
                borderRadius="full"
                color="fg.subtle"
                cursor="help"
                _hover={{ color: "fg" }}
                _focusVisible={{ outline: "2px solid", outlineColor: "accent.solid" }}
              >
                <Info size={13} aria-hidden />
              </Flex>
            </Tooltip.Trigger>
            <Portal>
              <Tooltip.Positioner>
                <Tooltip.Content bg="bg.muted" color="fg" borderRadius="l2" boxShadow="none" px="3" py="2" fontSize="12px">
                  Drag a project onto a folder to move it.
                </Tooltip.Content>
              </Tooltip.Positioner>
            </Portal>
          </Tooltip.Root>
        ) : null}
      </Flex>

      <Grid
        gap="3"
        templateColumns={{ base: "1fr", sm: "repeat(auto-fill, minmax(210px, 240px))" }}
      >
        {folders.map((folder) => {
          const dropTarget = dropTargetId === folder.id;
          return (
          <Flex
            key={folder.id}
            align="center"
            minW="0"
            minH="68px"
            borderRadius="l3"
            borderWidth="1px"
            borderColor="border.card"
            bg={dropTarget ? "accent.subtle" : "bg.panel"}
            outline={dropTarget ? "2px solid" : "none"}
            outlineColor="accent.solid"
            transition="background 120ms ease"
            _hover={{ bg: dropTarget ? "accent.subtle" : "bg.subtle" }}
            css={{
              "@media (hover: hover) and (pointer: fine)": {
                "& .folder-menu:not([data-state=open])": { opacity: 0 },
                "&:hover .folder-menu, &:focus-within .folder-menu": { opacity: 1 },
              },
            }}
            onDragOver={(event) => {
              // Only a dragged project is something this folder takes.
              if (!event.dataTransfer.types.includes(PROJECT_DRAG_TYPE)) return;
              event.preventDefault();
              if (!dropTarget) setDropTargetId(folder.id);
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTargetId(null);
            }}
            onDrop={(event) => dropProject(event, folder.id)}
          >
            {editingId === folder.id ? (
              <Stack gap="1" flex="1" minW="0" mx="3">
                <Input
                  ref={renameInput}
                  autoFocus
                  size="sm"
                  value={editingName}
                  maxLength={80}
                  onChange={(event) => {
                    setEditingName(event.currentTarget.value);
                    setRenameError(null);
                  }}
                  onBlur={() => {
                    if (editingName.trim() && !renameError) saveRename(folder.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      saveRename(folder.id);
                    }
                    if (event.key === "Escape") {
                      setEditingId(null);
                      setEditingName("");
                      setError(null);
                      setRenameError(null);
                    }
                  }}
                  readOnly={pending}
                  aria-label={`Rename ${folder.name}`}
                  aria-invalid={liveRenameError ? true : undefined}
                  aria-describedby={liveRenameError ? `rename-hint-${folder.id}` : undefined}
                />
                {liveRenameError ? (
                  <Text id={`rename-hint-${folder.id}`} role="alert" fontSize="12px" color="danger.fg">
                    {liveRenameError}
                  </Text>
                ) : null}
              </Stack>
            ) : (
              <Flex
                asChild
                flex="1"
                align="center"
                gap="3"
                minW="0"
                alignSelf="stretch"
                px="3"
                color="fg"
              >
                <Link
                  href={`/projects?folder=${folder.id}`}
                  onPointerEnter={() => prefetchExplorer({ folder: folder.id })}
                  onFocus={() => prefetchExplorer({ folder: folder.id })}
                >
                  <Flex
                    boxSize="9"
                    flexShrink={0}
                    align="center"
                    justify="center"
                    borderRadius="10px"
                    bg={dropTarget ? "accent.muted" : "bg.soft"}
                    color={dropTarget ? "accent.fg" : "fg.muted"}
                  >
                    {dropTarget ? <FolderInput size={17} strokeWidth={1.7} /> : <Folder size={17} strokeWidth={1.7} />}
                  </Flex>
                  <Stack gap="0.5" minW="0">
                    <Text fontSize="13px" fontWeight="500" truncate>
                      {folder.name}
                    </Text>
                    <Text fontSize="12px" color={dropTarget ? "accent.fg" : "fg.subtle"} fontVariantNumeric="tabular-nums">
                      {dropTarget ? "Drop to move here" : folder.count === 0 ? "Empty" : `${folder.count} ${folder.count === 1 ? "project" : "projects"}`}
                    </Text>
                  </Stack>
                </Link>
              </Flex>
            )}

            {canEdit && editingId !== folder.id ? (
              <Menu.Root positioning={{ placement: "bottom-end", gutter: 4 }}>
                <Menu.Trigger asChild>
                  <IconButton
                    className="folder-menu"
                    size="sm"
                    variant="ghost"
                    mr="1"
                    aria-label={`Actions for ${folder.name}`}
                    disabled={pending}
                  >
                    {pending ? <Spinner size="xs" /> : <MoreHorizontal size={16} />}
                  </IconButton>
                </Menu.Trigger>
                <Portal>
                  <Menu.Positioner>
                    <Menu.Content>
                      <Menu.Item
                        value="rename"
                        onClick={() => {
                          setEditingId(folder.id);
                          setEditingName(folder.name);
                          setRenameError(null);
                        }}
                      >
                        <Pencil size={13} />
                        Rename
                      </Menu.Item>
                      <Menu.Separator />
                      <Menu.Item
                        value="delete"
                        color="danger.fg"
                        onClick={() => void deleteFolder(folder.id, folder.name)}
                      >
                        <Trash2 size={13} />
                        Delete
                      </Menu.Item>
                    </Menu.Content>
                  </Menu.Positioner>
                </Portal>
              </Menu.Root>
            ) : null}
          </Flex>
          );
        })}
      </Grid>

      {error ? (
        <Text role="alert" fontSize="12px" color="danger.fg">
          {error}
        </Text>
      ) : null}
      {dialog}
    </Stack>
  );
}
