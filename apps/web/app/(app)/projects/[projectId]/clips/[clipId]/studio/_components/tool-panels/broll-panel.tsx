"use client";

import { useState } from "react";
import { Box, Flex, Text, Stack, Input } from "@chakra-ui/react";
import { Search, Film, Library, Globe } from "lucide-react";

const MOCK_SUGGESTIONS = [
  { id: "1", ts: "0s", desc: "Black SHERP all-terrain vehicle drives over dirt mound, kicking up dust." },
  { id: "2", ts: "0s", desc: "SHERP drives through shallow floodwaters approaching flooded property." },
  { id: "3", ts: "0.2s", desc: "People unload packages of bottled water from the back of the SHERP." },
  { id: "4", ts: "0s", desc: "Wide shot of SHERP parked next to pickup truck for size comparison." },
  { id: "5", ts: "0s", desc: "Aerial view of SHERP navigating through dense forest terrain." },
];

const TABS = [
  { id: "suggestions", label: "Suggestions", icon: <Film size={13} /> },
  { id: "library",     label: "Library",     icon: <Library size={13} /> },
  { id: "stock",       label: "Stock",       icon: <Globe size={13} /> },
];

export function BRollPanel() {
  const [activeTab, setActiveTab] = useState("suggestions");
  const [query, setQuery] = useState("");

  const filtered = MOCK_SUGGESTIONS.filter((s) =>
    s.desc.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <Stack gap="0" h="100%">
      {/* Search */}
      <Box p="12px" pb="8px">
        <Flex
          align="center"
          gap="8px"
          px="10px"
          h="34px"
          borderRadius="7px"
          bg="#1a1a1a"
          border="1px solid #2a2a2a"
        >
          <Search size={13} color="#555" />
          <Input
            placeholder="Search B-Roll..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            size="xs"
            flex="1"
            fontSize="12px"
            color="#ccc"
            css={{ border: "none", outline: "none", background: "transparent", boxShadow: "none", caretColor: "#6366F1" }}
            _placeholder={{ color: "#555" }}
          />
        </Flex>
      </Box>

      {/* Tabs */}
      <Flex px="12px" gap="4px" mb="8px">
        {TABS.map((tab) => (
          <Flex
            key={tab.id}
            as="button"
            align="center"
            gap="5px"
            px="10px"
            py="6px"
            borderRadius="6px"
            bg={activeTab === tab.id ? "#1e1e1e" : "transparent"}
            border="1px solid"
            borderColor={activeTab === tab.id ? "#2a2a2a" : "transparent"}
            color={activeTab === tab.id ? "#ccc" : "#555"}
            cursor="pointer"
            fontSize="11px"
            fontWeight="500"
            onClick={() => setActiveTab(tab.id)}
            transition="all 150ms"
          >
            {tab.icon}
            {tab.label}
          </Flex>
        ))}
      </Flex>

      {/* Content */}
      <Stack gap="6px" px="12px" pb="12px" overflowY="auto" flex="1">
        {activeTab === "suggestions" && filtered.map((item) => (
          <Flex
            key={item.id}
            gap="10px"
            p="10px"
            borderRadius="8px"
            bg="#1a1a1a"
            border="1px solid #252525"
            cursor="pointer"
            align="flex-start"
            transition="all 150ms"
            _hover={{ bg: "#1e1e1e", borderColor: "#333" }}
          >
            {/* Thumbnail placeholder */}
            <Box
              w="52px"
              h="36px"
              borderRadius="5px"
              bg="#262626"
              border="1px solid #333"
              flexShrink={0}
              display="flex"
              alignItems="center"
              justifyContent="center"
            >
              <Film size={14} color="#444" />
            </Box>
            <Box flex="1" minW="0">
              <Text fontSize="10px" fontFamily="mono" color="#6366F1" fontWeight="600" mb="2px">
                {item.ts}
              </Text>
              <Text fontSize="11px" color="#777" lineHeight="1.4" style={{ overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" } as React.CSSProperties}>
                {item.desc}
              </Text>
            </Box>
          </Flex>
        ))}

        {activeTab !== "suggestions" && (
          <Flex
            direction="column"
            align="center"
            justify="center"
            py="32px"
            gap="8px"
            color="#333"
          >
            <Library size={28} />
            <Text fontSize="12px" color="#444" textAlign="center">
              {activeTab === "library" ? "Your uploaded media will appear here" : "Stock footage coming soon"}
            </Text>
          </Flex>
        )}
      </Stack>
    </Stack>
  );
}
