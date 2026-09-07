import { Progress as ChakraProgress } from "@chakra-ui/react"

export interface ProgressProps {
  value?: number | null
}

/**
 * Progress — Blueline meter styling on the Chakra Progress primitive:
 * 3px bg.muted track, ultramarine fill, full radius. For static values
 * prefer `Meter`; this wrapper stays for API compatibility.
 */
export function Progress({ value }: ProgressProps) {
  return (
    <ChakraProgress.Root value={value ?? undefined} colorPalette="accent">
      <ChakraProgress.Track h="3px" borderRadius="full" bg="bg.muted">
        <ChakraProgress.Range borderRadius="full" bg="accent.solid" />
      </ChakraProgress.Track>
    </ChakraProgress.Root>
  )
}

export { ChakraProgress as ProgressParts }
