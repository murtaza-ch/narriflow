"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Flex, Input, Popover, Portal, Stack, Text } from "@chakra-ui/react";
import { FolderPlus, Plus } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { createFolderAction } from "../actions";
import { authenticatedActionResultMessage } from "@/lib/authenticated-request-browser";

export function ProjectsHeaderActions({
  canCreate,
  canEdit,
}: {
  canCreate: boolean;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function save() {
    if (!name.trim()) {
      setError("Enter a folder name");
      return;
    }

    startTransition(async () => {
      const result = await createFolderAction(name);
      if (!result.ok) {
        setError(
          authenticatedActionResultMessage(
            result,
            "The folder could not be created.",
          ),
        );
        return;
      }

      setName("");
      setError(null);
      setOpen(false);
      router.refresh();
    });
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
            <Button size="sm" variant="outline">
              <FolderPlus size={14} />
              New folder
            </Button>
          </Popover.Trigger>
          <Portal>
            <Popover.Positioner>
              <Popover.Content p="3" minW="280px">
                <Stack
                  as="form"
                  gap="2.5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    save();
                  }}
                >
                  <Text textStyle="eyebrow" color="fg.subtle">
                    Create folder
                  </Text>
                  <Input
                    autoFocus
                    value={name}
                    onChange={(event) => setName(event.currentTarget.value)}
                    maxLength={80}
                    placeholder="Folder name"
                    aria-label="Folder name"
                    disabled={pending}
                  />
                  {error ? (
                    <Text role="alert" fontSize="11px" color="danger.fg">
                      {error}
                    </Text>
                  ) : null}
                  <Button type="submit" size="sm" loading={pending} alignSelf="flex-end">
                    Create folder
                  </Button>
                </Stack>
              </Popover.Content>
            </Popover.Positioner>
          </Portal>
        </Popover.Root>
      ) : null}
      {canCreate ? (
        <Button size="sm" asChild>
          <Link href="/upload">
            <Plus size={14} aria-hidden="true" />
            New Project
          </Link>
        </Button>
      ) : null}
    </Flex>
  );
}
