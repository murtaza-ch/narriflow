"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react"

export type ColorMode = "light" | "dark"

interface ColorModeContextValue {
  colorMode: ColorMode
  setColorMode: (mode: ColorMode) => void
  toggleColorMode: () => void
}

const ColorModeContext = createContext<ColorModeContextValue | null>(null)
const STORAGE_KEY = "narriflow-color-mode"

function storedColorMode(): ColorMode {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored === "light" || stored === "dark") return stored
  } catch {
    // Storage may be unavailable in hardened/private browsing contexts.
  }
  return "dark"
}

function applyColorMode(mode: ColorMode) {
  const root = document.documentElement
  root.classList.remove("light", "dark")
  root.classList.add(mode)
  root.style.colorScheme = mode
}

/**
 * React 19.2 / Next.js 16.2 warns when next-themes inserts its raw <script>
 * from a client-rendered provider. The flash-prevention script now lives in
 * the root layout as next/script; this provider owns only reactive state.
 */
export function ColorModeProvider({ children }: { children: React.ReactNode }) {
  // Keep the server and first client render deterministic. The root bootstrap
  // script applies the visual mode before hydration, and this state catches up
  // immediately after mount without producing a hydration mismatch.
  const [colorMode, setCurrentColorMode] = useState<ColorMode>("dark")

  const setColorMode = useCallback((mode: ColorMode) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, mode)
    } catch {
      // The in-memory mode still works when persistence is unavailable.
    }
    applyColorMode(mode)
    setCurrentColorMode(mode)
  }, [])

  useEffect(() => {
    const syncPreference = () => {
      const mode = storedColorMode()
      applyColorMode(mode)
      setCurrentColorMode(mode)
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) syncPreference()
    }
    syncPreference()
    window.addEventListener("storage", onStorage)
    return () => {
      window.removeEventListener("storage", onStorage)
    }
  }, [])

  const value = useMemo<ColorModeContextValue>(
    () => ({
      colorMode,
      setColorMode,
      toggleColorMode: () => setColorMode(colorMode === "dark" ? "light" : "dark"),
    }),
    [colorMode, setColorMode],
  )

  return <ColorModeContext.Provider value={value}>{children}</ColorModeContext.Provider>
}

export function useColorMode() {
  const context = useContext(ColorModeContext)
  if (!context) throw new Error("useColorMode must be used inside ColorModeProvider")
  return context
}

export function useColorModeValue<T>(light: T, dark: T) {
  const { colorMode } = useColorMode()
  return colorMode === "dark" ? dark : light
}
