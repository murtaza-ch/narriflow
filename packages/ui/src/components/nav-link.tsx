"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { HStack, Text } from "@chakra-ui/react"
import type { ReactNode } from "react"

interface NavLinkProps {
  href: string
  icon?: ReactNode
  collapsed?: boolean
  /** Trailing marker, e.g. the gem on a feature the plan doesn't include. */
  badge?: ReactNode
  children: ReactNode
}

export function NavLink({ href, icon, children, badge, collapsed = false }: NavLinkProps) {
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
      {/* The current page is a raised row with a short marker at the
          sidebar's outer edge (the nav's 12px inset), not a tinted fill. */}
      <HStack
        position="relative"
        gap="2.5"
        px="3"
        py="2"
        justify={collapsed ? "center" : "flex-start"}
        borderRadius="8px"
        bg={isActive ? "bg.panel" : "transparent"}
        color={isActive ? "fg" : "fg.muted"}
        fontWeight={isActive ? "500" : "400"}
        fontSize="14px"
        transition="background 120ms ease, color 120ms ease"
        _hover={{
          bg: isActive ? "bg.panel" : "bg.soft",
          color: "fg",
        }}
        _before={
          isActive
            ? {
                content: '""',
                position: "absolute",
                left: "-12px",
                top: "50%",
                transform: "translateY(-50%)",
                w: "3px",
                h: "16px",
                borderEndRadius: "3px",
                bg: "fg",
              }
            : undefined
        }
      >
        {icon}
        {!collapsed && <Text>{children}</Text>}
        {!collapsed && badge}
      </HStack>
    </Link>
  )
}
