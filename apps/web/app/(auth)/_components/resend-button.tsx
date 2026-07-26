"use client";

import { useEffect, useState } from "react";
import { Flex, Text } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { Spinner } from "@narriflow/ui/components/spinner";

const RESEND_COOLDOWN_SECONDS = 30;

interface ResendButtonProps {
  /** Sends a fresh code. Return true on success to restart the cooldown. */
  onResend: () => Promise<boolean>;
  disabled?: boolean;
}

/**
 * Resend-code button with a mono countdown and a "new code sent"
 * confirmation micro-state (aria-live so the feedback is announced).
 */
export function ResendButton({ onResend, disabled }: ResendButtonProps) {
  // A code was just sent when this mounts, so start on cooldown.
  const [remaining, setRemaining] = useState(RESEND_COOLDOWN_SECONDS);
  const [sending, setSending] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (remaining <= 0) return;
    const timer = setInterval(() => {
      setRemaining((current) => (current > 0 ? current - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [remaining]);

  async function handleResend() {
    if (sending || remaining > 0) return;
    setSending(true);
    setConfirmed(false);
    try {
      const ok = await onResend();
      if (ok) {
        setRemaining(RESEND_COOLDOWN_SECONDS);
        setConfirmed(true);
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <Flex align="center" justify="center" gap="2" minH="8">
      {remaining > 0 ? (
        // Quiet mono countdown — not a disabled control, just a timer.
        <Text textStyle="data" fontSize="12px" color="fg.subtle">
          Resend code in {remaining}s
        </Text>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={disabled || sending}
          onClick={handleResend}
        >
          {sending ? (
            <>
              <Spinner size="xs" />
              Sending…
            </>
          ) : (
            "Resend code"
          )}
        </Button>
      )}
      <Text aria-live="polite" fontSize="12px" color="success.fg">
        {confirmed ? "New code sent" : ""}
      </Text>
    </Flex>
  );
}
