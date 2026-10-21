/**
 * Copy and demo content for the homepage. Product facts (plans, platforms,
 * caption presets) come from @narriflow/validators in page.tsx; this module
 * only holds what is specific to the marketing story.
 */

export type DemoClip = {
  id: string;
  src: string;
  alt: string;
  score: number;
  duration: string;
  caption: string;
  presetId: string;
  /** object-position for crops of a wider frame. */
  position?: string;
};

/** The wide podcast frame used for crops and the demo source. */
export const SOURCE_FRAME = {
  src: "/landing/source-podcast-wide.webp",
  alt: "Two podcast hosts recording an episode at a wooden table",
} as const;

export type Audience = DemoClip & { word: string };

/** People who record long videos. Their footage fills the galleries and the caption lab. */
export const AUDIENCES: Audience[] = [
  {
    id: "podcaster",
    word: "podcasters",
    src: "/landing/story-podcaster.webp",
    alt: "Podcaster talking into a microphone at his desk",
    caption: "We almost never recorded episode one",
    presetId: "bold-pop",
    score: 96,
    duration: "0:44",
  },
  {
    id: "founder",
    word: "founders",
    src: "/landing/story-founder.webp",
    alt: "Founder speaking on a conference stage",
    caption: "Our first customer found us by accident",
    presetId: "spotlight",
    score: 93,
    duration: "0:38",
  },
  {
    id: "coach",
    word: "coaches",
    src: "/landing/story-coach.webp",
    alt: "Business coach explaining a plan at a whiteboard",
    caption: "Say less and say it first",
    presetId: "sticker",
    score: 91,
    duration: "0:29",
  },
  {
    id: "streamer",
    word: "streamers",
    src: "/landing/story-streamer.webp",
    alt: "Streamer laughing at her desk with a headset on",
    caption: "That clutch was pure luck honestly",
    presetId: "neon",
    score: 95,
    duration: "0:24",
  },
  {
    id: "chef",
    word: "chefs",
    src: "/landing/story-chef.webp",
    alt: "Home cook plating pasta in his kitchen",
    caption: "Salt the water like you mean it",
    presetId: "bubblegum",
    score: 89,
    duration: "0:35",
  },
  {
    id: "trainer",
    word: "trainers",
    src: "/landing/story-trainer.webp",
    alt: "Fitness coach holding a kettlebell in a gym",
    caption: "Ten minutes beats zero minutes",
    presetId: "jelly",
    score: 92,
    duration: "0:31",
  },
];

const [podcaster, founder, coach, streamer, chef, trainer] = AUDIENCES as [
  Audience,
  Audience,
  Audience,
  Audience,
  Audience,
  Audience,
];

/** Every demo clip: the audiences plus vertical crops of the podcast episode. */
export const CLIPS: DemoClip[] = [
  podcaster,
  founder,
  {
    id: "podcast-left",
    src: SOURCE_FRAME.src,
    alt: "Podcast host laughing at the recording table",
    score: 97,
    duration: "0:42",
    caption: "I almost quit the show in year one",
    presetId: "highlighter",
    position: "2% 30%",
  },
  coach,
  streamer,
  {
    id: "podcast-right",
    src: SOURCE_FRAME.src,
    alt: "Podcast host explaining a point with both hands",
    score: 95,
    duration: "0:36",
    caption: "Ship it before it feels ready",
    presetId: "karaoke",
    position: "98% 30%",
  },
  chef,
  trainer,
];

/** The word that changes in the hero headline. */
export const SOURCE_WORDS = ["podcast", "webinar", "interview", "livestream", "keynote", "lecture"];

/** One clip the demo run produced: its own frame from the source, hook title and where it starts. */
export type DemoCut = {
  src: string;
  title: string;
  /** Where the moment starts in the source. */
  at: string;
  caption: string;
  score: number;
  duration: string;
  presetId: string;
};

export type Demo = {
  id: string;
  label: string;
  src: string;
  alt: string;
  /** object-position for the 16:9 source thumbnail. */
  position: string;
  title: string;
  length: string;
  link: string;
  cuts: DemoCut[];
};

const moment = (demo: string, n: number) => `/landing/moment-${demo}-${n}.webp`;

