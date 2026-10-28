"use client";

import { useMemo, useState } from "react";
import { Box, Flex, Image, Input, Stack, Text } from "@chakra-ui/react";
import type { WorkspaceScope } from "@narriflow/api-client";
import { presignAvatarMutation, setAvatarMutation } from "@narriflow/api-client/workspace";
import { useMutation } from "@tanstack/react-query";
import { Building2, Trash2, Upload } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Spinner } from "@narriflow/ui/components/spinner";
import { useApiRuntime } from "@/app/_components/api-provider";
import { apiErrorMessage } from "@/app/_components/query-mutation-form";

export function WorkspaceAvatarControl({
  scope,
  avatarUrl,
  workspaceName,
  canManage,
}: {
  scope: WorkspaceScope;
  avatarUrl: string | null;
  workspaceName: string;
  canManage: boolean;
}) {
  const runtime = useApiRuntime();
  const [feedback, setFeedback] = useState<string | null>(null);
  const presign = useMutation(useMemo(() => presignAvatarMutation(runtime, scope), [runtime, scope]));
  const setAvatar = useMutation(useMemo(() => setAvatarMutation(runtime, scope), [runtime, scope]));
  const [uploading, setUploading] = useState(false);
  const pending = uploading || presign.isPending || setAvatar.isPending;

  // Choosing a file uploads it: one control for the job.
  async function upload(file: File) {
    setFeedback(null);
    setUploading(true);
    try {
      const signed = await presign.mutateAsync({ contentType: file.type, sizeBytes: file.size });
      // Straight to storage: the upload URL is the credential, so no session token goes along.
      const stored = await fetch(signed.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": signed.contentType },
        body: file,
        credentials: "omit",
      });
      if (!stored.ok) throw new Error("Could not upload the avatar image");
      await setAvatar.mutateAsync(signed.key);
      setFeedback("Workspace avatar updated.");
    } catch (error) {
      setFeedback(apiErrorMessage(error, "Avatar upload failed"));
    } finally {
      setUploading(false);
    }
  }

  function remove() {
    setFeedback(null);
    setAvatar.mutate(null, {
      onError: (error) => setFeedback(apiErrorMessage(error, "Could not remove the workspace avatar.")),
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
