"use client";

import { useMemo, useState } from "react";
import { Box, Field, Flex, Input, Stack, Text } from "@chakra-ui/react";
import type { WorkspaceScope } from "@narriflow/api-client";
import { createApiKeyMutation } from "@narriflow/api-client/developer";
import { useMutation } from "@tanstack/react-query";
import { Bot, CheckCircle2, Download, Eye, Plus, Scissors, Send } from "lucide-react";
import { WORKSPACE_API_KEY_READ_SCOPES } from "@narriflow/validators";
import { Button } from "@narriflow/ui/components/button";
import { CodeBlock } from "@narriflow/ui/components/code-block";
import { CloseButton, Dialog, Portal } from "@narriflow/ui/components/dialog";
import { Spinner } from "@narriflow/ui/components/spinner";
import { Switch } from "@narriflow/ui/components/switch";
import { useApiRuntime } from "@/app/_components/api-provider";
import { developerFailureMessage } from "./failure-message";

const WRITE_SCOPES = [
  { scope: "processing:write", label: "Import and clip", description: "Import links, upload files and generate clips", icon: Scissors },
  { scope: "exports:write", label: "Export", description: "Request clip exports", icon: Download },
  { scope: "autopilot:write", label: "Autopilot", description: "Create and run RSS rules", icon: Bot },
  { scope: "publishing:write", label: "Publishing", description: "Prepare, schedule and recover social posts", icon: Send },
] as const;

type WriteScope = (typeof WRITE_SCOPES)[number]["scope"];

export function CreateKeyDialog({ scope }: { scope: WorkspaceScope }) {
  const runtime = useApiRuntime();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [writes, setWrites] = useState<WriteScope[]>([]);
  // The key is shown once. It lives in this component alone: never in a query, a cache or a key.
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One idempotency intent per dialog: a retry after a lost response is the same request.
  // The mutation hands the secret straight to this state and returns nothing secret.
  const createKey = useMutation(useMemo(() => createApiKeyMutation(runtime, scope, setSecret), [runtime, scope]));
  const pending = createKey.isPending;

  function reset() {
    setName("");
    setWrites([]);
    setSecret(null);
    setError(null);
    createKey.reset();
  }

  function create(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError("Name the key so you can recognise it later.");
      return;
    }
    createKey.mutate(
      { name, scopes: [...WORKSPACE_API_KEY_READ_SCOPES, ...writes] },
      {
        onError: (failure) => setError(developerFailureMessage(failure, "The API key could not be created.")),
      },
    );
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(details) => {
        setOpen(details.open);
        if (!details.open) reset();
      }}
      placement="center"
      // The new key is shown once: don't let a stray click or Escape lose it.
      closeOnInteractOutside={!secret}
      closeOnEscape={!secret}
    >
      <Dialog.Trigger asChild>
        <Button size="sm">
          <Plus size={16} />
          Create key
        </Button>
      </Dialog.Trigger>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content asChild maxW="480px">
            <form onSubmit={create}>
              <Dialog.Header flexDirection="column" alignItems="flex-start" gap="1">
                <Dialog.Title>{secret ? "Copy your key" : "Create API key"}</Dialog.Title>
                <Text fontSize="13px" color="fg.muted">
                  {secret ? "This is the only time it's shown." : "Give it a name and only the access it needs."}
                </Text>
              </Dialog.Header>
              <Dialog.Body>
                {secret ? (
                  <Stack gap="4">
                    <Flex align="center" gap="3" px="4" py="3" borderRadius="l2" bg="accent.subtle" color="accent.fg">
                      <CheckCircle2 size={18} />
                      <Text fontSize="13.5px" fontWeight="500">
                        Key created. You won't see this key again.
                      </Text>
                    </Flex>
                    <CodeBlock code={secret} copyLabel="Copy key" />
                  </Stack>
                ) : (
                  <Stack gap="6">
                    <Field.Root required invalid={Boolean(error) && !name.trim()}>
                      <Field.Label>Name</Field.Label>
                      <Input value={name} onChange={(event) => { setName(event.target.value); if (error) setError(null); }} placeholder="e.g. n8n production" maxLength={80} autoFocus />
                    </Field.Root>
                    <Stack gap="2.5">
                      <Flex align="baseline" justify="space-between" gap="3">
                        <Text fontSize="14px" fontWeight="500">
                          Permissions
                        </Text>
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          onClick={() => setWrites(writes.length === WRITE_SCOPES.length ? [] : WRITE_SCOPES.map((item) => item.scope))}
                        >
                          {writes.length === WRITE_SCOPES.length ? "Clear all" : "Select all"}
                        </Button>
                      </Flex>
                      <Flex align="center" gap="3" px="3.5" py="3" borderRadius="l2" bg="bg.soft">
                        <PermissionIcon><Eye size={15} /></PermissionIcon>
                        <Stack gap="0.5" flex="1" minW="0">
                          <Text fontSize="14px">Read</Text>
                          <Text fontSize="12.5px" color="fg.muted">Projects, exports, usage, Autopilot and publishing.</Text>
                        </Stack>
                        <Text fontSize="12px" color="fg.subtle" fontWeight="500">Always on</Text>
                      </Flex>
                      {WRITE_SCOPES.map(({ scope, label, description, icon: Icon }) => {
                        const on = writes.includes(scope);
                        return (
                          <Box key={scope} px="3.5" py="3" borderRadius="l2" bg={on ? "accent.subtle" : "bg.soft"} transition="background 120ms ease">
                            <Switch
                              checked={on}
                              onCheckedChange={(checked) =>
                                setWrites((current) => (checked ? [...current, scope] : current.filter((item) => item !== scope)))
                              }
                              justifyContent="space-between"
                              flexDirection="row-reverse"
                              w="full"
                            >
                              <Flex as="span" align="center" gap="3" minW="0">
                                <PermissionIcon active={on}><Icon size={15} /></PermissionIcon>
                                <Stack as="span" gap="0.5" lineHeight="1.4" minW="0">
                                  <Text as="span" fontSize="14px">
                                    {label}
                                  </Text>
                                  <Text as="span" fontSize="12.5px" color="fg.muted">
                                    {description}
                                  </Text>
                                </Stack>
                              </Flex>
                            </Switch>
                          </Box>
                        );
                      })}
                    </Stack>
                    {error ? (
                      <Text fontSize="13px" color="danger.fg">
                        {error}
                      </Text>
                    ) : null}
                  </Stack>
                )}
              </Dialog.Body>
              <Dialog.Footer>
                {secret ? (
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => {
                      setOpen(false);
                      reset();
                    }}
                  >
                    Done
                  </Button>
                ) : (
                  <>
                    <Dialog.ActionTrigger asChild>
                      <Button type="button" size="sm" variant="subtle">
                        Cancel
                      </Button>
                    </Dialog.ActionTrigger>
                    <Button type="submit" size="sm" disabled={pending}>
                      {pending ? <Spinner size="xs" /> : null}
                      Create key
                    </Button>
                  </>
                )}
              </Dialog.Footer>
              <Dialog.CloseTrigger asChild>
                <CloseButton size="sm" />
              </Dialog.CloseTrigger>
            </form>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function PermissionIcon({ active = false, children }: { active?: boolean; children: React.ReactNode }) {
  return (
    <Flex as="span" boxSize="8" flexShrink={0} align="center" justify="center" borderRadius="8px" bg={active ? "accent.muted" : "bg.soft"} color={active ? "accent.fg" : "fg.muted"} aria-hidden>
      {children}
    </Flex>
  );
}
