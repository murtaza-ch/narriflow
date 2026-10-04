"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { CloseButton, Dialog, Portal } from "@chakra-ui/react";
import { isAuthMode } from "@/lib/auth-entry";
import { AuthForm } from "./auth-form";

export function AuthModal() {
  const pathname = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const mode = params.get("auth");
  const active = pathname === "/" && isAuthMode(mode);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!active && returnFocus.current) {
      if (returnFocus.current.isConnected) returnFocus.current.focus();
      returnFocus.current = null;
    }
  }, [active]);
  if (!active || !isAuthMode(mode)) return null;
  if (!returnFocus.current && typeof document !== "undefined") {
    const focused = document.activeElement;
    returnFocus.current = focused instanceof HTMLElement && focused !== document.body
      ? focused
      : document.querySelector<HTMLElement>(`header a[href="/?auth=${mode === "sign-up" ? "sign-up" : "sign-in"}"]`);
  }

  function dismiss() {
    const next = new URLSearchParams(params.toString());
    next.delete("auth");
    next.delete("redirect_url");
    router.replace(next.size ? `/?${next}` : "/", { scroll: false });
  }

  return <Dialog.Root open onOpenChange={({ open }) => { if (!open) dismiss(); }} placement="center" scrollBehavior="inside" size="sm" restoreFocus finalFocusEl={() => returnFocus.current}>
    <Portal>
      <Dialog.Backdrop bg="blackAlpha.700" backdropFilter="blur(6px)" />
      <Dialog.Positioner p={{ base: "3", sm: "6" }}>
        <Dialog.Content bg="bg.panel" color="fg" borderColor="border" borderWidth="1px" borderRadius="xl" maxH="calc(100dvh - 24px)" boxShadow="2xl">
          <Dialog.CloseTrigger asChild><CloseButton aria-label="Close authentication" position="absolute" top="3" right="3" zIndex="1" /></Dialog.CloseTrigger>
          <Dialog.Body p={{ base: "6", sm: "8" }}>
            <AuthForm key={mode} mode={mode} destination={params.get("redirect_url")} />
          </Dialog.Body>
        </Dialog.Content>
      </Dialog.Positioner>
    </Portal>
  </Dialog.Root>;
}
