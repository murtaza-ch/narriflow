"use client";

import { useState } from "react";
import Link from "next/link";
import { Flex, Input, Popover, Portal, Stack, Text } from "@chakra-ui/react";
import { FolderPlus, Plus } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { folderCommands, libraryMutationOptions } from "@narriflow/api-client/library";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { failureMessage, invalidateAfterFolderChanged, type LibraryApi } from "../_lib/api";

export function ProjectsHeaderActions({
  api,
  canCreate,
  canEdit,
}: {
  api: LibraryApi;
  canCreate: boolean;
  canEdit: boolean;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  // One intent per form: a retry after a timeout replays the same folder instead of making a second.
  const [intent] = useState(() => api.runtime.createIntent<{ name: string }>());

  const create = useMutation({
    ...libraryMutationOptions,
    mutationFn: (folderName: string) =>
      folderCommands.create(api.library, folderName, intent.keyFor({ name: folderName })),
    onSuccess: () => {
      intent.complete();
      setName("");
      setError(null);
      setOpen(false);
      void invalidateAfterFolderChanged(queryClient, api.scope);
    },
    onError: (failure) => setError(failureMessage(failure, "The folder could not be created.")),
  });
  const pending = create.isPending;

  function save() {
    if (!name.trim()) {
      setError("Enter a folder name");
      return;
    }
    create.mutate(name);
  }

  return (
    <Flex align="center" gap="2">
      {canEdit ? (
        <Popover.Root
          open={open}
          onOpenChange={(details) => {
            setOpen(details.open);
            if (!details.open) setError(null);
          }}
          positioning={{ placement: "bottom-end" }}
        >
          <Popover.Trigger asChild>
            <Button size="sm" variant="subtle">
              <FolderPlus size={16} />
              New folder
            </Button>
          </Popover.Trigger>
          <Portal>
            <Popover.Positioner>
              <Popover.Content p="4" w="320px">
                <Stack
                  as="form"
                  gap="3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    save();
                  }}
                >
                  <Stack gap="0.5">
                    <Popover.Title fontSize="14px" fontWeight="500">
                      New folder
                    </Popover.Title>
                    <Popover.Description fontSize="12.5px" color="fg.muted">
                      Group projects by show, client or campaign. Drag projects onto it to fill it.
                    </Popover.Description>
                  </Stack>
                  <Input
                    autoFocus
                    value={name}
                    onChange={(event) => setName(event.currentTarget.value)}
                    maxLength={80}
                    placeholder="e.g. Season 2"
                    aria-label="Folder name"
                    size="sm"
                    disabled={pending}
                  />
                  {error ? (
                    <Text role="alert" fontSize="12px" color="danger.fg">
                      {error}
                    </Text>
                  ) : null}
                  <Flex justify="flex-end" gap="2">
                    <Popover.CloseTrigger asChild>
                      <Button type="button" size="sm" variant="ghost">
                        Cancel
                      </Button>
                    </Popover.CloseTrigger>
                    <Button type="submit" size="sm" loading={pending}>
                      Create folder
                    </Button>
                  </Flex>
                </Stack>
              </Popover.Content>
            </Popover.Positioner>
          </Portal>
        </Popover.Root>
      ) : null}
      {canCreate ? (
        <Button size="sm" asChild>
          <Link href="/upload">
            <Plus size={16} aria-hidden="true" />
            New project
          </Link>
        </Button>
      ) : null}
    </Flex>
  );
}
