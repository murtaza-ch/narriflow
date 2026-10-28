"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Box, Flex, Grid, Stack, Text, chakra } from "@chakra-ui/react";
import { FileType2, Trash2, Type, Upload } from "lucide-react";
import { Checkbox } from "@narriflow/ui/components/checkbox";
import { Button, IconButton } from "@narriflow/ui/components/button";
import { Dialog, Portal } from "@narriflow/ui/components/dialog";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { useConfirm } from "@narriflow/ui/components/confirm-dialog";
import { toaster } from "@narriflow/ui/components/toaster";
import { brandFontUploadSchema } from "@narriflow/validators";
import {
  BrandFontsProvider,
  brandFontStyle,
  useBrandFont,
  type BrandFontChoice,
} from "./brand-fonts";

const SPECIMEN = "The quick brown fox jumps over the lazy dog";
const MAX_FONT_MB = 20;

async function jsonRequest(url: string, init?: RequestInit) {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      result.message ?? "The font request failed. Please try again.",
    );
  return result;
}

function fontContentType(file: File) {
  const extension = file.name.split(".").pop()?.toLowerCase();
  return extension === "ttf" ? "font/ttf" : extension === "otf" ? "font/otf" : extension === "woff2" ? "font/woff2" : "";
}

/** Every uploaded face as a specimen card. */
export function FontLibrary({
  fonts,
  canManage,
}: {
  fonts: BrandFontChoice[];
  canManage: boolean;
}) {
  const router = useRouter();
  const { confirm, dialog } = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);

  async function remove(font: BrandFontChoice) {
    const confirmed = await confirm({
      title: `Delete ${font.family} ${font.style}?`,
      description: "It leaves new selections. Existing clips keep their saved font. Detach it from Brand Profiles, caption styles and Scene Templates first.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!confirmed) return;
    setBusy(font.id);
    try {
      await jsonRequest(`/api/brand-fonts/${font.id}`, { method: "DELETE", body: "{}" });
      toaster.create({ type: "success", title: "Font deleted" });
      router.refresh();
    } catch (error) {
      toaster.create({
        type: "error",
        title: "Font could not be deleted",
        description: error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      setBusy(null);
    }
  }

  if (fonts.length === 0) {
    return (
      <EmptyState
        icon={<Type size={20} />}
        title="No custom fonts yet"
        description="Upload a font to use it in caption styles and Studio text layers."
      />
    );
  }
  return (
    <BrandFontsProvider fonts={fonts}>
      <Grid templateColumns={{ base: "1fr", sm: "repeat(2, minmax(0, 1fr))", xl: "repeat(3, minmax(0, 1fr))" }} gap="4">
        {fonts.map((font) => (
          <FontCard
            key={font.id}
            font={font}
            action={canManage ? (
              <IconButton
                size="xs"
                variant="ghost"
                aria-label={`Delete ${font.family} ${font.style}`}
                disabled={busy !== null}
                onClick={() => void remove(font)}
              >
                <Trash2 size={14} />
              </IconButton>
            ) : null}
          />
        ))}
      </Grid>
      {dialog}
    </BrandFontsProvider>
  );
}

function FontCard({ font, action }: { font: BrandFontChoice; action: ReactNode }) {
  const loaded = useBrandFont({ kind: "brand_font", id: font.id, fingerprint: font.fingerprint });
  const style = loaded ? brandFontStyle(loaded) : undefined;
  return (
    <Stack className="group" gap="5" bg="bg.subtle" borderWidth="1px" borderColor="border.card" borderRadius="l3" p="5" minW="0">
      <Flex justify="space-between" align="flex-start" gap="3">
        <Text fontSize="52px" lineHeight="1" letterSpacing="-0.01em" style={style} opacity={loaded ? 1 : 0.35} transition="opacity 200ms ease">
          Aa
        </Text>
        <Box opacity={{ base: 1, md: 0 }} _groupHover={{ opacity: 1 }} _focusWithin={{ opacity: 1 }} transition="opacity 120ms ease">
          {action}
        </Box>
      </Flex>
      <Text fontSize="17px" lineHeight="1.35" lineClamp={2} minH="2lh" style={style} color={loaded ? "fg" : "fg.subtle"}>
        {SPECIMEN}
      </Text>
      <Stack gap="0.5">
        <Text fontSize="14px" fontWeight="500" truncate>
          {font.family}
        </Text>
        <Text fontSize="12px" color="fg.muted" fontVariantNumeric="tabular-nums">
          {font.style} · {font.weight}
          {font.accessUrl ? "" : " · file unavailable"}
        </Text>
      </Stack>
    </Stack>
  );
}

type Draft = { file: File; bytes: ArrayBuffer; family: string } | { file: File; error: string };

/** "Upload font": pick a file, see it set in the face, confirm the license, upload. */
export function FontUploadButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [licenseConfirmed, setLicenseConfirmed] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const previewFace = useRef<FontFace | null>(null);

  function clearPreview() {
    if (previewFace.current) document.fonts.delete(previewFace.current);
    previewFace.current = null;
  }
  // Drop the previewed face when the button unmounts.
  useEffect(() => () => {
    if (previewFace.current) document.fonts.delete(previewFace.current);
  }, []);

  async function choose(file: File) {
    clearPreview();
    if (!fontContentType(file)) {
      setDraft({ file, error: "Choose a TTF, OTF or WOFF2 file." });
      return;
    }
    if (file.size > MAX_FONT_MB * 1024 * 1024) {
      setDraft({ file, error: `This file is over ${MAX_FONT_MB} MB.` });
      return;
    }
    const bytes = await file.arrayBuffer();
    const family = `NarriflowUploadPreview_${Date.now()}`;
    try {
      const face = await new FontFace(family, bytes.slice(0)).load();
      document.fonts.add(face);
      previewFace.current = face;
      setDraft({ file, bytes, family });
    } catch {
      setDraft({ file, error: "This font could not be loaded. Choose a valid TTF, OTF or WOFF2 file." });
    }
  }

  function close() {
    if (uploading) return;
    setOpen(false);
    setDraft(null);
    setLicenseConfirmed(false);
    clearPreview();
  }

  async function upload() {
    if (!draft || "error" in draft) return;
    setUploading(true);
    try {
      const metadata = brandFontUploadSchema.parse({
        contentType: fontContentType(draft.file),
        sizeBytes: draft.file.size,
        licenseConfirmed,
      });
      const fingerprint = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", draft.bytes)),
        (value) => value.toString(16).padStart(2, "0"),
      ).join("");
      const presigned = await jsonRequest("/api/brand-fonts/presign-upload", {
        method: "POST",
        body: JSON.stringify(metadata),
      });
      const uploaded = await fetch(presigned.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": presigned.contentType },
        body: draft.file,
      });
      if (!uploaded.ok) throw new Error("Upload failed. Please try again.");
      const result = await jsonRequest("/api/brand-fonts", {
        method: "POST",
        body: JSON.stringify({ ...metadata, key: presigned.key, fingerprint }),
      });
      toaster.create({
        type: "success",
        title: result.replayed ? "Font already uploaded" : "Font uploaded",
      });
      setUploading(false);
      close();
      router.refresh();
    } catch (error) {
      setUploading(false);
      toaster.create({
        type: "error",
        title: "Font upload failed",
        description: error instanceof Error ? error.message : "Please try again.",
      });
    }
  }

  const ready = draft !== null && !("error" in draft);
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Upload size={14} /> Upload font
      </Button>
      <Dialog.Root open={open} onOpenChange={(details) => (details.open ? setOpen(true) : close())} placement="center">
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content maxW="lg">
              <Dialog.Header>
                <Dialog.Title>Upload a font</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <Stack gap="5">
                  <chakra.label
                    display="block"
                    cursor="pointer"
                    borderRadius="l3"
                    bg={dragging ? "accent.subtle" : "bg.soft"}
                    outline="2px dashed"
                    outlineColor={dragging ? "accent.solid" : "transparent"}
                    outlineOffset="-2px"
                    transition="background 120ms ease, outline-color 120ms ease"
                    _hover={{ bg: dragging ? "accent.subtle" : "bg.softHover" }}
                    _focusWithin={{ boxShadow: "0 0 0 2px var(--chakra-colors-accent-solid)" }}
                    onDragOver={(event) => {
                      event.preventDefault();
                      setDragging(true);
                    }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(event) => {
                      event.preventDefault();
                      setDragging(false);
                      const file = event.dataTransfer.files[0];
                      if (file) void choose(file);
                    }}
                  >
                    <chakra.input
                      ref={input}
                      type="file"
                      accept=".ttf,.otf,.woff2"
                      aria-label="Upload custom font"
                      srOnly
                      onChange={(event) => {
                        const file = event.currentTarget.files?.[0];
                        event.currentTarget.value = "";
                        if (file) void choose(file);
                      }}
                    />
                    {ready ? (
                      <Stack gap="3" p="5">
                        <Text fontSize="44px" lineHeight="1.1" style={{ fontFamily: `"${draft.family}"` }}>
                          Aa Bb Cc 123
                        </Text>
                        <Text fontSize="16px" lineHeight="1.4" style={{ fontFamily: `"${draft.family}"` }}>
                          {SPECIMEN}
                        </Text>
                        <Flex align="center" gap="2" color="fg.muted" fontSize="12px">
                          <FileType2 size={13} />
                          <Text truncate>{draft.file.name}</Text>
                          <Text flexShrink={0} fontVariantNumeric="tabular-nums">· {(draft.file.size / 1024 / 1024).toFixed(1)} MB</Text>
                          <Text ms="auto" flexShrink={0} color="fg" fontWeight="500">Choose another</Text>
                        </Flex>
                      </Stack>
                    ) : (
                      <Stack align="center" gap="2" py="10" px="6" textAlign="center">
                        <Flex boxSize="11" borderRadius="full" bg="bg.soft" color="fg.muted" align="center" justify="center">
                          <Upload size={18} />
                        </Flex>
                        <Text fontSize="14px" fontWeight="500">Drop a font file or choose one</Text>
                        <Text fontSize="12.5px" color={draft && "error" in draft ? "danger.fg" : "fg.muted"}>
                          {draft && "error" in draft ? draft.error : `TTF, OTF or WOFF2, up to ${MAX_FONT_MB} MB. Each file is one style.`}
                        </Text>
                      </Stack>
                    )}
                  </chakra.label>
                  <Checkbox checked={licenseConfirmed} onCheckedChange={setLicenseConfirmed} size="sm">
                    I have permission to use and embed this font in videos.
                  </Checkbox>
                </Stack>
              </Dialog.Body>
              <Dialog.Footer>
                <Button variant="subtle" disabled={uploading} onClick={close}>Cancel</Button>
                {/* The license box is the only thing between a previewed font and the upload, so the reason is in view. */}
                <Button loading={uploading} disabled={!ready || !licenseConfirmed} onClick={() => void upload()}>
                  Upload font
                </Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </>
  );
}
