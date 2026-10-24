"use client";

import { useEffect, useState } from "react";
import { Flex, Text } from "@chakra-ui/react";
import { Cloud } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
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
    <Flex align="center" justify="space-between" gap="3" wrap="wrap">
      <Flex align="center" gap="2" color="fg.muted">
        <Cloud size={16} />
        <Text fontSize="13px">Import from</Text>
      </Flex>
      <Flex align="center" gap="2">
        {drive && (
          <Button
            type="button"
            variant="subtle"
            size="sm"
            disabled={disabled || opening !== null || !googleApis}
            onClick={openDrive}
          >
            {opening === "drive" && (
              <Spinner size="xs" borderTopColor="accent.fg" />
            )}
            Google Drive
          </Button>
        )}
        {dropboxAppKey && (
          <Button
            type="button"
            variant="subtle"
            size="sm"
            disabled={disabled || opening !== null || !dropbox}
            onClick={openDropbox}
          >
            {opening === "dropbox" && (
              <Spinner size="xs" borderTopColor="accent.fg" />
            )}
            Dropbox
          </Button>
        )}
      </Flex>
    </Flex>
  );
}
