"use client";

import { useState } from "react";
import { Box, Flex, Text, Stack } from "@chakra-ui/react";
import { Sparkles, Copy, Check, Zap, Mic2 } from "lucide-react";

const TONES = ["Curious", "Bold", "Emotional", "Funny", "Controversial"] as const;
const HOOK_TYPES = ["Spoken", "Text overlay", "Both"] as const;

const GENERATED_HOOKS = [
  "I bought the most ridiculous vehicle you've ever seen — and it literally saved lives during a hurricane.",
  "What happens when a $150,000 amphibious tank meets a natural disaster? This.",
  "Everyone laughed at my wild purchase. Then the hurricane hit.",
  "The one time being called 'crazy' for your hobbies actually matters.",
  "Would you spend $150K on a vehicle just to feel good about yourself? Here's why I did.",
];

export function AiHookPanel() {
  const [tone, setTone] = useState<(typeof TONES)[number]>("Bold");
  const [hookType, setHookType] = useState<(typeof HOOK_TYPES)[number]>("Spoken");
  const [hooks, setHooks] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  async function generate() {
    setLoading(true);
    await new Promise((r) => setTimeout(r, 1200));
    // Shuffle and pick 4
    const shuffled = [...GENERATED_HOOKS].sort(() => Math.random() - 0.5).slice(0, 4);
    setHooks(shuffled);
    setLoading(false);
  }

  function copyHook(hook: string, idx: number) {
    void navigator.clipboard.writeText(hook);
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 2000);
  }

  return (
    <Stack gap="16px" p="12px">
      {/* Tone */}
      <Box>
        <Text fontSize="10px" color="#555" fontWeight="600" textTransform="uppercase" letterSpacing="0.07em" mb="8px">
          Tone
        </Text>
        <Flex gap="5px" flexWrap="wrap">
          {TONES.map((t) => (
            <Box
              key={t}
              as="button"
              px="10px"
              py="5px"
              borderRadius="99px"
              bg={tone === t ? "rgba(99,102,241,0.15)" : "#1a1a1a"}
              border="1px solid"
              borderColor={tone === t ? "#6366F1" : "#2a2a2a"}
              color={tone === t ? "#a5b4fc" : "#666"}
              fontSize="11px"
              fontWeight="500"
              cursor="pointer"
              onClick={() => setTone(t)}
              transition="all 150ms"
            >
              {t}
            </Box>
          ))}
        </Flex>
      </Box>

      {/* Hook type */}
      <Box>
        <Text fontSize="10px" color="#555" fontWeight="600" textTransform="uppercase" letterSpacing="0.07em" mb="8px">
          Hook type
        </Text>
        <Flex gap="5px">
          {HOOK_TYPES.map((h) => (
            <Flex
              key={h}
              as="button"
              align="center"
              px="10px"
              py="5px"
              borderRadius="6px"
              bg={hookType === h ? "rgba(99,102,241,0.12)" : "#1a1a1a"}
              border="1px solid"
              borderColor={hookType === h ? "#6366F1" : "#2a2a2a"}
              color={hookType === h ? "#a5b4fc" : "#666"}
              fontSize="11px"
              fontWeight="500"
              cursor="pointer"
              onClick={() => setHookType(h)}
              transition="all 150ms"
            >
              {h}
            </Flex>
          ))}
        </Flex>
      </Box>

      {/* Generate button */}
      <Flex
        as="button"
        align="center"
        justify="center"
        h="36px"
        borderRadius="8px"
        bg={loading ? "#1e1e1e" : "#6366F1"}
        color={loading ? "#888" : "white"}
        fontSize="13px"
        fontWeight="600"
        cursor={loading ? "not-allowed" : "pointer"}
        gap="7px"
        onClick={!loading ? generate : undefined}
        transition="background 150ms"
        _hover={!loading ? { bg: "#4F46E5" } : {}}
      >
        {loading ? (
          <>
            <Sparkles size={14} style={{ animation: "spin 1s linear infinite" }} />
            Generating...
          </>
        ) : (
          <>
            <Sparkles size={14} />
            Generate hooks
          </>
        )}
        {!loading && (
          <Flex align="center" gap="2px" ml="4px">
            <Zap size={10} fill="rgba(255,255,255,0.7)" color="rgba(255,255,255,0.7)" />
            <Text fontSize="10px" color="rgba(255,255,255,0.7)">2</Text>
          </Flex>
        )}
      </Flex>

      {/* Hook results */}
      {hooks.length > 0 && (
        <Stack gap="6px">
          <Text fontSize="10px" color="#555" fontWeight="600" textTransform="uppercase" letterSpacing="0.07em">
            Suggestions
          </Text>
          {hooks.map((hook, i) => (
            <Box
              key={i}
              px="12px"
              py="10px"
              borderRadius="8px"
              bg="#161616"
              border="1px solid #222"
              position="relative"
            >
              <Text fontSize="12px" color="#ccc" lineHeight="1.55" mb="8px">
                "{hook}"
              </Text>
              <Flex align="center" justify="space-between">
                <Flex
                  as="button"
                  align="center"
                  gap="4px"
                  px="8px"
                  py="4px"
                  borderRadius="5px"
                  bg="#6366F1"
                  color="white"
                  fontSize="10px"
                  fontWeight="600"
                  cursor="pointer"
                  _hover={{ bg: "#4F46E5" }}
                  transition="background 150ms"
                >
                  <Mic2 size={10} />
                  Use this
                </Flex>
                <Box
                  as="button"
                  p="5px"
                  borderRadius="5px"
                  bg="transparent"
                  border="none"
                  cursor="pointer"
                  color={copiedIdx === i ? "#4ade80" : "#555"}
                  transition="color 150ms"
                  onClick={() => copyHook(hook, i)}
                  title="Copy"
                >
                  {copiedIdx === i ? <Check size={13} /> : <Copy size={13} />}
                </Box>
              </Flex>
            </Box>
          ))}
        </Stack>
      )}

      {hooks.length === 0 && !loading && (
        <Flex
          direction="column"
          align="center"
          justify="center"
          py="24px"
          gap="8px"
          color="#333"
        >
          <Mic2 size={28} />
          <Text fontSize="12px" color="#444" textAlign="center">
            Click generate to get AI-powered hook suggestions
          </Text>
        </Flex>
      )}

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </Stack>
  );
}
