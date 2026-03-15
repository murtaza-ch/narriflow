"use client";

import { Box, Flex, Text, HStack } from "@chakra-ui/react";
import {
  ArrowLeft,
  Undo2,
  Redo2,
  Keyboard,
  ChevronDown,
  Zap,
  Check,
  Loader,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useStudio } from "./studio-shell";

const BTN = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: "6px",
  cursor: "pointer",
  transition: "background 120ms ease, color 120ms ease",
  border: "none",
  background: "transparent",
  color: "#888",
  padding: "6px",
} as const;

const BTN_HOVER = "#1e1e1e";

function IconBtn({
  icon,
  onClick,
  disabled,
  title,
  size = 16,
}: {
  icon: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  size?: number;
}) {
  return (
    <Box
      as="button"
      style={{
        ...BTN,
        opacity: disabled ? 0.35 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
        width: "32px",
        height: "32px",
      }}
      title={title}
      onClick={disabled ? undefined : onClick}
      _hover={disabled ? {} : { bg: BTN_HOVER, color: "#e5e5e5" }}
    >
      {icon}
    </Box>
  );
}

export function TopBar() {
  const router = useRouter();
  const {
    clipInfo,
    undoStack,
    redoStack,
    showShortcuts,
    setShowShortcuts,
    handleSave,
    handleUndo,
    handleRedo,
    saveState,
    credits,
  } = useStudio();

  return (
    <Flex
      h="48px"
      align="center"
      px="12px"
      gap="4px"
      bg="#111111"
      borderBottomWidth="1px"
      borderColor="#222222"
      flexShrink={0}
    >
      {/* Left: Back + Title */}
      <HStack gap="8px" flex="1" minW="0">
        <IconBtn
          icon={<ArrowLeft size={16} />}
          onClick={() => router.back()}
          title="Back"
        />
        <Text
          fontSize="13px"
          fontWeight="500"
          color="#e5e5e5"
          whiteSpace="nowrap"
          overflow="hidden"
          textOverflow="ellipsis"
          maxW="340px"
        >
          {clipInfo.title}
        </Text>
      </HStack>

      {/* Right: Actions */}
      <HStack gap="4px" flexShrink={0}>
        <IconBtn
          icon={<Undo2 size={16} />}
          onClick={handleUndo}
          disabled={undoStack.length === 0}
          title="Undo (Ctrl+Z)"
        />
        <IconBtn
          icon={<Redo2 size={16} />}
          onClick={handleRedo}
          disabled={redoStack.length === 0}
          title="Redo (Ctrl+Shift+Z)"
        />

        {/* Divider */}
        <Box w="1px" h="20px" bg="#2a2a2a" mx="4px" />

        <IconBtn
          icon={<Keyboard size={16} />}
          onClick={() => setShowShortcuts(!showShortcuts)}
          title="Keyboard shortcuts"
        />

        {/* Divider */}
        <Box w="1px" h="20px" bg="#2a2a2a" mx="4px" />

        {/* Save button */}
        <button
          onClick={handleSave}
          disabled={saveState === "saving"}
          style={{
            padding: "0 12px",
            height: "32px",
            borderRadius: "6px",
            border: "1px solid #2a2a2a",
            background: "transparent",
            color: saveState === "saved" ? "#4ade80" : "#c4c4c4",
            fontSize: "13px",
            fontWeight: "500",
            cursor: saveState === "saving" ? "not-allowed" : "pointer",
            display: "flex",
            alignItems: "center",
            gap: "6px",
            transition: "all 150ms ease",
          }}
          onMouseEnter={(e) => {
            if (saveState !== "saving") {
              (e.currentTarget as HTMLButtonElement).style.background = "#1e1e1e";
              (e.currentTarget as HTMLButtonElement).style.color = "#e5e5e5";
            }
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = "transparent";
            (e.currentTarget as HTMLButtonElement).style.color = saveState === "saved" ? "#4ade80" : "#c4c4c4";
          }}
        >
          {saveState === "saving" && <Loader size={13} style={{ animation: "spin 1s linear infinite" }} />}
          {saveState === "saved" && <Check size={13} />}
          {saveState === "saving" ? "Saving..." : saveState === "saved" ? "Saved" : "Save changes"}
        </button>

        {/* Export button */}
        <Flex
          as="button"
          align="center"
          gap="4px"
          px="12px"
          h="32px"
          borderRadius="6px"
          bg="#6366F1"
          color="white"
          fontSize="13px"
          fontWeight="600"
          cursor="pointer"
          transition="background 150ms ease"
          _hover={{ bg: "#4F46E5" }}
        >
          Export
          <ChevronDown size={13} />
        </Flex>

        {/* Credits badge */}
        <Flex
          align="center"
          gap="4px"
          px="10px"
          h="28px"
          borderRadius="99px"
          bg="#2a1f00"
          border="1px solid #3d2e00"
          ml="4px"
        >
          <Zap size={12} color="#f59e0b" fill="#f59e0b" />
          <Text fontSize="12px" fontWeight="600" color="#f59e0b">
            {credits}
          </Text>
        </Flex>

        {/* Avatar */}
        <Box
          w="28px"
          h="28px"
          borderRadius="full"
          bg="#6366F1"
          ml="4px"
          display="flex"
          alignItems="center"
          justifyContent="center"
          fontSize="11px"
          fontWeight="600"
          color="white"
          flexShrink={0}
        >
          U
        </Box>
      </HStack>

      {/* Spin animation */}
      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </Flex>
  );
}
