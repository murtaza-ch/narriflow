"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Flex, Stack, Text } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { Input } from "@narriflow/ui/components/input";
import { toaster } from "@narriflow/ui/components/toaster";
import { LINK_PROVIDERS } from "@narriflow/validators";

const HERO_PASTE_LINK_HINT = `${LINK_PROVIDERS.map((p) => p.label).join(" · ")} — or a podcast RSS feed`;

/**
 * Fires the post-checkout success toast once, then strips `?upgraded=1`
 * from the URL so a refresh doesn't re-celebrate. Renders nothing —
 * the dashboard page stays a server component.
 */
export function UpgradedToast() {
  const router = useRouter();
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    toaster.create({
      type: "success",
      title: "You're upgraded",
      description: "Your new plan limits are active.",
    });
    router.replace("/dashboard", { scroll: false });
  }, [router]);

  return null;
}

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
      <Flex asChild>
        <form onSubmit={submit}>
          <Input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="Paste a video link…"
            aria-label="Video link"
            aria-describedby="hero-paste-link-hint"
            size="lg"
            h="12"
            flex="1"
            borderEndRadius="0"
            position="relative"
            _focusVisible={{ zIndex: 1 }}
          />
          <Button
            type="submit"
            size="lg"
            h="12"
            flexShrink={0}
            ms="-1px"
            borderStartRadius="0"
            disabled={!trimmed}
          >
            Get clips
          </Button>
        </form>
      </Flex>
      <Text
        id="hero-paste-link-hint"
        textStyle="data"
        fontSize="11.5px"
        color="fg.subtle"
      >
        {HERO_PASTE_LINK_HINT}
      </Text>
    </Stack>
  );
}
