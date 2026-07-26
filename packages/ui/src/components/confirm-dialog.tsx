"use client"

import * as React from "react"
import { Dialog, Portal } from "./dialog"
import { Button } from "./button"

export interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  /** Renders the confirm button on danger.solid. */
  destructive?: boolean
  onConfirm: () => void | Promise<void>
  /** Shows a pending state on the confirm button and locks cancel. */
  loading?: boolean
}

/**
 * Blueline ConfirmDialog on Chakra v3 Dialog — a true card with a single
 * question, one cancel, one confirm. Kills window.confirm call sites.
 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  const {
    open,
    onOpenChange,
    title,
    description,
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    destructive = false,
    onConfirm,
    loading = false,
  } = props

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(details) => {
        if (loading) return
        onOpenChange(details.open)
      }}
      role="alertdialog"
      placement="center"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content
            maxW="sm"
            bg="bg.panel"
            borderWidth="1px"
            borderColor="border"
            borderRadius="l3"
            boxShadow="card"
          >
            <Dialog.Header pt="5" pb="0" px="5">
              <Dialog.Title
                textStyle="title"
                fontSize="15px"
                color="fg"
              >
                {title}
              </Dialog.Title>
            </Dialog.Header>
            <Dialog.Body pt="2" pb="4" px="5">
              {description != null ? (
                <Dialog.Description
                  fontSize="13.5px"
                  lineHeight="1.5"
                  color="fg.muted"
                >
                  {description}
                </Dialog.Description>
              ) : null}
            </Dialog.Body>
            <Dialog.Footer px="5" pb="4" pt="0" gap="2">
              <Button
                variant="outline"
                size="sm"
                colorPalette="brand"
                disabled={loading}
                onClick={() => onOpenChange(false)}
              >
                {cancelLabel}
              </Button>
              <Button
                variant="solid"
                size="sm"
                colorPalette={destructive ? "danger" : "accent"}
                loading={loading}
                onClick={() => void onConfirm()}
              >
                {confirmLabel}
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  )
}

export interface ConfirmOptions {
  title: string
  description?: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
}

export interface UseConfirmReturn {
  /** Resolves true when confirmed, false when cancelled/dismissed. */
  confirm: (options: ConfirmOptions) => Promise<boolean>
  /** Render this once near the call site (e.g. at the end of the page). */
  dialog: React.ReactNode
}

interface PendingConfirm {
  options: ConfirmOptions
  resolve: (result: boolean) => void
}

/**
 * Promise-based confirm:
 *
 * const { confirm, dialog } = useConfirm()
 * if (await confirm({ title: "Delete clip?", destructive: true })) { … }
 * return <>{page}{dialog}</>
 */
export function useConfirm(): UseConfirmReturn {
  const [pending, setPending] = React.useState<PendingConfirm | null>(null)

  const confirm = React.useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setPending((current) => {
          // A newer confirm supersedes an unresolved one.
          current?.resolve(false)
          return { options, resolve }
        })
      }),
    [],
  )

  const settle = React.useCallback(
    (result: boolean) => {
      setPending((current) => {
        current?.resolve(result)
        return null
      })
    },
    [],
  )

  const dialog = pending ? (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) settle(false)
      }}
      onConfirm={() => settle(true)}
      {...pending.options}
    />
  ) : null

  return { confirm, dialog }
}
