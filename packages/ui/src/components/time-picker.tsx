"use client"

import { Flex, Text } from "@chakra-ui/react"
import { Select } from "./select"

const hours = Array.from({ length: 24 }, (_, i) => {
  const value = String(i).padStart(2, "0")
  return { value, label: value }
})
const minutes = Array.from({ length: 60 }, (_, i) => {
  const value = String(i).padStart(2, "0")
  return { value, label: value }
})

/** A 24-hour wall-clock value; timezone conversion belongs to scheduling. */
export function TimePicker({ value, onValueChange, disabled, ariaLabel = "Time" }: {
  value: string
  onValueChange: (value: string) => void
  disabled?: boolean
  ariaLabel?: string
}) {
  const [hour = "", minute = ""] = value.split(":")
  return (
    <Flex align="center" gap="2" width="full" role="group" aria-label={ariaLabel}>
      <Select flex="1" minW="0" ariaLabel={`${ariaLabel} hours`} items={hours} value={hour} placeholder="HH" disabled={disabled} onValueChange={next => onValueChange(`${next}:${minute || "00"}`)} />
      <Text color="fg.muted" aria-hidden="true">:</Text>
      <Select flex="1" minW="0" ariaLabel={`${ariaLabel} minutes`} items={minutes} value={minute} placeholder="MM" disabled={disabled} onValueChange={next => onValueChange(`${hour || "00"}:${next}`)} />
    </Flex>
  )
}
