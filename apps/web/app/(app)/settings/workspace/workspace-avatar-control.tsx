"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Box, Flex, Image, Input, Stack, Text } from "@chakra-ui/react";
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
  const [feedback, setFeedback] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Choosing a file uploads it: one control for the job.
  function upload(file: File) {
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
    <Stack gap="2.5" align={{ base: "flex-start", md: "center" }} flexShrink={0}>
      <Box
        as={canManage ? "label" : "div"}
        position="relative"
        boxSize="24"
        borderRadius="l3"
        overflow="hidden"
        bg="bg.soft"
        color="fg.muted"
        cursor={canManage && !pending ? "pointer" : "default"}
        className="group"
        aria-label={canManage ? "Change workspace avatar" : undefined}
      >
        {canManage ? (
          <Input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            srOnly
            disabled={pending}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.currentTarget.value = "";
              if (file) upload(file);
            }}
          />
        ) : null}
        <Flex w="full" h="full" align="center" justify="center">
          {avatarUrl ? <Image src={avatarUrl} alt={`${workspaceName} avatar`} w="full" h="full" objectFit="cover" /> : <Building2 size={28} />}
        </Flex>
        {canManage ? (
          <Flex
            position="absolute"
            inset="0"
            align="center"
            justify="center"
            direction="column"
            gap="1"
            bg="studio.scrim"
            color="studio.fg"
            fontSize="12px"
            fontWeight="500"
            opacity={pending ? 1 : 0}
            transition="opacity 150ms ease"
            _groupHover={{ opacity: 1 }}
          >
            {pending ? <Spinner size="sm" /> : <Upload size={16} />}
            {pending ? "Uploading" : avatarUrl ? "Change" : "Upload"}
          </Flex>
        ) : null}
      </Box>
      {canManage && avatarUrl ? (
        <Button type="button" size="xs" variant="ghost" onClick={remove} disabled={pending}><Trash2 size={12} />Remove</Button>
      ) : canManage ? (
        <Text fontSize="11.5px" color="fg.subtle" textAlign="center" maxW="24">JPG, PNG or WebP, up to 5 MB</Text>
      ) : null}
      {feedback ? <Text fontSize="12px" color="fg.muted" maxW="40" textAlign={{ md: "center" }}>{feedback}</Text> : null}
    </Stack>
  );
}
