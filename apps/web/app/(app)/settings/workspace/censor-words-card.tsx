"use client";

import { useMemo, useState } from "react";
import { Flex, Stack, Text } from "@chakra-ui/react";
import type { WorkspaceScope } from "@narriflow/api-client";
import {
  replaceCensorWordsMutation,
  resetCensorWordsMutation,
} from "@narriflow/api-client/workspace";
import { useMutation } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { useApiRuntime } from "@/app/_components/api-provider";
import { Button } from "@narriflow/ui/components/button";
import { CensorWordListDialog, censorChipLabel } from "../../_components/censor-word-list-dialog";
import { SettingsCard } from "../_components/settings-ui";

const PREVIEW_COUNT = 8;

/** The Workspace's censored words: a glance at the list and the editor behind one button. */
export function CensorWordsCard({
  scope,
  words,
  customized,
  canManage,
}: {
  scope: WorkspaceScope;
  /** The saved list, from the Workspace censor-words query. Saves write the new list back to it. */
  words: readonly string[];
  customized: boolean;
  canManage: boolean;
}) {
  const runtime = useApiRuntime();
  const replace = useMutation(useMemo(() => replaceCensorWordsMutation(runtime, scope), [runtime, scope]));
  const reset = useMutation(useMemo(() => resetCensorWordsMutation(runtime, scope), [runtime, scope]));
  const [open, setOpen] = useState(false);
  const preview = words.slice(0, PREVIEW_COUNT);
  const rest = words.length - preview.length;
  return (
    <SettingsCard
      icon={<ShieldCheck size={16} />}
      title="Censored words"
      description="Auto-censor masks and beeps these in every project's clips."
      action={
        <Button size="sm" variant="subtle" onClick={() => setOpen(true)}>
          {canManage ? "Edit word list" : "View word list"}
        </Button>
      }
    >
      <Stack gap="3">
        <Text fontSize="13px" color="fg.muted" fontVariantNumeric="tabular-nums">
          {words.length} {words.length === 1 ? "word" : "words"}
        </Text>
        {words.length === 0 ? (
          <Text fontSize="13px" color="fg.muted">
            The list is empty, so nothing is censored from it.
            {canManage ? " Open the list to add words or restore the defaults." : ""}
          </Text>
        ) : (
          <Flex gap="2" flexWrap="wrap">
            {preview.map((word) => {
              const label = censorChipLabel(word, false);
              return (
                <Flex
                  key={word}
                  as="span"
                  align="center"
                  gap="1"
                  px="2.5"
                  py="1"
                  borderRadius="8px"
                  bg="bg.soft"
                  fontSize="13px"
                  color="fg"
                >
                  {label.text}
                  {label.wildcard ? (
                    <Text as="span" color="accent.fg" fontWeight="600" ms="-0.5" aria-label="and its variants">
                      +
                    </Text>
                  ) : null}
                </Flex>
              );
            })}
            {rest > 0 ? (
              <Text as="span" px="2.5" py="1" borderRadius="8px" bg="bg.soft" fontSize="13px" color="fg.muted">
                +{rest}
              </Text>
            ) : null}
          </Flex>
        )}
        {!canManage ? (
          <Text fontSize="12px" color="fg.subtle">Only owners and admins can change this list.</Text>
        ) : null}
      </Stack>
      <CensorWordListDialog
        open={open}
        onOpenChange={setOpen}
        tone="app"
        workspace={{
          words,
          customized,
          canEdit: canManage,
          save: (next) => replace.mutateAsync({ words: next }),
          reset: () => reset.mutateAsync(),
          // The mutations already wrote the saved list to the query; nothing else to hold.
          onChange: () => {},
        }}
      />
    </SettingsCard>
  );
}
