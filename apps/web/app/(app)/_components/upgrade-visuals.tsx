import { Box, Flex, Text, type BoxProps } from "@chakra-ui/react";
import { BookMarked, Bot, Check, Play, Rss, Webhook } from "lucide-react";
import { BrandTile } from "../integrations/_components/brand-tile";

/**
 * Decorative illustrations for `FeatureHero` and `UpgradeHero`: a few tilted cards that show
 * what the feature makes, in the spirit of Vizard's brand kit banner. Pure
 * markup with no data, so they render the same for every workspace.
 */

function Card({ children, ...rest }: BoxProps) {
  return (
    <Box
      position="absolute"
      borderRadius="14px"
      bg="bg.panel"
      boxShadow="0 18px 40px -18px rgba(16, 19, 71, 0.35)"
      overflow="hidden"
      {...rest}
    >
      {children}
    </Box>
  );
}

function Clip({ src, caption, ...rest }: { src: string; caption: string } & BoxProps) {
  return (
    <Card w="78px" h="138px" {...rest}>
      <Box w="full" h="full" bgImage={`url(${src})`} bgSize="cover" bgPos="center" position="relative">
        <Text
          position="absolute"
          insetX="1.5"
          bottom="4"
          textAlign="center"
          fontSize="9px"
          fontWeight="800"
          lineHeight="1.15"
          color="white"
          textShadow="0 1px 2px rgba(0,0,0,0.6)"
          textTransform="uppercase"
        >
          {caption}
        </Text>
      </Box>
    </Card>
  );
}

function Handle(props: BoxProps) {
  return <Box position="absolute" boxSize="9px" borderRadius="full" bg="white" borderWidth="2px" borderColor="accent.solid" {...props} />;
}

export function BrandKitVisual() {
  return (
    <Box position="absolute" inset="0" css={{ perspective: "900px" }}>
      <Box position="absolute" inset="0" transform="rotate(-7deg) translate(4px, 14px)">
        {/* Colour swatch */}
        <Card left="6%" top="22%" w="112px" h="128px">
          <Box h="88px" bg="accent.solid" />
          <Text fontFamily="mono" fontSize="11px" color="fg.muted" px="3" pt="2.5">#2438E8</Text>
        </Card>
        {/* Logo */}
        <Card left="56%" top="10%" w="124px" h="80px" display="flex" alignItems="center" justifyContent="center">
          <Text fontFamily="Georgia, serif" fontStyle="italic" fontWeight="700" fontSize="24px" letterSpacing="0.04em" color="fg">LOGO</Text>
        </Card>
        {/* Outro scene */}
        <Card left="34%" top="64%" w="132px" h="78px" bg="bg.subtle" display="flex" alignItems="center" justifyContent="center">
          <Flex boxSize="32px" borderRadius="full" bg="fg" color="bg.panel" align="center" justify="center"><Play size={14} fill="currentColor" /></Flex>
          <Text position="absolute" right="2" bottom="2" fontSize="9px" fontWeight="600" px="1.5" py="0.5" borderRadius="4px" bg="bg.soft" color="fg.muted">Outro</Text>
        </Card>
        {/* Caption style, selected */}
        <Box position="absolute" left="26%" top="34%" w="176px" px="3" py="2.5" borderRadius="10px" bg="rgba(20, 22, 30, 0.88)" outline="1.5px solid" outlineColor="accent.solid" boxShadow="0 18px 40px -18px rgba(16, 19, 71, 0.5)">
          <Text textAlign="center" fontSize="15px" fontWeight="800" lineHeight="1.2" color="white">
            Five{" "}
            <Box as="span" bg="accent.solid" color="white" px="1" borderRadius="4px">boxing</Box>
            <br />
            <Box as="span" color="whiteAlpha.700">wizards jump</Box>
          </Text>
          <Handle left="-5px" top="-5px" />
          <Handle right="-5px" top="-5px" />
          <Handle left="-5px" bottom="-5px" />
          <Handle right="-5px" bottom="-5px" />
        </Box>
      </Box>
    </Box>
  );
}

