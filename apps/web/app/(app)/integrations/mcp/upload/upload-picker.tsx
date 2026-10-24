"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { Field, Flex, Input, Stack, Text } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { type OpenUploadSessionInput } from "@narriflow/validators";
import { createUploadSessionBrowserAdapter } from "../../../upload/_lib/upload-session-browser";
import { UploadSessionStatusPanel } from "../../../upload/_components/upload-session-status";

/** `resumeOnly` serves an expired handoff: it can find and finish this person's
 * existing Upload Session, but never asks the server to open a new one. */
export function McpUploadPicker(props: { token: string; workspaceId: string; clientIdempotencyKey: string; title?: string; brandProfileId?: string; recipeId?: string; resumeOnly: boolean; generationContext: OpenUploadSessionInput["generationContext"] }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const adapter = useMemo(() => createUploadSessionBrowserAdapter({
    storage: typeof window === "undefined" ? null : {
      getItem: (key) => window.localStorage.getItem(`mcp:${props.workspaceId}:${props.clientIdempotencyKey}:${key}`),
      setItem: (key, value) => window.localStorage.setItem(`mcp:${props.workspaceId}:${props.clientIdempotencyKey}:${key}`, value),
      removeItem: (key) => window.localStorage.removeItem(`mcp:${props.workspaceId}:${props.clientIdempotencyKey}:${key}`),
    },
    createClientKey: () => props.clientIdempotencyKey,
    navigate: (projectId) => router.push(`/projects/${projectId}`),
    fetcher: (input, init) => {
      const path = String(input);
      if (!path.startsWith("/api/upload-sessions/")) return fetch(input, init);
      const headers = new Headers(init?.headers);
      headers.set("X-Narriflow-Upload-Intent", props.token);
      let action = path.split("/").at(-1);
      let body = init?.body;
      if (props.resumeOnly && action === "open" && typeof body === "string") {
        const opening = JSON.parse(body) as { clientIdempotencyKey: string; source: { browserFingerprint: string } };
        action = "status";
        body = JSON.stringify({ clientIdempotencyKey: opening.clientIdempotencyKey, sessionId: null, browserFingerprint: opening.source.browserFingerprint });
      }
      return fetch(`/mcp/integrations/${props.workspaceId}/upload-sessions/${action}`, { ...init, body, headers, credentials: "same-origin", redirect: "error" });
    },
  }), [props.workspaceId, props.clientIdempotencyKey, props.token, props.resumeOnly, router]);
  const snapshot = useSyncExternalStore(adapter.subscribe, adapter.snapshot, adapter.snapshot);
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
  return <Stack gap="5"><Field.Root><Field.Label>Video or audio file</Field.Label><Input type="file" accept="video/*,audio/*" disabled={busy} onChange={(event) => setFile(event.target.files?.[0] ?? null)} /><Field.HelperText>Choose the same file to resume an interrupted upload.</Field.HelperText></Field.Root><Flex gap="3" wrap="wrap"><Button disabled={!file || busy} onClick={() => file && adapter.start({ file, title: props.title ?? file.name, brandTemplateId: null, brandProfileId: props.brandProfileId, recipeId: props.recipeId, generationContext: props.generationContext })}>{snapshot.canResume ? "Resume upload" : "Upload and generate clips"}</Button>{snapshot.canPause ? <Button variant="subtle" onClick={() => adapter.pause()}>Pause upload</Button> : null}{snapshot.canDiscard ? <Button variant="subtle" onClick={() => adapter.discard()}>Discard upload</Button> : null}</Flex>{snapshot.phase !== "idle" ? <UploadSessionStatusPanel snapshot={snapshot} statusRef={statusRef} /> : <Text fontSize="13px" color="fg.muted">You can return to your assistant once Narriflow has received the file.</Text>}</Stack>;
}
