"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { HStack, Text } from "@chakra-ui/react"
import type { ReactNode } from "react"

interface NavLinkProps {
  href: string
  icon?: ReactNode
  collapsed?: boolean
  children: ReactNode
}

export function NavLink({ href, icon, children, collapsed = false }: NavLinkProps) {
  const pathname = usePathname()
  const isActive =
    pathname === href || (href !== "/settings" && pathname.startsWith(href + "/"))

  return (
    <Link
      href={href}
      title={collapsed && typeof children === "string" ? children : undefined}
      aria-label={collapsed && typeof children === "string" ? children : undefined}
      aria-current={isActive ? "page" : undefined}
      style={{ textDecoration: "none" }}
    >
      <HStack
        gap="2.5"
        px="3"
        py="2.5"
        justify={collapsed ? "center" : "flex-start"}
        borderRadius="9px"
        bg={isActive ? "bg.muted" : "transparent"}
        color={isActive ? "fg" : "fg.muted"}
        fontWeight="400"
        fontSize="14px"
        transition="background 120ms ease, color 120ms ease"
        _hover={{
          bg: isActive ? "bg.muted" : "bg.subtle",
          color: "fg",
        }}
      >
        {icon}
        {!collapsed && <Text>{children}</Text>}
      </HStack>
    </Link>
  )
}
