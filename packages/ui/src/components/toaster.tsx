"use client"

import {
  Box,
  Toaster as ChakraToaster,
  Portal,
  Spinner,
  Stack,
  Toast,
  createToaster,
  type CreateToasterReturn,
} from "@chakra-ui/react"

export const toaster: CreateToasterReturn = createToaster({
  placement: "bottom-end",
  pauseOnPageIdle: true,
})

/**
 * Toaster — a true Blueline card (toasts are one of the few sanctioned
 * elevated surfaces): bg.panel, hairline border, radius l3, the one
 * elevation shadow. Success/error toasts carry a 3px status stripe on the
 * leading edge — state is stripe + label, never hue alone.
 */
export function Toaster() {
  return (
    <Portal>
      <ChakraToaster toaster={toaster} insetInline={{ mdDown: "4" }}>
        {(toast) => (
          <Toast.Root
            width={{ md: "sm" }}
            position="relative"
            overflow="hidden"
            bg="bg.panel"
            borderRadius="l3"
            borderWidth="0"
            boxShadow="cardHover"
          >
            {(toast.type === "success" || toast.type === "error") && (
              <Box
                position="absolute"
                insetInlineStart="0"
                top="0"
                bottom="0"
                w="3px"
                bg={toast.type === "success" ? "success.solid" : "danger.solid"}
              />
            )}
            {toast.type === "loading" ? (
              <Spinner size="sm" color="accent.solid" />
            ) : (
              <Toast.Indicator />
            )}
            <Stack gap="1" flex="1" maxWidth="100%">
              {toast.title && (
                <Toast.Title fontSize="13.5px" fontWeight="600">
                  {toast.title}
                </Toast.Title>
              )}
              {toast.description && (
                <Toast.Description color="fg.muted" fontSize="13px">
                  {toast.description}
                </Toast.Description>
              )}
            </Stack>
            {toast.action && (
              <Toast.ActionTrigger>{toast.action.label}</Toast.ActionTrigger>
            )}
            {toast.closable && <Toast.CloseTrigger />}
          </Toast.Root>
        )}
      </ChakraToaster>
    </Portal>
  )
}
