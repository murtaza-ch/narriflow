"use client";

import { useState } from "react";
import { Flex, Stack, Text } from "@chakra-ui/react";
import { ShieldCheck } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { CensorWordListDialog, censorChipLabel } from "../../_components/censor-word-list-dialog";
import { replaceCensorWordsAction, resetCensorWordsAction } from "./censor-words-actions";
import { SettingsCard } from "../_components/settings-ui";

const PREVIEW_COUNT = 8;

/** The Workspace's censored words: a glance at the list and the editor behind one button. */
export function CensorWordsCard({
  initialWords,
  customized,
  canManage,
}: {
  initialWords: string[];
  customized: boolean;
  canManage: boolean;
}) {
  const [list, setList] = useState({ words: initialWords, customized });
  const { words } = list;
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
          customized: list.customized,
          canEdit: canManage,
          save: replaceCensorWordsAction,
          reset: resetCensorWordsAction,
          onChange: setList,
        }}
      />
    </SettingsCard>
  );
}
