import { Box, type BoxProps } from "@chakra-ui/react";
import type { HttpMethod } from "@/lib/docs/openapi";

// Method colours on the theme's palettes; the product has no green, so GET
// takes the accent (which marks it as the safe, read-only verb).
const PALETTE: Record<HttpMethod, string> = {
  get: "accent",
  post: "purple",
  put: "orange",
  patch: "orange",
  delete: "danger",
};

/** The Chakra palette name of a method, for tinting its path parameters to match. */
export function methodPalette(method: HttpMethod): string {
  return PALETTE[method];
}

const LABEL: Record<HttpMethod, string> = { get: "GET", post: "POST", put: "PUT", patch: "PATCH", delete: "DELETE" };

// The sidebar is narrow, so it shortens DELETE; pages print the whole verb.
const SHORT_LABEL: Record<HttpMethod, string> = { ...LABEL, delete: "DEL" };

const SIZES = {
  sm: { minW: "9", px: "1", borderRadius: "4px", fontSize: "10px", lineHeight: "1.6" },
  md: { minW: "14", px: "2", borderRadius: "6px", fontSize: "12px", lineHeight: "1.75" },
} as const;

export function MethodBadge({ method, size = "sm", ...rest }: { method: HttpMethod; size?: keyof typeof SIZES } & BoxProps) {
  const palette = PALETTE[method];
  return (
    <Box
      as="span"
      flexShrink={0}
      fontFamily="mono"
      fontWeight="600"
      textAlign="center"
      bg={`${palette}.subtle`}
      color={`${palette}.fg`}
      {...SIZES[size]}
      {...rest}
    >
      {size === "sm" ? SHORT_LABEL[method] : LABEL[method]}
    </Box>
  );
}
