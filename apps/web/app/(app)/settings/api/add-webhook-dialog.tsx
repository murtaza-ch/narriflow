"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Field, Input, Stack, Text } from "@chakra-ui/react";
import { Plus } from "lucide-react";
import { WORKSPACE_EVENT_TYPES, type WorkspaceEventType } from "@narriflow/validators";
import { Button } from "@narriflow/ui/components/button";
import { CloseButton, Dialog, Portal } from "@narriflow/ui/components/dialog";
import { Spinner } from "@narriflow/ui/components/spinner";
import { Switch } from "@narriflow/ui/components/switch";
import { authenticatedActionResultMessage } from "@/lib/authenticated-request-browser";
import { createWebhookAction } from "../actions";

export const EVENT_LABELS: Record<WorkspaceEventType, { label: string; description: string }> = {
  "operation.finished": { label: "Work finished", description: "An import, clip generation or export reached its final state" },
  "autopilot.episode_imported": { label: "Autopilot imports", description: "A rule imported a new episode" },
  "finishing.finished": { label: "Finishing", description: "Narriflow exported a generation's best clips and wrote their copy" },
  "social_post.proposed": { label: "Queue proposals", description: "A post was proposed to a publishing queue and waits for someone to accept it" },
  "social_post.finished": { label: "Post outcomes", description: "A social post was published, sent to an inbox or failed" },
  "grant.paused": { label: "Grants paused", description: "A standing grant paused, because a post it accepted failed or a person paused it" },
  "grant.expired": { label: "Grants expired", description: "A standing grant reached its expiry and stopped" },
};

export function AddWebhookDialog({ disabledReason }: { disabledReason: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [types, setTypes] = useState<WorkspaceEventType[]>(["operation.finished"]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function reset() {
    setUrl("");
    setTypes(["operation.finished"]);
    setError(null);
  }

  function create(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createWebhookAction({ url: url.trim(), types });
      if (!result.ok) {
        setError(authenticatedActionResultMessage(result, "The webhook could not be created."));
        return;
      }
      setOpen(false);
      reset();
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
    >
      <Dialog.Trigger asChild>
        <Button size="sm" disabled={Boolean(disabledReason)} title={disabledReason ?? undefined}>
          <Plus size={16} />
          Add webhook
        </Button>
      </Dialog.Trigger>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content asChild maxW="480px">
            <form onSubmit={create}>
              <Dialog.Header>
                <Dialog.Title>Add webhook</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <Stack gap="5">
                  <Field.Root required>
                    <Field.Label>Endpoint URL</Field.Label>
                    <Input
                      type="url"
                      value={url}
                      onChange={(event) => setUrl(event.target.value)}
                      placeholder="https://hooks.example.com/narriflow"
                      maxLength={2048}
                      required
                    />
                    <Field.HelperText>Public HTTPS on port 443. Events are signed with your callback signing secret.</Field.HelperText>
                  </Field.Root>
                  <Stack gap="4">
                    <Text fontSize="14px" fontWeight="500">
                      Events
                    </Text>
                    {WORKSPACE_EVENT_TYPES.map((type) => (
                      <Switch
                        key={type}
                        checked={types.includes(type)}
                        onCheckedChange={(checked) =>
                          setTypes((current) => (checked ? [...current, type] : current.filter((item) => item !== type)))
                        }
                        justifyContent="space-between"
                        flexDirection="row-reverse"
                        w="full"
                      >
                        <Stack as="span" gap="0.5" lineHeight="1.4">
                          <Text as="span" fontSize="14px">
                            {EVENT_LABELS[type].label}
                          </Text>
                          <Text as="span" fontSize="13px" color="fg.muted">
                            {EVENT_LABELS[type].description}
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
              </Dialog.Body>
              <Dialog.Footer>
                <Dialog.ActionTrigger asChild>
                  <Button type="button" size="sm" variant="subtle">
                    Cancel
                  </Button>
                </Dialog.ActionTrigger>
                <Button type="submit" size="sm" disabled={pending || !url.trim() || types.length === 0}>
                  {pending ? <Spinner size="xs" /> : null}
                  Add webhook
                </Button>
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
