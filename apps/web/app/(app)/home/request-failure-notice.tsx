"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Flex, Text } from "@chakra-ui/react";
import { Info, X } from "lucide-react";
import { IconButton } from "@narriflow/ui/components/button";
import { requestFailureNotice } from "@/lib/request-failure-notice";

/**
 * Why a member landed on Home: one calm, dismissible sentence from the
 * `requestFailure` the redirecting page set. The message is kept in state and
 * the parameters leave the URL, so a refresh does not show it again.
 */
export function HomeRequestNotice() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [message, setMessage] = useState(() => requestFailureNotice(params));

  useEffect(() => {
    const next = requestFailureNotice(params);
    if (!next) return;
    // A newer redirect replaces the notice rather than adding a second one.
    setMessage(next);
    router.replace(pathname, { scroll: false });
  }, [params, pathname, router]);

  if (!message) return null;
  return (
    <Flex role="status" align="center" gap="3" px="4" py="3" borderRadius="l3" bg="accent.subtle">
      <Flex color="accent.fg" flexShrink={0}>
        <Info size={16} aria-hidden />
      </Flex>
      <Text flex="1" fontSize="sm" color="fg">
        {message}
      </Text>
      <IconButton size="xs" variant="ghost" aria-label="Dismiss" onClick={() => setMessage(null)}>
        <X size={14} />
      </IconButton>
    </Flex>
  );
}
