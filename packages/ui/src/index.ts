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
