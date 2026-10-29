"use client";

import { useEffect, useRef, useState } from "react";
import { useReverification, useSession, useUser } from "@clerk/nextjs";
import { isReverificationCancelledError } from "@clerk/nextjs/errors";
import { Box, Dialog, Flex, Portal, Stack, Text } from "@chakra-ui/react";
import { Fingerprint, KeyRound, X } from "lucide-react";
import { Button, IconButton } from "@narriflow/ui/components/button";
import { Input } from "@narriflow/ui/components/input";
import { Label } from "@narriflow/ui/components/label";
import { useOpenAfterMount } from "@narriflow/ui/components/use-open-after-mount";
import { supportsPasskeys } from "@/lib/auth-flow";
import { PasswordInput } from "@/app/_components/auth/password-input";
import { FormError } from "@/app/_components/auth/form-error";
import { getClerkErrorMessage } from "@/app/_components/auth/clerk-error";
import { SettingsCard } from "../_components/settings-ui";

type VerificationRequest = {
  level: "first_factor" | "second_factor" | "multi_factor";
  complete: () => void;
  cancel: () => void;
};
type Passkey = NonNullable<ReturnType<typeof useUser>["user"]>["passkeys"][number];

export function PasskeySettings() {
  const { user, isLoaded } = useUser();
  const [supported, setSupported] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [verification, setVerification] = useState<VerificationRequest | null>(null);
  const busy = useRef(false);
  useEffect(() => { setSupported(supportsPasskeys()); }, []);
  const verifiedAction = useReverification((operation: () => Promise<unknown>) => operation(), {
    onNeedsReverification: (request) => setVerification({ ...request, level: request.level ?? "first_factor" }),
  });

  async function perform(operation: () => Promise<unknown>, success: string) {
    if (busy.current || !user) return;
    busy.current = true;
    setPending(true);
    setError(null);
    setNotice("");
    try {
      await verifiedAction(operation);
      await user.reload();
      setNotice(success);
    } catch (failure) {
      if (isReverificationCancelledError(failure)) setNotice("Verification cancelled. Your passkeys haven’t changed.");
      else setError(getClerkErrorMessage(failure, "The passkey action couldn’t finish. Try again or cancel the device prompt."));
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  const addButton = supported ? (
    <Button size="sm" disabled={!isLoaded || pending} loading={pending} onClick={() => perform(() => user!.createPasskey(), "Passkey added. You can now use it to sign in on this site.")}>
      <KeyRound size={14} />
      Add a passkey
    </Button>
  ) : null;
  return <>
    <SettingsCard icon={<KeyRound size={16} />} title="Passkeys" description="Sign in with your fingerprint, face, or device PIN. Optional." action={addButton}>
      <FormError message={error} />
      {notice ? <Text role="status" fontSize="13px" color="fg.muted">{notice}</Text> : <Text role="status" srOnly>{notice}</Text>}
      {isLoaded && !user?.passkeys.length ? (
        <Flex align="center" gap="3" px="4" py="3.5" borderRadius="l2" bg="bg.soft">
          <Box color="fg.muted"><Fingerprint size={18} /></Box>
          <Text fontSize="13px" color="fg.muted">
            {supported ? "No passkeys yet. Add one to sign in without a password." : "Use a browser that supports passkeys to add one. Your other sign-in methods are available."}
          </Text>
        </Flex>
      ) : null}
      {user?.passkeys.length ? (
        <Stack gap="2">
          {user.passkeys.map((passkey) => <PasskeyRow key={passkey.id} passkey={passkey} disabled={pending} onRename={(name) => perform(() => passkey.update({ name }), "Passkey renamed.")} onRemove={() => perform(() => passkey.delete(), "Passkey removed.")} />)}
        </Stack>
      ) : null}
    </SettingsCard>
    {verification && <ReverificationDialog request={verification} onClose={() => setVerification(null)} />}
  </>;
}

function PasskeyRow({ passkey, disabled, onRename, onRemove }: {
  passkey: Passkey;
  disabled: boolean;
  onRename: (name: string) => void;
  onRemove: () => void;
}) {
  const [name, setName] = useState(passkey.name ?? "Passkey");
  const changed = Boolean(name.trim()) && name.trim() !== passkey.name;
  return <Flex align="center" gap="3" px="3" py="2.5" borderRadius="l2" bg="bg.soft" wrap="wrap">
    <Flex boxSize="8" flexShrink={0} align="center" justify="center" borderRadius="8px" bg="bg.soft" color="fg.muted" aria-hidden><Fingerprint size={15} /></Flex>
    <Stack gap="0" flex="1" minW="160px">
      <Label htmlFor={`passkey-${passkey.id}`} srOnly>Passkey name</Label>
      <Input id={`passkey-${passkey.id}`} value={name} maxLength={64} onChange={(e) => setName(e.target.value)} disabled={disabled} size="sm" bg="transparent" px="1.5" fontWeight="500" _hover={{ bg: "bg.soft" }} />
      <Text fontSize="12px" color="fg.subtle" px="1.5">{passkey.lastUsedAt ? `Last used ${passkey.lastUsedAt.toLocaleDateString()}` : `Added ${passkey.createdAt.toLocaleDateString()}`}</Text>
    </Stack>
    {changed ? <Button size="sm" variant="subtle" disabled={disabled} onClick={() => onRename(name.trim())}>Save name</Button> : null}
    <Button size="sm" variant="ghost" disabled={disabled} onClick={onRemove}>Remove</Button>
  </Flex>;
}

function ReverificationDialog({ request, onClose }: { request: VerificationRequest; onClose: () => void }) {
  const { session } = useSession();
  const [method, setMethod] = useState<"password" | "email_code" | null>(null);
  const [canUsePasskey, setCanUsePasskey] = useState(false);
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const busy = useRef(false);
  const cancel = () => { request.cancel(); onClose(); };

  useEffect(() => {
    if (!session || started.current) return;
    started.current = true;
    void (async () => {
      setPending(true);
      try {
        const verification = await session.startVerification({ level: request.level });
        if (verification.status === "complete") { request.complete(); onClose(); return; }
        const factors = verification.supportedFirstFactors ?? [];
        setCanUsePasskey(supportsPasskeys() && factors.some((f) => f.strategy === "passkey"));
        if (factors.some((f) => f.strategy === "password")) setMethod("password");
        else {
          const email = factors.find((f) => f.strategy === "email_code");
          if (email?.strategy !== "email_code") throw new Error("Choose a passkey to verify your account.");
          await session.prepareFirstFactorVerification({ strategy: "email_code", emailAddressId: email.emailAddressId });
          setMethod("email_code");
        }
      } catch (failure) { setError(getClerkErrorMessage(failure, "Verification couldn't start. Try again or cancel and reopen it.")); }
      finally { setPending(false); }
    })();
  }, [session, request, onClose]);

  async function verify(passkey = false) {
    if (!session || busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const result = passkey ? await session.verifyWithPasskey() : await session.attemptFirstFactorVerification(method === "password" ? { strategy: "password", password: value } : { strategy: "email_code", code: value });
      if (result.status !== "complete") throw new Error("Verification is incomplete. Please try again.");
      request.complete();
      onClose();
    } catch (failure) { setError(getClerkErrorMessage(failure, "Verification failed. Try again.")); }
    finally { busy.current = false; setPending(false); }
  }

  const open = useOpenAfterMount(true);
  return <Dialog.Root open={open} onOpenChange={({ open }) => { if (!open) cancel(); }} placement="center" scrollBehavior="inside">
    <Portal><Dialog.Backdrop /><Dialog.Positioner p="4"><Dialog.Content maxW="420px" bg="bg.panel" color="fg">
      <Dialog.CloseTrigger asChild><IconButton aria-label="Cancel verification" variant="ghost" borderRadius="full" boxSize="8" position="absolute" top="3" right="3"><X size={16} /></IconButton></Dialog.CloseTrigger>
      <Dialog.Header><Dialog.Title fontSize="18px" fontWeight="500">Verify it’s you</Dialog.Title></Dialog.Header>
      <Dialog.Body><Stack gap="4">
        <Dialog.Description color="fg.muted" fontSize="13px">Verify your account to change your passkeys.</Dialog.Description>
        <FormError message={error} />
        {method && <form id="account-verification-form" onSubmit={(e) => { e.preventDefault(); void verify(); }}><Stack gap="3">
          <Label htmlFor="account-verification">{method === "password" ? "Password" : "Email verification code"}</Label>
          {method === "password" ? <PasswordInput id="account-verification" autoComplete="current-password" value={value} required onChange={(e) => setValue(e.target.value)} disabled={pending} /> : <Input id="account-verification" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" value={value} required onChange={(e) => setValue(e.target.value)} disabled={pending} />}
        </Stack></form>}
        {canUsePasskey && <Button variant="subtle" disabled={pending} onClick={() => verify(true)}><KeyRound size={16} />Verify with a passkey</Button>}
        <Flex justify="flex-end" gap="2">
          <Dialog.ActionTrigger asChild><Button variant="subtle">Cancel</Button></Dialog.ActionTrigger>
          {method && <Button type="submit" form="account-verification-form" loading={pending}>Verify</Button>}
        </Flex>
      </Stack></Dialog.Body>
    </Dialog.Content></Dialog.Positioner></Portal>
  </Dialog.Root>;
}