export function AutopilotVisual() {
  return (
    <Box position="absolute" inset="0">
      <Card left="5%" top="34%" w="128px" px="3" py="3">
        <Flex align="center" gap="2" mb="2">
          <Flex boxSize="22px" borderRadius="6px" bg="upgrade.solid" color="upgrade.fg" align="center" justify="center"><Rss size={12} /></Flex>
          <Text fontSize="11px" fontWeight="600" color="fg">New episode</Text>
        </Flex>
        <Box h="5px" w="90%" borderRadius="full" bg="bg.soft" mb="1.5" />
        <Box h="5px" w="60%" borderRadius="full" bg="bg.soft" />
      </Card>
      <Flex position="absolute" left="calc(5% + 136px)" top="calc(34% + 18px)" boxSize="26px" borderRadius="full" bg="accent.solid" color="accent.contrast" align="center" justify="center" boxShadow="0 6px 16px -6px rgba(36, 56, 232, 0.6)">
        <Bot size={14} />
      </Flex>
      <Clip src="/images/caption-backdrops/warm-podcast.webp" caption="This changed everything" right="30%" top="10%" transform="rotate(-6deg)" />
      <Clip src="/images/caption-backdrops/blue-studio.webp" caption="Nobody talks about this" right="9%" top="20%" transform="rotate(4deg)" />
      <Flex position="absolute" right="16%" bottom="10%" align="center" gap="1" px="2" py="1" borderRadius="full" bg="bg.panel" boxShadow="0 10px 24px -12px rgba(16, 19, 71, 0.4)" fontSize="10.5px" fontWeight="600" color="accent.fg">
        <Check size={11} /> Scheduled
      </Flex>
    </Box>
  );
}

const RECIPE_SETTINGS = ["10 clips", "9:16", "Auto length", "Hook"];

/** One saved Recipe feeding Autopilot and an assistant, and the clips it makes. */
export function RecipeVisual() {
  return (
    <Box position="absolute" inset="0">
      <Card left="4%" top="16%" w="196px" px="3.5" py="3" transform="rotate(-3deg)">
        <Flex align="center" gap="2" mb="2.5">
          <Flex boxSize="22px" borderRadius="6px" bg="accent.subtle" color="accent.fg" align="center" justify="center"><BookMarked size={12} /></Flex>
          <Text fontSize="11.5px" fontWeight="600" color="fg">Weekly podcast</Text>
        </Flex>
        <Flex wrap="wrap" gap="1" mb="2.5">
          {RECIPE_SETTINGS.map((setting) => (
            <Text key={setting} fontSize="9.5px" fontWeight="500" color="fg.muted" bg="bg.soft" px="1.5" py="0.5" borderRadius="full">{setting}</Text>
          ))}
        </Flex>
        <Flex align="center" gap="1.5">
          <Flex boxSize="16px" borderRadius="4px" bg="#111522" color="white" align="center" justify="center" fontSize="7.5px" fontWeight="700">Aa</Flex>
          <Text fontSize="10px" color="fg.muted">Acme brand · captions</Text>
        </Flex>
      </Card>
      <Flex position="absolute" left="9%" bottom="11%" align="center" gap="1.5" px="2" py="1" borderRadius="full" bg="bg.panel" boxShadow="0 10px 24px -12px rgba(16, 19, 71, 0.4)" fontSize="10.5px" fontWeight="600" color="fg">
        <Box color="upgrade.fg" display="inline-flex"><Rss size={11} /></Box> Autopilot rule
      </Flex>
      <BrandTile brand="claude" size="sm" position="absolute" left="calc(9% + 116px)" bottom="8%" transform="rotate(6deg)" boxShadow="0 10px 24px -12px rgba(0,0,0,0.5)" />
      <Clip src="/images/caption-backdrops/navy-podcast.webp" caption="Same look every time" right="24%" top="12%" transform="rotate(-5deg)" />
      <Clip src="/images/caption-backdrops/warm-podcast.webp" caption="Ready to post" right="5%" top="24%" transform="rotate(5deg)" />
    </Box>
  );
}

export function SocialVisual() {
  return (
    <Box position="absolute" inset="0">
      <Clip src="/images/caption-backdrops/navy-podcast.webp" caption="Post it everywhere" left="calc(50% - 46px)" top="12%" w="92px" h="164px" transform="rotate(-4deg)" />
      <BrandTile brand="tiktok" position="absolute" left="12%" top="18%" boxShadow="0 10px 24px -12px rgba(0,0,0,0.5)" transform="rotate(-8deg)" />
      <BrandTile brand="youtube_shorts" position="absolute" left="18%" top="58%" boxShadow="0 10px 24px -12px rgba(0,0,0,0.5)" transform="rotate(6deg)" />
      <BrandTile brand="instagram_reels" position="absolute" right="14%" top="14%" boxShadow="0 10px 24px -12px rgba(0,0,0,0.5)" transform="rotate(8deg)" />
      <BrandTile brand="linkedin" position="absolute" right="10%" top="52%" boxShadow="0 10px 24px -12px rgba(0,0,0,0.5)" transform="rotate(-6deg)" />
      <BrandTile brand="x" size="sm" position="absolute" right="28%" bottom="8%" boxShadow="0 10px 24px -12px rgba(0,0,0,0.5)" />
    </Box>
  );
}

