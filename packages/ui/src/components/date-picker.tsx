"use client"

import {
  Button,
  DatePicker as ChakraDatePicker,
  Flex,
  Input,
  Portal,
} from "@chakra-ui/react"
import {
  CalendarDateTime,
  DateFormatter,
  parseDate,
  type DateValue,
} from "@internationalized/date"
import { CalendarDays } from "lucide-react"
import * as React from "react"

function dateValue(value?: string) {
  if (!value) return []
  try {
    return [parseDate(value)]
  } catch {
    return []
  }
}

function DateViews({ withTime }: { withTime?: React.ReactNode }) {
  return (
    <>
      <ChakraDatePicker.View view="day">
        <ChakraDatePicker.Header />
        <ChakraDatePicker.DayTable />
        {withTime}
      </ChakraDatePicker.View>
      <ChakraDatePicker.View view="month">
        <ChakraDatePicker.Header />
        <ChakraDatePicker.MonthTable />
      </ChakraDatePicker.View>
      <ChakraDatePicker.View view="year">
        <ChakraDatePicker.Header />
        <ChakraDatePicker.YearTable />
      </ChakraDatePicker.View>
    </>
  )
}

export interface DatePickerProps {
  id?: string
  name?: string
  label?: string
  ariaLabel?: string
  placeholder?: string
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  disabled?: boolean
  min?: string
  max?: string
  width?: string
}

/** Date-only field using Chakra DatePicker and its Calendar views. */
export function DatePicker({
  id,
  name,
  label,
  ariaLabel,
  placeholder = "Select date",
  value,
  defaultValue,
  onValueChange,
  disabled,
  min,
  max,
  width = "12rem",
}: DatePickerProps) {
  const [internalValue, setInternalValue] = React.useState(defaultValue ?? "")
  const selected = value ?? internalValue

  function change(details: { value: DateValue[] }) {
    const next = details.value[0]?.toString() ?? ""
    if (value === undefined) setInternalValue(next)
    onValueChange?.(next)
  }

  return (
    <ChakraDatePicker.Root
      value={dateValue(selected)}
      onValueChange={change}
      min={dateValue(min)[0]}
      max={dateValue(max)[0]}
      disabled={disabled}
      width={width}
    >
      {name ? <input type="hidden" name={name} value={selected} /> : null}
      {label ? <ChakraDatePicker.Label>{label}</ChakraDatePicker.Label> : null}
      <ChakraDatePicker.Control>
        <ChakraDatePicker.Input
          id={id}
          aria-label={ariaLabel}
          placeholder={placeholder}
        />
        <ChakraDatePicker.IndicatorGroup>
          <ChakraDatePicker.Trigger aria-label={`Open ${ariaLabel ?? label ?? "date"} calendar`}>
            <CalendarDays size={15} />
          </ChakraDatePicker.Trigger>
        </ChakraDatePicker.IndicatorGroup>
      </ChakraDatePicker.Control>
      <Portal>
        <ChakraDatePicker.Positioner>
          <ChakraDatePicker.Content>
            <DateViews />
          </ChakraDatePicker.Content>
        </ChakraDatePicker.Positioner>
      </Portal>
    </ChakraDatePicker.Root>
  )
}

function parseLocalDateTime(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!match) return null
  return new CalendarDateTime(
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
  )
}

function localDateTimeValue(value: CalendarDateTime) {
  const pad = (part: number) => String(part).padStart(2, "0")
  return `${value.year}-${pad(value.month)}-${pad(value.day)}T${pad(value.hour)}:${pad(value.minute)}`
}

const dateTimeFormatter = new DateFormatter("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
})

export interface DateTimePickerProps {
  id?: string
  name?: string
  label?: string
  ariaLabel?: string
  value: string
  onValueChange: (value: string) => void
  disabled?: boolean
  timezone?: string
  width?: string
}

/** Chakra's calendar picker composed with a time field, following its with-time pattern. */
export function DateTimePicker({
  id,
  name,
  label,
  ariaLabel,
  value,
  onValueChange,
  disabled,
  width = "full",
}: DateTimePickerProps) {
  const selected = parseLocalDateTime(value)
  const timeValue = selected
    ? `${String(selected.hour).padStart(2, "0")}:${String(selected.minute).padStart(2, "0")}`
    : ""

  function onDateChange(details: { value: DateValue[] }) {
    const nextDate = details.value[0]
    if (!nextDate) return onValueChange("")
    const priorTime = selected ?? { hour: 9, minute: 0 }
    onValueChange(
      localDateTimeValue(
        new CalendarDateTime(
          nextDate.year,
          nextDate.month,
          nextDate.day,
          priorTime.hour,
          priorTime.minute,
        ),
      ),
    )
  }

  function onTimeChange(event: React.ChangeEvent<HTMLInputElement>) {
    const [hour, minute] = event.currentTarget.value.split(":").map(Number)
    if (!selected || !Number.isFinite(hour) || !Number.isFinite(minute)) return
    const current = selected
    onValueChange(localDateTimeValue(current.set({ hour, minute })))
  }

  return (
    <Flex gap="2" width={width} align="stretch">
      {name ? <input type="hidden" name={name} value={value} /> : null}
      <ChakraDatePicker.Root
        value={selected ? [selected] : []}
        onValueChange={onDateChange}
        disabled={disabled}
        flex="1"
      >
        {label ? <ChakraDatePicker.Label>{label}</ChakraDatePicker.Label> : null}
        <ChakraDatePicker.Control>
          <ChakraDatePicker.Trigger asChild unstyled>
            <Button
              id={id}
              type="button"
              variant="outline"
              width="full"
              justifyContent="space-between"
              aria-label={ariaLabel}
            >
              {selected
                ? dateTimeFormatter.format(selected.toDate("UTC"))
                : "Select date and time"}
              <CalendarDays size={15} />
            </Button>
          </ChakraDatePicker.Trigger>
        </ChakraDatePicker.Control>
        <Portal>
          <ChakraDatePicker.Positioner>
            <ChakraDatePicker.Content>
              <DateViews />
            </ChakraDatePicker.Content>
          </ChakraDatePicker.Positioner>
        </Portal>
      </ChakraDatePicker.Root>
      <Input
        type="time"
        value={timeValue}
        onChange={onTimeChange}
        aria-label="Publish time"
        disabled={disabled || !selected}
        width="7.5rem"
      />
    </Flex>
  )
}
