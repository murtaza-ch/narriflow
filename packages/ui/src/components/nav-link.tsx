"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { HStack, Text, Box } from "@chakra-ui/react"
import type { ReactNode } from "react"

interface NavLinkProps {
  href: string
  icon?: ReactNode
  children: ReactNode
}

/**
 * NavLink — sidebar navigation item. Active = bg.muted wash + full ink +
 * weight 600 + a 5px ultramarine dot before the label (the Blueline
 * active-nav signal). `/settings` matches exactly; other hrefs match by
 * prefix so nested routes stay highlighted.
 */
export function NavLink({ href, icon, children }: NavLinkProps) {
  const pathname = usePathname()
  const isActive =
    pathname === href || (href !== "/settings" && pathname.startsWith(href + "/"))

  return (
    <Link
      href={href}
      aria-current={isActive ? "page" : undefined}
      style={{ textDecoration: "none" }}
    >
      <HStack
        gap="2.5"
        px="3"
        py="1.5"
        borderRadius="l2"
        bg={isActive ? "bg.muted" : "transparent"}
        color={isActive ? "fg" : "fg.muted"}
        fontWeight={isActive ? "600" : "450"}
        fontSize="13px"
        transition="background 120ms ease, color 120ms ease"
        _hover={{
          bg: isActive ? "bg.muted" : "bg.subtle",
          color: "fg",
        }}
      >
        {/* Ultramarine dot — the active indicator */}
        <Box
          w="5px"
          h="5px"
          borderRadius="full"
          bg="accent.solid"
          opacity={isActive ? 1 : 0}
          transition="opacity 120ms ease"
          flexShrink={0}
        />
        {icon}
        <Text>{children}</Text>
      </HStack>
    </Link>
  )
}