export function ApiVisual() {
  return (
    <Box position="absolute" inset="0">
      <Card left="8%" top="16%" w="230px" bg="#14161E" px="4" py="3.5" transform="rotate(-5deg)">
        <Flex gap="1.5" mb="2.5">
          {["#FF5F57", "#FEBC2E", "#28C840"].map((color) => <Box key={color} boxSize="7px" borderRadius="full" style={{ background: color }} />)}
        </Flex>
        <Text fontFamily="mono" fontSize="10.5px" lineHeight="1.7" color="#C9CDD4" whiteSpace="pre">
          <Box as="span" color="#8EAEEC">POST</Box> /api/v1/projects{"\n"}
          {"{"} <Box as="span" color="#F5DF98">&quot;sourceUrl&quot;</Box>: <Box as="span" color="#A8E0B8">&quot;https://…&quot;</Box> {"}"}{"\n"}
          <Box as="span" color="#6E747E">→ 202 Accepted</Box>
        </Text>
      </Card>
      <Flex position="absolute" right="8%" bottom="18%" align="center" gap="2" px="3" py="2" borderRadius="12px" bg="bg.panel" boxShadow="0 14px 30px -14px rgba(16, 19, 71, 0.45)" transform="rotate(3deg)">
        <Flex boxSize="24px" borderRadius="7px" bg="accent.subtle" color="accent.fg" align="center" justify="center"><Webhook size={13} /></Flex>
        <Box>
          <Text fontSize="11px" fontWeight="600" color="fg" lineHeight="1.2">render.completed</Text>
          <Text fontSize="10px" color="fg.muted" lineHeight="1.2">Signed webhook · 200</Text>
        </Box>
      </Flex>
      <BrandTile brand="n8n" size="sm" position="absolute" right="14%" top="12%" transform="rotate(8deg)" boxShadow="0 10px 24px -12px rgba(0,0,0,0.5)" />
      <BrandTile brand="claude" size="sm" position="absolute" right="30%" top="4%" transform="rotate(-6deg)" boxShadow="0 10px 24px -12px rgba(0,0,0,0.5)" />
    </Box>
  );
}

const TEAM = [
  { initials: "AK", name: "Aisha K.", role: "Admin", hue: "#2438E8" },
  { initials: "MR", name: "Marco R.", role: "Editor", hue: "#D62976" },
  { initials: "JL", name: "Jin L.", role: "Viewer", hue: "#CB8322" },
];

export function TeamVisual() {
  return (
    <Box position="absolute" inset="0">
      <Card left="10%" top="14%" w="220px" px="3" py="2.5" transform="rotate(-4deg)">
        {TEAM.map((member) => (
          <Flex key={member.name} align="center" gap="2.5" py="1.5">
            <Flex boxSize="24px" borderRadius="full" color="white" fontSize="9.5px" fontWeight="700" align="center" justify="center" style={{ background: member.hue }}>
              {member.initials}
            </Flex>
            <Text fontSize="11.5px" fontWeight="500" color="fg" flex="1">{member.name}</Text>
            <Text fontSize="10px" color="fg.muted" bg="bg.soft" px="1.5" py="0.5" borderRadius="4px">{member.role}</Text>
          </Flex>
        ))}
      </Card>
      <Flex position="absolute" right="8%" bottom="16%" align="center" gap="1.5" px="3" py="2" borderRadius="12px" bg="bg.panel" boxShadow="0 14px 30px -14px rgba(16, 19, 71, 0.45)" transform="rotate(4deg)">
        <Flex boxSize="18px" borderRadius="full" bg="accent.solid" color="accent.contrast" align="center" justify="center"><Check size={11} /></Flex>
        <Text fontSize="11px" fontWeight="600" color="fg">Client approved</Text>
      </Flex>
    </Box>
  );
}
