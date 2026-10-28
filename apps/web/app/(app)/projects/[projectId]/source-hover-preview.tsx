"use client";

import { Box } from "@chakra-ui/react";
import { type ReactNode, useRef, useState } from "react";

/**
 * The imported source's own footage over its placeholder thumbnail. The first
 * frame fades in once it decodes; hovering plays it muted. Without a playable
 * URL (still importing, or purged after retention) the placeholder stays.
 */
export function SourceHoverPreview({
  src,
  children,
}: {
  src: string | null;
  children: ReactNode;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  if (!src) return children;

  return (
    <Box
      position="absolute"
      inset="0"
      onPointerEnter={() => void videoRef.current?.play().catch(() => undefined)}
      onPointerLeave={() => videoRef.current?.pause()}
    >
      {children}
      <Box
        asChild
        position="absolute"
        inset="0"
        w="full"
        h="full"
        objectFit="cover"
        opacity={ready ? 1 : 0}
        transition="opacity 300ms ease"
      >
        <video
          ref={videoRef}
          src={`${src}#t=0.5`}
          muted
          loop
          playsInline
          preload="metadata"
          aria-hidden
          onLoadedData={() => setReady(true)}
        />
      </Box>
    </Box>
  );
}
