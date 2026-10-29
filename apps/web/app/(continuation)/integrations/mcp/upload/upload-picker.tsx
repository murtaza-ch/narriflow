"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { Field, Flex, Input, Stack, Text } from "@chakra-ui/react";
import { createMcpUploadControls } from "@narriflow/api-client/integrations";
import { invalidateAfterIntake } from "@narriflow/api-client/ingest";
import { sessionBootstrapQuery } from "@narriflow/api-client/session";
import { useQuery } from "@tanstack/react-query";
import { useApiRuntime, useIdentityScope } from "@/app/_components/api-provider";
import { Button } from "@narriflow/ui/components/button";
import { type OpenUploadSessionInput, workspaceAllowsCapability } from "@narriflow/validators";
import { upgradeHref } from "@/app/(app)/_components/upgrade";
import { WorkspaceBillingLink } from "@/app/(app)/integrations/mcp/workspace-billing-link";
import { createUploadSessionBrowserAdapter } from "@/app/(app)/upload/_lib/upload-session-browser";
import { UploadSessionStatusPanel } from "@/app/(app)/upload/_components/upload-session-status";

/** `resumeOnly` serves an expired handoff: it can find and finish this person's
 * existing Upload Session, but never asks the server to open a new one. */
export function McpUploadPicker(props: { token: string; workspaceId: string; clientIdempotencyKey: string; title?: string; brandProfileId?: string; recipeId?: string; resumeOnly: boolean; generationContext: OpenUploadSessionInput["generationContext"] }) {
  const router = useRouter();
  const runtime = useApiRuntime();
  const identity = useIdentityScope();
  if (!identity) return null;
  return <UploadPicker key={`${identity.userId}:${props.workspaceId}:${props.clientIdempotencyKey}`} {...props} identity={identity} runtime={runtime} router={router} />;
}

function UploadPicker(props: Parameters<typeof McpUploadPicker>[0] & { identity: NonNullable<ReturnType<typeof useIdentityScope>>; runtime: ReturnType<typeof useApiRuntime>; router: ReturnType<typeof useRouter> }) {
  const { identity, runtime, router } = props;
  const [file, setFile] = useState<File | null>(null);
  const [resumeOnly] = useState(props.resumeOnly);
  const statusRef = useRef<HTMLDivElement>(null);
  const adapter = useMemo(() => createUploadSessionBrowserAdapter({
    storage: typeof window === "undefined" ? null : {
      getItem: (key) => window.localStorage.getItem(`mcp:${props.workspaceId}:${props.clientIdempotencyKey}:${key}`),
      setItem: (key, value) => window.localStorage.setItem(`mcp:${props.workspaceId}:${props.clientIdempotencyKey}:${key}`, value),
      removeItem: (key) => window.localStorage.removeItem(`mcp:${props.workspaceId}:${props.clientIdempotencyKey}:${key}`),
    },
    createClientKey: () => props.clientIdempotencyKey,
    navigate: (projectId) => {
      void invalidateAfterIntake(runtime.queryClient, { ...identity, workspaceId: props.workspaceId });
      router.push(`/projects/${projectId}`);
    },
    controls: createMcpUploadControls({ transport: runtime.transport, scope: identity, workspaceId: props.workspaceId, token: props.token, resumeOnly }),
  }), [props.workspaceId, props.clientIdempotencyKey, props.token, resumeOnly, router, runtime, identity]);
  const snapshot = useSyncExternalStore(adapter.subscribe, adapter.snapshot, adapter.snapshot);
  const session = useQuery({ ...sessionBootstrapQuery(runtime.transport, identity), enabled: snapshot.upgrade !== null });
  const workspace = session.data?.memberships.find((member) => member.id === props.workspaceId);
  const lifetime = useMemo(() => ({ adapter, mountedEffects: 0 }), [adapter]);
  useEffect(() => {
    lifetime.mountedEffects++;
    return () => {
      lifetime.mountedEffects--;
      // React's development replay remounts effects before the microtask runs.
      queueMicrotask(() => { if (lifetime.mountedEffects === 0) lifetime.adapter.dispose(); });
    };
  }, [lifetime]);
  useEffect(() => {
    const preventUnload = (event: BeforeUnloadEvent) => { if (adapter.shouldConfirmUnload()) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", preventUnload);
    return () => window.removeEventListener("beforeunload", preventUnload);
  }, [adapter]);
  const busy = snapshot.phase === "preparing" || snapshot.phase === "uploading" || snapshot.phase === "verifying";
  return (
    <Stack gap="5">
      <Field.Root>
        <Field.Label>Video or audio file</Field.Label>
        <Input type="file" accept="video/*,audio/*" disabled={busy} onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
        <Field.HelperText>Choose the same file to resume an interrupted upload.</Field.HelperText>
      </Field.Root>
      <Flex gap="3" wrap="wrap">
        <Button disabled={!file || busy} onClick={() => file && adapter.start({ file, title: props.title ?? file.name, brandTemplateId: null, brandProfileId: props.brandProfileId, recipeId: props.recipeId, generationContext: props.generationContext })}>
          {snapshot.canResume ? "Resume upload" : "Upload and generate clips"}
        </Button>
        {snapshot.canPause ? <Button variant="subtle" onClick={() => adapter.pause()}>Pause upload</Button> : null}
        {snapshot.canDiscard ? <Button variant="subtle" onClick={() => adapter.discard()}>Discard upload</Button> : null}
      </Flex>
      {snapshot.phase !== "idle" ? (
        <UploadSessionStatusPanel snapshot={{ ...snapshot, upgrade: null }} statusRef={statusRef} />
      ) : (
        <Text fontSize="13px" color="fg.muted">You can return to your assistant once Narriflow has received the file.</Text>
      )}
      {snapshot.upgrade ? workspace && workspaceAllowsCapability(workspace, "billing.manage") ? (
        <WorkspaceBillingLink workspaceId={props.workspaceId} href={upgradeHref(snapshot.upgrade.tier)}>See plans</WorkspaceBillingLink>
      ) : (
        <Text fontSize="13px" color="fg.muted">Ask the workspace owner to upgrade.</Text>
      ) : null}
    </Stack>
  );
}
