"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Field, Input, Stack, Text } from "@chakra-ui/react";
import { Plus } from "lucide-react";
import { WORKSPACE_API_KEY_READ_SCOPES } from "@narriflow/validators";
import { Button } from "@narriflow/ui/components/button";
import { CodeBlock } from "@narriflow/ui/components/code-block";
import { CloseButton, Dialog, Portal } from "@narriflow/ui/components/dialog";
import { Spinner } from "@narriflow/ui/components/spinner";
import { Switch } from "@narriflow/ui/components/switch";
import { authenticatedActionResultMessage } from "@/lib/authenticated-request-browser";
import { createApiKeyAction } from "../actions";

const WRITE_SCOPES = [
  { scope: "processing:write", label: "Import and clip", description: "Import links, upload files and generate clips" },
  { scope: "exports:write", label: "Export", description: "Request clip exports" },
  { scope: "autopilot:write", label: "Autopilot", description: "Create and run RSS rules" },
  { scope: "publishing:write", label: "Publishing", description: "Prepare, schedule and recover social posts" },
] as const;

type WriteScope = (typeof WRITE_SCOPES)[number]["scope"];

export function CreateKeyDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [writes, setWrites] = useState<WriteScope[]>([]);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function reset() {
    setName("");
    setWrites([]);
    setSecret(null);
    setError(null);
  }

  function create(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createApiKeyAction({ name, scopes: [...WORKSPACE_API_KEY_READ_SCOPES, ...writes] });
      if (!result.ok) {
        setError(authenticatedActionResultMessage(result, "The API key could not be created."));
        return;
      }
      setSecret(result.key.secret);
      router.refresh();
    });
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
          <Dialog.Content asChild maxW="440px">
            <form onSubmit={create}>
              <Dialog.Header>
                <Dialog.Title>{secret ? "Copy your key" : "Create API key"}</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                {secret ? (
                  <Stack gap="3">
                    <Text fontSize="14px" color="fg.muted">
                      You won't see this key again.
                    </Text>
                    <CodeBlock code={secret} copyLabel="Copy key" />
                  </Stack>
                ) : (
                  <Stack gap="5">
                    <Field.Root required>
                      <Field.Label>Name</Field.Label>
                      <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. n8n production" maxLength={80} required />
                    </Field.Root>
                    <Stack gap="4">
                      <Stack gap="0.5">
                        <Text fontSize="14px" fontWeight="500">
                          Permissions
                        </Text>
                        <Text fontSize="13px" color="fg.muted">
                          Reads are always included.
                        </Text>
                      </Stack>
                      {WRITE_SCOPES.map(({ scope, label, description }) => (
                        <Switch
                          key={scope}
                          checked={writes.includes(scope)}
                          onCheckedChange={(checked) =>
                            setWrites((current) => (checked ? [...current, scope] : current.filter((item) => item !== scope)))
                          }
                          justifyContent="space-between"
                          flexDirection="row-reverse"
                          w="full"
                        >
                          <Stack as="span" gap="0.5" lineHeight="1.4">
                            <Text as="span" fontSize="14px">
                              {label}
                            </Text>
                            <Text as="span" fontSize="13px" color="fg.muted">
                              {description}
                            </Text>
                          </Stack>
                        </Switch>
                      ))}
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
                    <Button type="submit" size="sm" disabled={pending || !name.trim()}>
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
