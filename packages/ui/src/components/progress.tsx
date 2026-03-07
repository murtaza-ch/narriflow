import { Progress as ChakraProgress } from "@chakra-ui/react"

export interface ProgressProps {
  value?: number | null
}

export function Progress({ value }: ProgressProps) {
  return (
    <ChakraProgress.Root value={value ?? undefined} size="sm">
      <ChakraProgress.Track>
        <ChakraProgress.Range />
      </ChakraProgress.Track>
    </ChakraProgress.Root>
  )
}

export { ChakraProgress as ProgressParts }
