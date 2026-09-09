"use client";

import { forwardRef, useState, type ComponentPropsWithoutRef } from "react";

/** Key by export variant: refreshed signatures must not restart an unchanged video. */
export const PublishingPreview = forwardRef<HTMLVideoElement, ComponentPropsWithoutRef<"video">>(
  function PublishingPreview({ src, onError, ...props }, ref) {
    const [source, setSource] = useState(src);
    if (!source && src) setSource(src);
    return <video {...props} ref={ref} src={source} onError={event => {
      // If the pinned signature expires, use the latest signed URL once available.
      if (src && src !== source) setSource(src);
      onError?.(event);
    }} />;
  },
);