/** The link-to-clips demo, one tab per kind of long video. Cuts are in rank order. */
export const DEMOS: Demo[] = [
  {
    id: "podcast",
    label: "Podcast",
    src: SOURCE_FRAME.src,
    alt: SOURCE_FRAME.alt,
    position: "50% 40%",
    title: "Episode 112 · Second albums",
    length: "1:12:40",
    link: "youtube.com/watch?v=episode-112",
    cuts: [
      { src: moment("podcast", 1), title: "Nearly quitting in year one", at: "8:14", caption: "I almost quit the show in year one", score: 97, duration: "0:42", presetId: "bold-pop" },
      { src: moment("podcast", 2), title: "Ship it before it feels ready", at: "31:52", caption: "Ship it before it feels ready", score: 95, duration: "0:36", presetId: "karaoke" },
      { src: moment("podcast", 3), title: "The audience always knows", at: "54:09", caption: "The audience always knows", score: 91, duration: "0:51", presetId: "highlighter" },
    ],
  },
  {
    id: "keynote",
    label: "Keynote",
    src: founder.src,
    alt: founder.alt,
    position: "50% 22%",
    title: "Launch keynote",
    length: "48:12",
    link: "vimeo.com/launch-keynote",
    cuts: [
      { src: moment("keynote", 1), title: "The accidental customer", at: "4:31", caption: "Our first customer found us by accident", score: 93, duration: "0:38", presetId: "spotlight" },
      { src: moment("keynote", 2), title: "One engineer, one launch", at: "17:48", caption: "We shipped it with one engineer", score: 90, duration: "0:44", presetId: "glass" },
      { src: moment("keynote", 3), title: "Pricing is a product call", at: "39:05", caption: "Pricing is a product decision", score: 88, duration: "0:29", presetId: "bold-pop" },
    ],
  },
  {
    id: "coaching",
    label: "Coaching",
    src: coach.src,
    alt: coach.alt,
    position: "50% 25%",
    title: "Weekly coaching call",
    length: "56:30",
    link: "youtube.com/watch?v=coaching-call",
    cuts: [
      { src: moment("coaching", 1), title: "Say less, and say it first", at: "6:12", caption: "Say less and say it first", score: 91, duration: "0:29", presetId: "sticker" },
      { src: moment("coaching", 2), title: "Calendar is strategy", at: "22:40", caption: "Your calendar is your strategy", score: 89, duration: "0:33", presetId: "highlighter" },
      { src: moment("coaching", 3), title: "The one-page plan", at: "47:18", caption: "Write the plan on one page", score: 86, duration: "0:41", presetId: "glass" },
    ],
  },
  {
    id: "livestream",
    label: "Livestream",
    src: streamer.src,
    alt: streamer.alt,
    position: "50% 30%",
    title: "Friday night stream",
    length: "3:04:55",
    link: "youtube.com/live/friday-night",
    cuts: [
      { src: moment("livestream", 1), title: "Nobody saw that clutch", at: "1:12:07", caption: "That clutch was pure luck honestly", score: 95, duration: "0:24", presetId: "neon" },
      { src: moment("livestream", 2), title: "Chat called it first", at: "1:58:33", caption: "Chat called it before I did", score: 92, duration: "0:19", presetId: "bubblegum" },
      { src: moment("livestream", 3), title: "One more round, then bed", at: "2:51:40", caption: "One more round then bed", score: 87, duration: "0:27", presetId: "jelly" },
    ],
  },
];

/** Ranked moments for the "know what to post first" stack. */
export const MOMENTS = [
  { quote: "I almost quit the show in year one", time: "04:12 – 04:54", score: 97, src: SOURCE_FRAME.src, position: "2% 30%" },
  { quote: "Ship it before it feels ready", time: "51:03 – 51:39", score: 95, src: SOURCE_FRAME.src, position: "98% 30%" },
  { quote: "Wait, you said that on air?", time: "33:40 – 34:12", score: 94, src: SOURCE_FRAME.src, position: "50% 40%" },
  { quote: "Nobody tells you the second album is harder", time: "18:27 – 19:15", score: 91, src: SOURCE_FRAME.src, position: "96% 26%" },
  { quote: "The audience always knows", time: "44:50 – 45:41", score: 88, src: SOURCE_FRAME.src, position: "4% 26%" },
];

/** How it works: one step per stage, shown beside a live product window. */
export const STEPS = [
  {
    title: "Paste a link or upload",
    body: "YouTube, Vimeo, a podcast feed or a file from your drive. Narriflow transcribes it in any of 99 languages.",
  },
  {
    title: "Get the moments that land",
    body: "Every moment that stands on its own is cut, framed on the speaker and ranked with a virality score.",
  },
  {
    title: "Make each clip yours",
    body: "Pick a caption style, apply your Brand Profile, and trim or extend any cut in the editor.",
  },
  {
    title: "Post everywhere at once",
    body: "Schedule to TikTok, YouTube Shorts, Instagram, Facebook, LinkedIn and X from one calendar.",
  },
] as const;

/** Presets offered in the caption lab, in display order. */
export const LAB_PRESET_IDS = [
  "bold-pop",
  "spotlight",
  "blast",
  "glass",
  "sticker",
  "highlighter",
  "bubblegum",
  "jelly",
  "neon",
  "karaoke",
  "retro",
  "cinema",
];

export type PlatformId = "tiktok" | "youtube" | "instagram" | "facebook" | "linkedin" | "x";

export const PLATFORMS: Array<{ id: PlatformId; name: string }> = [
  { id: "tiktok", name: "TikTok" },
  { id: "youtube", name: "YouTube Shorts" },
  { id: "instagram", name: "Instagram Reels" },
  { id: "facebook", name: "Facebook Reels" },
  { id: "linkedin", name: "LinkedIn" },
  { id: "x", name: "X" },
];

export const FAQS = [
  {
    q: "What counts as a processing minute?",
    a: "One minute of source video. A 60-minute episode uses 60 minutes on every plan, however many clips Narriflow finds in it.",
  },
  {
    q: "Which videos can I bring?",
    a: "Upload a file, or paste a YouTube, Vimeo or other supported video link. Podcast RSS feeds work too, and Autopilot can clip new episodes as they arrive.",
  },
  {
    q: "Which languages does it understand?",
    a: "Transcription covers 99 languages, and captions follow the language you recorded in. Pro adds voiceover dubbing so a clip can reach viewers in another language.",
  },
  {
    q: "Where can I publish?",
    a: "TikTok, YouTube Shorts, Instagram Reels, Facebook Reels, LinkedIn and X. Connect your accounts once, then post now or schedule from the calendar.",
  },
  {
    q: "Is there a free plan?",
    a: "Yes. Free includes 60 processing minutes a month, 720p exports with a watermark, and projects kept for 3 days. Paid plans remove the watermark and export in 1080p.",
  },
  {
    q: "Can I automate it?",
    a: "Business includes scoped API keys and MCP integrations. Drive Narriflow from your own code, from n8n, or from Claude, ChatGPT and Codex through the connector.",
  },
] as const;
