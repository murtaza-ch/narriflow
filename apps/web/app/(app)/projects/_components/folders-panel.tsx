"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Box, Flex, Grid, Input, Menu, Portal, Stack, Text } from "@chakra-ui/react";
import { Folder, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { IconButton } from "@narriflow/ui/components/button";
import { useConfirm } from "@narriflow/ui/components/confirm-dialog";
import { Spinner } from "@narriflow/ui/components/spinner";
import { deleteFolderAction, moveProjectToFolderAction, renameFolderAction } from "../actions";
import {
  authenticatedActionResultMessage,
  isAuthenticatedActionFailure,
} from "@/lib/authenticated-request-browser";

export function FoldersPanel({
  folders,
  canEdit,
}: {
  folders: Array<{ id: string; name: string; count: number }>;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [pending, startTransition] = useTransition();
  const { confirm, dialog } = useConfirm();

  function saveRename(folderId: string) {
    if (!editingName.trim()) {
      setError("Enter a folder name");
      return;
    }

    startTransition(async () => {
      const result = await renameFolderAction(folderId, editingName);
      if (!result.ok) {
        setError(
          authenticatedActionResultMessage(result, "The folder could not be renamed."),
        );
        return;
      }
      setEditingId(null);
      setEditingName("");
      setError(null);
      router.refresh();
    });
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

    startTransition(async () => {
      const result = await deleteFolderAction(folderId);
      if (isAuthenticatedActionFailure(result)) {
        setError(
          authenticatedActionResultMessage(result, "The folder could not be deleted."),
        );
        return;
      }
      setError(null);
      router.refresh();
    });
  }

  function dropProject(event: React.DragEvent, folderId: string) {
    event.preventDefault();
    const projectId = event.dataTransfer.getData("application/x-narriflow-project");
    if (!projectId) return;

    startTransition(async () => {
      const result = await moveProjectToFolderAction(projectId, folderId);
      if (isAuthenticatedActionFailure(result)) {
        setError(
          authenticatedActionResultMessage(result, "The project could not be moved."),
        );
        return;
      }
      setError(null);
      router.refresh();
    });
  }

  if (folders.length === 0) return null;

  return (
    <Stack gap="3">
      <Text fontSize="13px" fontWeight="600" color="fg">
        Folders
      </Text>

      <Grid
        gap="3"
        templateColumns={{ base: "1fr", sm: "repeat(auto-fill, minmax(210px, 240px))" }}
      >
        {folders.map((folder) => (
          <Flex
            key={folder.id}
            align="center"
            minW="0"
            minH="68px"
            borderWidth="1px"
            borderColor="border"
            borderRadius="l2"
            bg="bg.panel"
            transition="border-color 120ms ease, background 120ms ease"
            _hover={{ borderColor: "border.emphasized", bg: "bg.subtle" }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => dropProject(event, folder.id)}
          >
            {editingId === folder.id ? (
              <Input
                autoFocus
                size="sm"
                mx="3"
                value={editingName}
                maxLength={80}
                onChange={(event) => setEditingName(event.currentTarget.value)}
                onBlur={() => {
                  if (editingName.trim()) saveRename(folder.id);
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
                  }
                }}
                disabled={pending}
                aria-label={`Rename ${folder.name}`}
              />
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
                <Link href={`/projects?folder=${folder.id}`}>
                  <Box color="fg.muted" flexShrink={0}>
                    <Folder size={18} strokeWidth={1.6} />
                  </Box>
                  <Stack gap="0.5" minW="0">
                    <Text fontSize="13px" fontWeight="500" truncate>
                      {folder.name}
                    </Text>
                    <Text fontSize="11px" color="fg.subtle">
                      {folder.count} {folder.count === 1 ? "project" : "projects"}
                    </Text>
                  </Stack>
                </Link>
              </Flex>
            )}

            {canEdit && editingId !== folder.id ? (
              <Menu.Root positioning={{ placement: "bottom-end", gutter: 4 }}>
                <Menu.Trigger asChild>
                  <IconButton
                    size="sm"
                    variant="ghost"
                    mr="1"
                    aria-label={`Actions for ${folder.name}`}
                    disabled={pending}
                  >
                    {pending ? <Spinner size="xs" /> : <MoreHorizontal size={14} />}
                  </IconButton>
                </Menu.Trigger>
                <Portal>
                  <Menu.Positioner>
                    <Menu.Content minW="9rem" p="1">
                      <Menu.Item
                        value="rename"
                        gap="2"
                        fontSize="13px"
                        borderRadius="l1"
                        onClick={() => {
                          setEditingId(folder.id);
                          setEditingName(folder.name);
                        }}
                      >
                        <Pencil size={13} />
                        Rename
                      </Menu.Item>
                      <Menu.Separator />
                      <Menu.Item
                        value="delete"
                        gap="2"
                        fontSize="13px"
                        borderRadius="l1"
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
        ))}
      </Grid>

      {error ? (
        <Text role="alert" fontSize="11px" color="danger.fg">
          {error}
        </Text>
      ) : null}
      {dialog}
    </Stack>
  );
}
