"use client";

import { Box, Button, Flex, Heading, Input, Stack, Text, Textarea } from "@chakra-ui/react";
import { Check, MessageSquareText, ShieldCheck } from "lucide-react";
import { useState } from "react";

type ReviewSnapshot = {
  id: string;
  title: string;
  message: string | null;
  revision: number;
  status: string;
  allowDownloads: boolean;
  approvalRequired: boolean;
  reviewer: string;
  items: Array<{ id: string; required: boolean; currentDecision: string | null; export: { variants: Array<{ id: string; aspectRatio: string; durationSec: number | null; status: string }> } }>;
  comments: Array<{ id: string; authorName: string; body: string; timestampSec: number | null; createdAt: string }>;
};

export function ReviewClient({ token }: { token: string }) {
  const endpoint = `/api/review/${encodeURIComponent(token)}`;
  const [identity, setIdentity] = useState("");
  const [email, setEmail] = useState("");
  const [passcode, setPasscode] = useState("");
  const [round, setRound] = useState<ReviewSnapshot | null>(null);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const response = await fetch(endpoint, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || "Review could not be loaded");
    setRound(payload.round);
  };
  const access = async () => {
    setBusy(true); setError(null);
    try {
      const response = await fetch(`${endpoint}/access`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identity, email, passcode: passcode || null }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || "Access could not be verified");
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Access could not be verified"); }
    finally { setBusy(false); }
  };
  const post = async (path: string, body: unknown) => {
    setBusy(true); setError(null);
    try {
      const response = await fetch(`${endpoint}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || "Review response could not be saved");
      setComment(""); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Review response could not be saved"); }
    finally { setBusy(false); }
  };

  if (!round) return (
    <Flex minH="100dvh" bg="bg.canvas" align="center" justify="center" px="5">
      <Stack w="full" maxW="440px" gap="6" borderTopWidth="3px" borderColor="accent.solid" pt="6">
        <Flex align="center" gap="3" color="accent.fg"><ShieldCheck size={22} /><Text textStyle="eyebrow">Private review</Text></Flex>
        <Box><Heading textStyle="display" fontSize={{ base: "34px", md: "44px" }}>Enter the review room</Heading><Text mt="2" color="fg.muted">Identify yourself so comments and decisions stay accountable.</Text></Box>
        <Stack gap="3"><Input aria-label="Your name" placeholder="Your name" value={identity} onChange={(event) => setIdentity(event.target.value)} /><Input aria-label="Email" placeholder="you@company.com" type="email" value={email} onChange={(event) => setEmail(event.target.value)} /><Input aria-label="Passcode" placeholder="Passcode, if required" type="password" value={passcode} onChange={(event) => setPasscode(event.target.value)} /></Stack>
        {error && <Text color="danger.fg" fontSize="13px">{error}</Text>}
        <Button colorPalette="accent" disabled={!identity.trim() || !email.trim() || busy} onClick={access}>{busy ? "Checking…" : "Open review"}</Button>
      </Stack>
    </Flex>
  );

  return (
    <Box minH="100dvh" bg="bg.canvas">
      <Box as="header" borderBottomWidth="1px" borderColor="border.subtle" px={{ base: "5", md: "10" }} py="5"><Flex maxW="1180px" mx="auto" justify="space-between" align="end"><Box><Text textStyle="eyebrow" color="accent.fg">Review round {round.revision}</Text><Heading textStyle="title" mt="1">{round.title}</Heading></Box><Text fontSize="12px" color="fg.muted">Reviewing as {round.reviewer}</Text></Flex></Box>
      <Flex maxW="1180px" mx="auto" p={{ base: "5", md: "10" }} gap="8" align="start" direction={{ base: "column", lg: "row" }}>
        <Stack flex="1" gap="6" w="full">
          {round.message && <Text color="fg.muted">{round.message}</Text>}
          {round.items.map((item, index) => {
            const variant = item.export.variants.find((candidate) => candidate.status === "completed");
            return <Box key={item.id} layerStyle="well" overflow="hidden"><Flex px="4" py="3" borderBottomWidth="1px" borderColor="border.subtle" justify="space-between"><Text textStyle="eyebrow">Clip {index + 1}</Text><Text textStyle="data" color="fg.timecode">{variant?.aspectRatio.replace("ratio_", "").replaceAll("_", ":")}</Text></Flex>{variant ? <Box>{/* biome-ignore lint/a11y/useMediaCaption: review media is the final render with burned-in captions. */}<video controls playsInline preload="metadata" src={`${endpoint}/media/${item.id}/${variant.id}`} style={{ width: "100%", maxHeight: "70vh", background: "black" }} /></Box> : <Box p="10"><Text color="fg.muted">Media is still preparing.</Text></Box>}<Flex gap="2" p="3" borderTopWidth="1px" borderColor="border.subtle"><Button size="sm" variant="outline" colorPalette={item.currentDecision === "approved" ? "accent" : undefined} onClick={() => post("decision", { decision: "approved", itemId: item.id, reason: null })}>Approve clip</Button><Button size="sm" variant="outline" colorPalette={item.currentDecision === "changes_requested" ? "accent" : undefined} onClick={() => post("decision", { decision: "changes_requested", itemId: item.id, reason: null })}>Request changes</Button>{round.allowDownloads && variant ? <Button asChild size="sm" variant="ghost"><a href={`${endpoint}/download/${item.id}/${variant.id}`}>Download</a></Button> : null}</Flex></Box>;
          })}
        </Stack>
        <Stack w={{ base: "full", lg: "340px" }} flexShrink="0" gap="5">
          <Box borderTopWidth="3px" borderColor="accent.solid" pt="4"><Flex gap="2" align="center"><MessageSquareText size={17} /><Text textStyle="eyebrow">Feedback</Text></Flex><Textarea mt="3" rows={4} value={comment} onChange={(event) => setComment(event.target.value.slice(0, 2000))} placeholder="Leave a clear, actionable note" /><Button mt="2" size="sm" variant="outline" disabled={!comment.trim() || busy} onClick={() => post("comments", { itemId: null, parentId: null, body: comment, timestampSec: null })}>Add comment</Button></Box>
          <Stack gap="0" borderTopWidth="1px" borderColor="border.subtle">{round.comments.map((entry) => <Box key={entry.id} py="3" borderBottomWidth="1px" borderColor="border.subtle"><Text fontSize="11px" fontWeight="700">{entry.authorName}</Text><Text mt="1" fontSize="13px" color="fg.muted">{entry.body}</Text></Box>)}</Stack>
          {round.status === "open" ? <Stack gap="2"><Button colorPalette="accent" disabled={busy || (round.approvalRequired && round.items.some((item) => item.required && item.currentDecision !== "approved"))} onClick={() => post("decision", { decision: "approved", itemId: null, reason: null })}><Check size={15} />Approve round</Button><Button variant="outline" disabled={busy} onClick={() => post("decision", { decision: "changes_requested", itemId: null, reason: null })}>Request changes</Button></Stack> : <Text fontSize="13px" color="fg.muted">This round is {round.status.replaceAll("_", " ")}.</Text>}
          {error && <Text color="danger.fg" fontSize="13px">{error}</Text>}
        </Stack>
      </Flex>
    </Box>
  );
}
