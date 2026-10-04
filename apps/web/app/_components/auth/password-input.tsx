"use client";

import { useState } from "react";
import { Box, chakra } from "@chakra-ui/react";
import { Eye, EyeOff } from "lucide-react";
import { Input, type InputProps } from "@narriflow/ui/components/input";

/**
 * Password field with a show/hide toggle — replaces the dated
 * confirm-password pattern across the auth funnel.
 */
export function PasswordInput(props: Omit<InputProps, "type">) {
  const [visible, setVisible] = useState(false);

  return (
    <Box position="relative">
      <Input {...props} type={visible ? "text" : "password"} pe="10" />
      <chakra.button
        type="button"
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        onClick={() => setVisible((current) => !current)}
        position="absolute"
        top="0"
        bottom="0"
        insetInlineEnd="0"
        w="10"
        display="flex"
        alignItems="center"
        justifyContent="center"
        color="fg.muted"
        cursor="pointer"
        transition="color 120ms ease"
        _hover={{ color: "fg" }}
      >
        {visible ? <EyeOff size={15} /> : <Eye size={15} />}
      </chakra.button>
    </Box>
  );
}
