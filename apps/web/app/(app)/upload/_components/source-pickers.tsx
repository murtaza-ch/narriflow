"use client";

import { useEffect, useState } from "react";
import { Box, Grid, Image, Stack, Text } from "@chakra-ui/react";
import { Button, type ButtonProps } from "@narriflow/ui/components/button";
import { Spinner } from "@narriflow/ui/components/spinner";
import {
  chooseDropboxVideo,
  loadDropbox,
  type DropboxChooserApi,
} from "../_lib/dropbox-chooser";
import {
  loadGoogleApis,
  pickDriveVideo,
  type DrivePick,
  type GoogleApis,
} from "../_lib/google-drive-picker";
import type { SourcePickerConfig } from "../_lib/source-pickers";

type Provider = "drive" | "dropbox";

interface SourcePickersProps {
  config: SourcePickerConfig;
  disabled: boolean;
  onDriveFile: (file: DrivePick) => void;
  /** A dropbox.com shared link, ready for link intake. */
  onDropboxLink: (link: string) => void;
  onError: (message: string) => void;
}

/** "Import from" row of the cloud pickers that are configured. Renders
 *  nothing when none is. */
export function SourcePickers({
  config,
  disabled,
  onDriveFile,
  onDropboxLink,
  onError,
}: SourcePickersProps) {
  const [opening, setOpening] = useState<Provider | null>(null);
  // Each provider's library, once loaded. A button stays disabled until then,
  // so the click handler can open the popup without awaiting anything first;
  // a popup opened after an await can be blocked by the browser.
  const [googleApis, setGoogleApis] = useState<GoogleApis | null>(null);
  const [dropbox, setDropbox] = useState<DropboxChooserApi | null>(null);
  const { drive, dropboxAppKey } = config;

  // biome-ignore lint/correctness/useExhaustiveDependencies: onError is the parent's state setter; the libraries load once per configuration.
  useEffect(() => {
    let cancelled = false;
    const loadFailed = (provider: string) => () => {
      if (!cancelled) {
        onError(
          `We couldn't load ${provider}. Check your connection or ad blocker, then reload the page.`,
        );
      }
    };
    if (drive) {
      loadGoogleApis()
        .then((apis) => !cancelled && setGoogleApis(apis))
        .catch(loadFailed("Google Drive"));
    }
    if (dropboxAppKey) {
      loadDropbox(dropboxAppKey)
        .then((api) => !cancelled && setDropbox(api))
        .catch(loadFailed("Dropbox"));
    }
    return () => {
      cancelled = true;
    };
  }, [drive, dropboxAppKey]);

  if (!drive && !dropboxAppKey) return null;

  function openDrive() {
    if (!drive || !googleApis) return;
    setOpening("drive");
    pickDriveVideo(drive, googleApis)
      .then((file) => file && onDriveFile(file))
      .catch(() =>
        onError(
          "We couldn't open Google Drive. Allow pop-ups for this page and try again.",
        ),
      )
      .finally(() => setOpening(null));
  }

  function openDropbox() {
    if (!dropbox) return;
    setOpening("dropbox");
    chooseDropboxVideo(dropbox)
      .then((link) => link && onDropboxLink(link))
      .catch(() =>
        onError(
          "We couldn't open Dropbox. Allow pop-ups for this page and try again.",
        ),
      )
      .finally(() => setOpening(null));
  }

  return (
    <Stack gap="2">
      <Text fontSize="13px" color="fg.muted">
        Import from
      </Text>
      <Grid
        templateColumns={{ base: "1fr", sm: "repeat(2, minmax(0, 1fr))" }}
        gap="2"
      >
        {drive && (
          <ProviderTile
            logo="/images/sources/google-drive.svg"
            label="Google Drive"
            loading={opening === "drive"}
            disabled={disabled || opening !== null || !googleApis}
            onClick={openDrive}
          />
        )}
        {dropboxAppKey && (
          <ProviderTile
            logo="/images/sources/dropbox.svg"
            label="Dropbox"
            rounded
            loading={opening === "dropbox"}
            disabled={disabled || opening !== null || !dropbox}
            onClick={openDropbox}
          />
        )}
      </Grid>
    </Stack>
  );
}

const TILE_PROPS: ButtonProps = {
  type: "button",
  variant: "subtle",
  h: "12",
  px: "3.5",
  gap: "3",
  justifyContent: "flex-start",
  borderRadius: "l2",
  fontSize: "14px",
  fontWeight: "500",
  color: "fg",
  _disabled: { opacity: 0.5, cursor: "not-allowed" },
};

/** One cloud provider: its mark, its name, and a spinner in the mark's place while its picker opens. */
function ProviderTile({
  logo,
  label,
  rounded = false,
  loading,
  disabled,
  onClick,
}: {
  logo: string;
  label: string;
  /** The mark is a full-bleed square, so it gets soft corners. */
  rounded?: boolean;
  loading: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button {...TILE_PROPS} disabled={disabled} onClick={onClick}>
      <Box boxSize="5" flexShrink={0} display="flex" alignItems="center" justifyContent="center">
        {loading ? (
          <Spinner size="sm" borderTopColor="accent.fg" />
        ) : (
          <Image
            src={logo}
            alt=""
            boxSize="full"
            objectFit="contain"
            borderRadius={rounded ? "5px" : undefined}
          />
        )}
      </Box>
      {label}
    </Button>
  );
}
