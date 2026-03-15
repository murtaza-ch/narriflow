import { StudioShell } from "./_components/studio-shell";
import type { TranscriptItem, TimelineSegment, ClipInfo, CaptionPreset } from "./_components/studio-shell";

const MOCK_CAPTION_PRESET: CaptionPreset = {
  fontName: "Bebas Neue",
  primaryColor: "#FFFFFF",
  outlineColor: "#000000",
  outlineWidth: 2,
  shadow: 1,
  bold: true,
  position: "bottom",
  highlightColor: "#00ff88",
  animation: "word-by-word",
};

const MOCK_CLIP_INFO: ClipInfo = {
  id: "mock-clip-1",
  projectId: "mock-project-1",
  title: "Sherp Saves the Day! Justifying My Wild Vehicle...",
  duration: 671,
  startSec: 0,
  endSec: 671,
  aspectRatio: "9:16",
  viralityScore: 82,
  category: "story",
  credits: 10,
};

const MOCK_TRANSCRIPT: TranscriptItem[] = [
  {
    id: "t1",
    type: "speech",
    text: "and then uh during the hurricane it 🧡 was very helpful",
    timestamp: 0,
    highlights: [
      { word: "hurricane", color: "green" },
      { word: "helpful", color: "green" },
    ],
  },
  {
    id: "b1",
    type: "broll",
    timestamp: 0,
    description:
      "A black SHERP all-terrain vehicle drives over a dirt mound, kicking up dust.",
  },
  {
    id: "t2",
    type: "speech",
    text: "we could deliver stuff to cops or firefighters or whoever you know and we could get anywhere",
    timestamp: 2.3,
    highlights: [{ word: "deliver", color: "green" }],
  },
  {
    id: "b2",
    type: "broll",
    timestamp: 0,
    description:
      "The SHERP drives through shallow floodwaters, approaching the flooded property.",
  },
  {
    id: "t3",
    type: "speech",
    text: "so it was",
    timestamp: 5.1,
    highlights: [],
  },
  {
    id: "b3",
    type: "broll",
    timestamp: 0.2,
    description:
      "People unload packages of bottled water from the back of the SHERP.",
  },
  {
    id: "t4",
    type: "speech",
    text: "it did come in handy there and i made me feel a little bit better about 💰 the purchase because i was glad to be able to 🙏 help a little bit",
    timestamp: 6.8,
    highlights: [
      { word: "handy", color: "amber" },
      { word: "purchase", color: "amber" },
      { word: "help", color: "amber" },
    ],
  },
  {
    id: "t5",
    type: "speech",
    text: "so yeah the SHERP is actually one of my favorite purchases ever and i think it was totally worth every single penny spent on it",
    timestamp: 9.2,
    highlights: [
      { word: "SHERP", color: "green" },
      { word: "worth", color: "green" },
    ],
  },
  {
    id: "b4",
    type: "broll",
    timestamp: 0,
    description:
      "Wide shot of SHERP parked next to a normal pickup truck, showing size comparison.",
  },
  {
    id: "t6",
    type: "speech",
    text: "and i get a lot of questions about it like is it street legal can you drive it normally and the answer is yes kind of",
    timestamp: 11.5,
    highlights: [
      { word: "street legal", color: "amber" },
    ],
  },
];

const MOCK_TIMELINE_SEGMENTS: TimelineSegment[] = [
  { id: "s1", label: "Fill", startSec: 0, endSec: 2.3 },
  { id: "s2", label: "Fill", startSec: 2.4, endSec: 5.0 },
  { id: "s3", label: "Fill", startSec: 5.2, endSec: 6.7 },
  { id: "s4", label: "Fill", startSec: 6.9, endSec: 9.5 },
  { id: "s5", label: "Fill", startSec: 9.6, endSec: 11.09 },
];

export default async function StudioPage({
  params,
}: {
  params: Promise<{ projectId: string; clipId: string }>;
}) {
  // In future: replace mock data with real data fetch
  // const { projectId, clipId } = await params;
  await params; // consumed to avoid lint warning

  return (
    <StudioShell
      clipInfo={MOCK_CLIP_INFO}
      transcript={MOCK_TRANSCRIPT}
      timelineSegments={MOCK_TIMELINE_SEGMENTS}
      initialCaptionPreset={MOCK_CAPTION_PRESET}
    />
  );
}
