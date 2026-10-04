"use client";

import { useState } from "react";
import { InputGroup, chakra } from "@chakra-ui/react";
import { Eye, EyeOff } from "lucide-react";
import { Input, type InputProps } from "@narriflow/ui/components/input";

/**
 * Password field with a show/hide toggle — replaces the dated
 * confirm-password pattern across the auth funnel.
 */
export function PasswordInput({ startElement, ...props }: Omit<InputProps, "type"> & { startElement?: React.ReactNode }) {
  const [visible, setVisible] = useState(false);

  return (
    <InputGroup
      startElement={startElement}
      startElementProps={{ color: "fg.subtle" }}
      endElement={
        <chakra.button
          type="button"
          aria-label={visible ? "Hide password" : "Show password"}
          aria-pressed={visible}
          onClick={() => setVisible((current) => !current)}
          display="flex"
          alignItems="center"
          justifyContent="center"
          w="8"
          h="8"
          borderRadius="l1"
          color="fg.muted"
          cursor="pointer"
          transition="color 120ms ease, background 120ms ease"
          _hover={{ color: "fg", bg: "bg.muted" }}
        >
          {visible ? <EyeOff size={15} /> : <Eye size={15} />}
        </chakra.button>
      }
      endElementProps={{ px: "1" }}
    >
      <Input {...props} type={visible ? "text" : "password"} />
    </InputGroup>
  );
}
