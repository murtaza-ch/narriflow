"use client";

import { useEffect, useRef, useState } from "react";
import { useReverification, useSession, useUser } from "@clerk/nextjs";
import { isReverificationCancelledError } from "@clerk/nextjs/errors";
import { Box, CloseButton, Dialog, Flex, Portal, Stack, Text } from "@chakra-ui/react";
import { KeyRound } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Input } from "@narriflow/ui/components/input";
import { Label } from "@narriflow/ui/components/label";
import { supportsPasskeys } from "@/lib/auth-flow";
import { PasswordInput } from "@/app/_components/auth/password-input";
import { FormError } from "@/app/_components/auth/form-error";
import { getClerkErrorMessage } from "@/app/_components/auth/clerk-error";

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

  return <Box borderRadius="l2" bg="bg.panel" p={{ base: "4", md: "6" }}>
    <Stack gap="5">
      <Stack gap="1">
        <Text as="h2" fontSize="lg" fontWeight="600">Passkeys</Text>
        <Text fontSize="sm" color="fg.muted">Sign in with your fingerprint, face, or device PIN. Adding a passkey is optional.</Text>
      </Stack>
      <FormError message={error} />
      <Text role="status" fontSize="sm" color="fg.muted">{notice}</Text>
      {isLoaded && !user?.passkeys.length && <Text fontSize="sm" color="fg.muted">You haven’t added a passkey yet.</Text>}
      <Stack gap="3">
        {user?.passkeys.map((passkey) => <PasskeyRow key={passkey.id} passkey={passkey} disabled={pending} onRename={(name) => perform(() => passkey.update({ name }), "Passkey renamed.")} onRemove={() => perform(() => passkey.delete(), "Passkey removed.")} />)}
      </Stack>
      {supported ? <Button alignSelf="flex-start" disabled={!isLoaded || pending} loading={pending} onClick={() => perform(() => user!.createPasskey(), "Passkey added. You can now use it to sign in on this site.")}><KeyRound size={16} />Add a passkey</Button> : <Text fontSize="sm" color="fg.muted">Use a browser that supports passkeys to add one. Your other sign-in methods are available.</Text>}
    </Stack>
    {verification && <ReverificationDialog request={verification} onClose={() => setVerification(null)} />}
  </Box>;
}

function PasskeyRow({ passkey, disabled, onRename, onRemove }: {
  passkey: Passkey;
  disabled: boolean;
  onRename: (name: string) => void;
  onRemove: () => void;
}) {
  const [name, setName] = useState(passkey.name ?? "Passkey");
  return <Stack borderWidth="1px" borderColor="border" borderRadius="l2" p="4" gap="3">
    <Label htmlFor={`passkey-${passkey.id}`}>Passkey name</Label>
    <Flex gap="2" wrap="wrap">
      <Input id={`passkey-${passkey.id}`} value={name} maxLength={64} onChange={(e) => setName(e.target.value)} disabled={disabled} flex="1" minW="140px" />
      <Button variant="outline" disabled={disabled || !name.trim() || name.trim() === passkey.name} onClick={() => onRename(name.trim())}>Save name</Button>
      <Button variant="ghost" disabled={disabled} onClick={onRemove}>Remove</Button>
    </Flex>
    <Text fontSize="xs" color="fg.muted">{passkey.lastUsedAt ? `Last used ${passkey.lastUsedAt.toLocaleDateString()}` : `Added ${passkey.createdAt.toLocaleDateString()}`}</Text>
  </Stack>;
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

  return <Dialog.Root open onOpenChange={({ open }) => { if (!open) cancel(); }} placement="center" scrollBehavior="inside">
    <Portal><Dialog.Backdrop /><Dialog.Positioner p="4"><Dialog.Content maxW="420px" bg="bg.panel" color="fg">
      <Dialog.CloseTrigger asChild><CloseButton aria-label="Cancel verification" position="absolute" top="2" right="2" /></Dialog.CloseTrigger>
      <Dialog.Header><Dialog.Title>Verify it’s you</Dialog.Title></Dialog.Header>
      <Dialog.Body><Stack gap="4">
        <Dialog.Description color="fg.muted" fontSize="sm">Verify your account to change your passkeys.</Dialog.Description>
        <FormError message={error} />
        {method && <form onSubmit={(e) => { e.preventDefault(); void verify(); }}><Stack gap="3">
          <Label htmlFor="account-verification">{method === "password" ? "Password" : "Email verification code"}</Label>
          {method === "password" ? <PasswordInput id="account-verification" autoComplete="current-password" value={value} required onChange={(e) => setValue(e.target.value)} disabled={pending} /> : <Input id="account-verification" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" value={value} required onChange={(e) => setValue(e.target.value)} disabled={pending} />}
          <Button type="submit" loading={pending}>Verify</Button>
        </Stack></form>}
        {canUsePasskey && <Button variant="outline" disabled={pending} onClick={() => verify(true)}><KeyRound size={16} />Verify with a passkey</Button>}
        <Button variant="ghost" onClick={cancel}>Cancel</Button>
      </Stack></Dialog.Body>
    </Dialog.Content></Dialog.Positioner></Portal>
  </Dialog.Root>;
}
