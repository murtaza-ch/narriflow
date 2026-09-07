"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Flex, Image, Input, Stack, Text } from "@chakra-ui/react";
import { Building2, Trash2, Upload } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Spinner } from "@narriflow/ui/components/spinner";

export function WorkspaceAvatarControl({
  avatarUrl,
  workspaceName,
  canManage,
}: {
  avatarUrl: string | null;
  workspaceName: string;
  canManage: boolean;
}) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function upload() {
    if (!file) return;
    setFeedback(null);
    startTransition(async () => {
      try {
        const presign = await fetch("/api/workspace/avatar/presign", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contentType: file.type, sizeBytes: file.size }),
        });
        const signed = (await presign.json()) as { key?: string; uploadUrl?: string; contentType?: string; message?: string };
        if (!presign.ok || !signed.key || !signed.uploadUrl || !signed.contentType) throw new Error(signed.message ?? "Could not prepare avatar upload");
        const stored = await fetch(signed.uploadUrl, { method: "PUT", headers: { "Content-Type": signed.contentType }, body: file });
        if (!stored.ok) throw new Error("Could not upload the avatar image");
        const saved = await fetch("/api/workspace/avatar", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ storageKey: signed.key }) });
        if (!saved.ok) {
          const body = (await saved.json()) as { message?: string };
          throw new Error(body.message ?? "Could not save the workspace avatar");
        }
        setFile(null);
        setFeedback("Workspace avatar updated.");
        router.refresh();
      } catch (error) {
        setFeedback(error instanceof Error ? error.message : "Avatar upload failed");
      }
    });
  }

  function remove() {
    setFeedback(null);
    startTransition(async () => {
      const response = await fetch("/api/workspace/avatar", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ storageKey: null }) });
      if (!response.ok) return setFeedback("Could not remove the workspace avatar.");
      router.refresh();
    });
  }

  return (
    <Stack gap="3" bg="bg.panel" borderWidth="1px" borderColor="border" borderRadius="l2" p={{ base: "5", md: "6" }}>
      <Text fontSize="13px" fontWeight="600">Workspace avatar</Text>
      <Flex align="center" gap="4" wrap="wrap">
        <Flex w="16" h="16" align="center" justify="center" overflow="hidden" borderRadius="l2" bg="bg.muted" color="fg.muted" borderWidth="1px" borderColor="border">
          {avatarUrl ? <Image src={avatarUrl} alt={`${workspaceName} avatar`} w="full" h="full" objectFit="cover" /> : <Building2 size={24} />}
        </Flex>
        {canManage ? <Stack gap="2" flex="1" minW="0" w={{ base: "full", md: "auto" }}><Input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /><Flex gap="2"><Button type="button" size="sm" variant="outline" onClick={upload} disabled={!file || pending}>{pending ? <Spinner size="xs" /> : <Upload size={13} />}Upload</Button>{avatarUrl ? <Button type="button" size="sm" variant="ghost" onClick={remove} disabled={pending}><Trash2 size={13} />Remove</Button> : null}</Flex></Stack> : null}
      </Flex>
      <Text fontSize="11px" color="fg.subtle">JPG, PNG, or WebP · maximum 5 MB.</Text>
      {feedback ? <Text fontSize="12px" color="fg.muted">{feedback}</Text> : null}
    </Stack>
  );
}
