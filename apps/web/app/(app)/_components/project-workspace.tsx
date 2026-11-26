"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Box, Flex } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { Logo } from "@narriflow/ui/components/logo";
import styles from "./project-workspace.module.css";
import { ShellPanel } from "./shell-panel";

/**
 * The open Project's frame. It never reads the URL: the gallery or desk view
 * is marked by the page and its skeleton (`data-project-view`), which read
 * `?view=` inside their own Suspense boundaries, so the frame prerenders and
 * hydrates the same for every link.
 */
export function ProjectWorkspace({ children, account, themeToggle }: { children: ReactNode; account: ReactNode; themeToggle: ReactNode }) {
  const pathname = usePathname();
  // Studio owns a full-screen shell and must not inherit gallery card styles.
  if (pathname.includes("/clips/")) return children;

  return (
    // Same frame as the main shell: the page sits in one inset panel.
    <Flex className={styles.workspace} direction="column" minH="100dvh" bg="bg.sidebar" color="fg" p={{ base: "0", lg: "2" }}>
      <ShellPanel>
        <Flex as="header" className={styles.topbar} align="center" justify="space-between" gap="4" px={{ base: "4", md: "6" }}>
          <Flex align="center" gap="5">
            <Button asChild variant="ghost" size="sm"><Link href="/projects"><ArrowLeft size={16} />Projects</Link></Button>
            <Box className={styles.brand}><Logo size="sm" /></Box>
          </Flex>
          <Flex align="center" gap="2">{themeToggle}{account}</Flex>
        </Flex>
        {/* w="full": inside the panel's flex column, the CSS module's
            auto margins would otherwise shrink the page to its content. */}
        <Box as="main" className={styles.main} w="full">
          {children}
        </Box>
      </ShellPanel>
    </Flex>
  );
}
