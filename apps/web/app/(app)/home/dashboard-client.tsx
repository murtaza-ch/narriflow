"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { ArrowRight, Link2 } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Input } from "@narriflow/ui/components/input";


const HERO_PASTE_LINK_HINT = "YouTube, Vimeo, and other supported video links or podcast feeds.";

/**
 * Hero paste-link field — no upload logic here. Navigates to
 * /upload?url=<encoded>, where the upload workspace auto-detects a
 * supported video link vs. an RSS feed and pre-fills the source.
 */
export function HeroPasteLinkField() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const trimmed = url.trim();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!trimmed) return;
    router.push(`/upload?url=${encodeURIComponent(trimmed)}`);
  }

  return (
    <Stack gap="2" w="full">
      {/* Attached control group: input + button share one boundary. */}
      <Flex asChild bg="bg.muted" borderWidth="1px" borderColor="border.emphasized" borderRadius="15px" p="2" ps="4" gap="3" align="center">
        <form onSubmit={submit}>
          <Box color="fg.subtle" flexShrink={0} display={{ base: "none", sm: "block" }}><Link2 size={18} /></Box>
          <Input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="Paste a video link…"
            fontSize="13px"
            aria-label="Video link"
            aria-describedby="hero-paste-link-hint"
            size="sm"
            flex="1"
            variant="flushed"
            borderWidth="0"
            bg="transparent"
            px="0"
            position="relative"
            _focusVisible={{ zIndex: 1 }}
          />
          <Button
            type="submit"
            size="sm"
            flexShrink={0}

            disabled={!trimmed}
          >
            Get clips <ArrowRight size={16} />
          </Button>
        </form>
      </Flex>
      <Text
        id="hero-paste-link-hint"
        srOnly

        fontSize="11.5px"
        color="fg.subtle"
      >
        {HERO_PASTE_LINK_HINT}
      </Text>
    </Stack>
  );
}
