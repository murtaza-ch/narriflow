"use client";

import { useFormStatus } from "react-dom";
import { Button, type ButtonProps } from "./button";

export interface ActionSubmitButtonProps extends ButtonProps {
  pendingLabel: string;
}

/** A submit button whose pending state is scoped to its nearest action form. */
export function ActionSubmitButton({
  children,
  disabled,
  pendingLabel,
  type = "submit",
  ...props
}: ActionSubmitButtonProps) {
  const { pending } = useFormStatus();

  return (
    <Button
      {...props}
      type={type}
      disabled={disabled || pending}
      loading={pending}
      loadingText={pendingLabel}
    >
      {children}
    </Button>
  );
}
