// Theme & Provider
export { system } from "./theme"
export { Provider } from "./provider"

// Components (thin wrappers)
export { Button, IconButton } from "./components/button"
export { Input } from "./components/input"
export { Textarea } from "./components/textarea"
export { Label } from "./components/label"
export { Badge } from "./components/badge"
export { Card } from "./components/card"
export { Dialog, Portal, CloseButton } from "./components/dialog"
export { Progress, ProgressParts } from "./components/progress"

// Form controls (Blueline kit)
export { Select } from "./components/select"
export { Combobox } from "./components/combobox"
export { DatePicker, DateTimePicker } from "./components/date-picker"
export { Checkbox } from "./components/checkbox"
export { RadioGroup, Radio } from "./components/radio"
export { Switch } from "./components/switch"
export { Slider } from "./components/slider"
export { NumberInput } from "./components/number-input"
export { SegmentedControl } from "./components/segmented-control"
export { ColorSwatchField } from "./components/color-swatch-field"
export { OTPInput } from "./components/otp-input"
export { ConfirmDialog, useConfirm } from "./components/confirm-dialog"
export { Spinner } from "./components/spinner"

// Structure & display (Blueline kit)
export { PageHeader } from "./components/page-header"
export { StatBand, StatBandItem } from "./components/stat-band"
export { Meter, ScoreMeter } from "./components/meter"
export { MediaWell } from "./components/media-well"
export { PhoneFrame } from "./components/phone-frame"
export { Toolbar } from "./components/toolbar"
export { GhostFrame } from "./components/ghost-frame"

// Design system components
export { Logo } from "./components/logo"
export { NavLink } from "./components/nav-link"
export { StatusBadge } from "./components/status-badge"
export { EmptyState } from "./components/empty-state"
export { LabeledDivider } from "./components/divider"
export { PageTransition } from "./components/page-transition"

// Form (react-hook-form integration)
export * from "./components/form"

// Toast
export { Toaster, toaster } from "./components/toaster"

// Color Mode
export * from "./components/color-mode"

// Hooks
export * from "./hooks/use-mobile"

// Re-export commonly used Chakra layout components for convenience
export {
  Box,
  Flex,
  Stack,
  HStack,
  VStack,
  Text,
  Heading,
  Container,
  SimpleGrid,
  Grid,
} from "@chakra-ui/react"
