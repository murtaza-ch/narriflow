"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Box, Field, Flex, Stack, Text } from "@chakra-ui/react";
import { Trash2, Upload } from "lucide-react";
import { Checkbox } from "@narriflow/ui/components/checkbox";
import { Button } from "@narriflow/ui/components/button";
import { toaster } from "@narriflow/ui/components/toaster";
import { brandFontUploadSchema } from "@narriflow/validators";
import { LockedButton, type UpgradePrompt } from "../../_components/upgrade";
import { PlanLimitNotice } from "../../_components/plan-limit-notice";
import {
  BrandFontsProvider,
  brandFontStyle,
  useBrandFont,
  type BrandFontChoice,
} from "./brand-fonts";

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

function FontSample({ font }: { font: BrandFontChoice }) {
  const loaded = useBrandFont({
    kind: "brand_font",
    id: font.id,
    fingerprint: font.fingerprint,
  });
  return (
    <Text fontSize="22px" style={loaded ? brandFontStyle(loaded) : undefined}>
      {font.family}
    </Text>
  );
}

export function FontManager({
  fonts,
  canManage,
  requirement,
  upgrade,
}: {
  fonts: BrandFontChoice[];
  canManage: boolean;
  requirement: string | null;
  upgrade: UpgradePrompt | null;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [licenseConfirmed, setLicenseConfirmed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  async function upload(file: File) {
    setBusy("upload");
    try {
      const extension = file.name.split(".").pop()?.toLowerCase();
      const contentType =
        extension === "ttf"
          ? "font/ttf"
          : extension === "otf"
            ? "font/otf"
            : extension === "woff2"
              ? "font/woff2"
              : "";
      const metadata = brandFontUploadSchema.parse({
        contentType,
        sizeBytes: file.size,
        licenseConfirmed,
      });
      const bytes = await file.arrayBuffer();
      try {
        await new FontFace("NarriflowUploadCheck", bytes).load();
      } catch {
        throw new Error(
          "This font could not be loaded. Choose a valid TTF, OTF or WOFF2 file.",
        );
      }
      const fingerprint = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (value) => value.toString(16).padStart(2, "0"),
      ).join("");
      const presigned = await jsonRequest("/api/brand-fonts/presign-upload", {
        method: "POST",
        body: JSON.stringify(metadata),
      });
      const uploaded = await fetch(presigned.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": presigned.contentType },
        body: file,
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
      router.refresh();
    } catch (error) {
      toaster.create({
        type: "error",
        title: "Font upload failed",
        description:
          error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      setBusy(null);
      if (input.current) input.current.value = "";
    }
  }
  async function remove(font: BrandFontChoice) {
    setBusy(font.id);
    try {
      await jsonRequest(`/api/brand-fonts/${font.id}`, {
        method: "DELETE",
        body: "{}",
      });
      router.refresh();
    } catch (error) {
      toaster.create({
        type: "error",
        title: "Font could not be deleted",
        description:
          error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      setBusy(null);
    }
  }
  return (
    <BrandFontsProvider fonts={fonts}>
      <Stack as="section" gap="4">
        <Flex align="center" justify="space-between" gap="4">
          <Text fontSize="16px" fontWeight="500">
            Custom fonts
          </Text>
          {canManage ? (
            requirement && upgrade ? (
              <LockedButton size="sm" variant="subtle" prompt={upgrade}>
                Upload font
              </LockedButton>
            ) : !requirement ? (
              <Button
                size="sm"
                variant="subtle"
                disabled={!licenseConfirmed || busy !== null}
                loading={busy === "upload"}
                onClick={() => input.current?.click()}
              >
                <Upload size={14} /> Upload font
              </Button>
            ) : null
          ) : null}
        </Flex>
        {requirement ? (
          <PlanLimitNotice message={requirement} upgrade={upgrade} />
        ) : canManage ? (
          <Field.Root>
            <Checkbox
              checked={licenseConfirmed}
              onCheckedChange={setLicenseConfirmed}
              size="sm"
            >
              I have permission to use and embed this font in videos.
            </Checkbox>
            <Field.HelperText>
              TTF, OTF or WOFF2, up to 20 MB. Each file is one font style.
            </Field.HelperText>
          </Field.Root>
        ) : null}
        <input
          ref={input}
          type="file"
          accept=".ttf,.otf,.woff2"
          aria-label="Upload custom font"
          hidden
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (file) void upload(file);
          }}
        />
        {fonts.length ? (
          <Stack gap="2">
            {fonts.map((font) => (
              <Flex
                key={font.id}
                bg="bg.soft"
                borderRadius="l2"
                p="4"
                align="center"
                justify="space-between"
                gap="4"
              >
                <Box>
                  <FontSample font={font} />
                  <Text fontSize="12px" color="fg.muted">
                    {font.style} · {font.weight}
                    {font.accessUrl ? "" : " · file unavailable"}
                  </Text>
                </Box>
                {canManage ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Delete ${font.family} ${font.style}`}
                    disabled={busy !== null}
                    onClick={() => remove(font)}
                  >
                    <Trash2 size={14} />
                  </Button>
                ) : null}
              </Flex>
            ))}
          </Stack>
        ) : (
          <Box bg="bg.soft" borderRadius="l2" p="5">
            <Text fontSize="13px" color="fg.muted">
              No custom fonts yet. Upload a font to use it in caption styles and
              Studio text layers.
            </Text>
          </Box>
        )}
        {fonts.length ? (
          <Text fontSize="12px" color="fg.muted">
            Deleting removes a font from new selections. Existing clips keep
            their saved font. Detach it from Brand Profiles, caption styles and
            Scene Templates before deleting.
          </Text>
        ) : null}
      </Stack>
    </BrandFontsProvider>
  );
}
