"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Box, Flex } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { Logo } from "@narriflow/ui/components/logo";
import styles from "./project-workspace.module.css";

export function ProjectWorkspace({ children, account, themeToggle }: { children: ReactNode; account: ReactNode; themeToggle: ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const view = searchParams.get("view") === "desk" ? "desk" : "gallery";
  // Studio owns a full-screen shell and must not inherit gallery card styles.
  if (pathname.includes("/clips/")) return children;

  return (
    <Box className={styles.workspace} data-project-view={view} minH="100dvh" bg="bg" color="fg">
      <Flex as="header" className={styles.topbar} align="center" justify="space-between" gap="4" px={{ base: "4", md: "8" }} py="4">
        <Flex align="center" gap="5">
          <Button asChild variant="ghost" size="sm"><Link href="/projects"><ArrowLeft size={16} />Projects</Link></Button>
          <Box className={styles.brand}><Logo size="sm" /></Box>
        </Flex>
        <Flex align="center" gap="3">{themeToggle}{account}</Flex>
      </Flex>
      <Box as="main" className={styles.main}>
        {children}
      </Box>
    </Box>
  );
}
