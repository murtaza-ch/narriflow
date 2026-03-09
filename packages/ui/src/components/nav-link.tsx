"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { HStack, Text } from "@chakra-ui/react"
import type { ReactNode } from "react"

interface NavLinkProps {
  href: string
  icon?: ReactNode
  children: ReactNode
}

export function NavLink({ href, icon, children }: NavLinkProps) {
  const pathname = usePathname()
  const isActive = pathname === href || pathname.startsWith(href + "/")

  return (
    <Link href={href} style={{ textDecoration: "none" }}>
      <HStack
        gap="8px"
        px="12px"
        py="8px"
        borderRadius="8px"
        bg={isActive ? "bg.muted" : "transparent"}
        color={isActive ? "fg" : "fg.muted"}
        fontWeight={isActive ? "500" : "400"}
        fontSize="13px"
        transition="all 150ms ease"
        _hover={{
          bg: isActive ? "bg.muted" : "bg.subtle",
          color: "fg",
        }}
      >
        {icon}
        <Text>{children}</Text>
      </HStack>
    </Link>
  )
}
