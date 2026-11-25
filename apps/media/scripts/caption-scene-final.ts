// The final re-verification (ticket 03, section 3): three key moments for each of the 16 Scene Styles through the
// triptych (sample | export | Studio), one time per call with retries (headless Chrome sometimes exits non-zero), the
// mae of each written to `out/final/mae.json` and the moments to `out/final/moments.json` for the contact sheet.
//
//   bun apps/media/scripts/caption-scene-final.ts [scene ...]     (needs `bunx next dev -p 3290` in apps/web)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { triptych } from "./caption-scene-triptych";

export const MOMENTS: Record<string, number[]> = {
  lyrics: [467, 2700, 5300],
  dialogue: [467, 2500, 5500],
  dossier: [400, 2400, 5700],
  hollow: [300, 2367, 4000],
  signal: [500, 2000, 3600],
  track: [400, 2167, 5100],
  bulletin: [400, 2600, 4233],
  ticker: [333, 2567, 7433],
  flap: [400, 2267, 6267],
  index: [467, 2700, 5300],
  punchline: [400, 5100, 6300],
  doodle: [1767, 3567, 6700],
  velocity: [400, 3400, 4600],
  wordform: [567, 2200, 4600],
  chrome: [2367, 2700, 3400],
  reveal: [467, 1500, 3200],
  spine: [400, 2100, 5400],
  boom: [1900, 3100, 3700],
  verified: [2800, 3567, 4000],
  aura: [800, 3633, 4367],
  slice: [400, 2133, 3000, 3700],
  heft: [500, 2267, 2700, 3733, 6100],
  stretch: [1300, 1967, 2433],
  hype: [467, 1500, 2267, 3300],
  premiere: [767, 2800, 6600],
  wonky: [733, 1700, 4400],
  tape: [1000, 2700, 3000, 4900],
  beat: [400, 1700, 2967, 4300, 6300],
  popup: [1500, 3233, 3700],
  trail: [900, 1667, 3000, 3133, 3533],
  cursor: [2400, 3100, 3600],
  wallpaper: [2700, 3300, 6100],
  arthouse: [467, 800, 1700, 3433, 3700, 4033],
  cascade: [400, 1000, 1900, 2867, 3233, 4133, 5833],
  ledge: [433, 1133, 2367, 2700, 2933, 5800],
  ransom: [467, 1300, 1833, 3300, 6500],
  shuffle: [433, 1000, 1667, 1767, 2033, 5400, 7000, 7800],
  slab: [400, 1500, 1833, 2000, 3900, 8233],
  labels: [433, 1067, 1400, 1567, 3100, 5000],
  squash: [480, 1100, 1500, 3100, 3800, 5200, 7000],
  googly: [400, 1300, 1567, 2600, 5600, 7600],
  bubble: [433, 1500, 1900, 3500, 5200, 7200],
  strike: [300, 367, 1200, 1300, 1467, 1900, 2233, 2400, 4400, 5367, 6533, 8733],
  seventies: [433, 1100, 1567, 1900, 3033, 4000, 5500, 6800, 8333],
  thermal: [267, 333, 433, 1167, 1233, 1467, 1867, 2967, 4867, 5967, 7900],
  slot: [433, 1200, 1433, 1800, 3500, 6200],
  inkup: [400, 800, 1500, 2000, 3800, 5300, 8200],
  primer: [450, 960, 1600, 3320],
  manifesto: [417, 1100, 1670, 3133],
  swipe: [433, 853, 1640, 2420],
  match: [473, 560, 900, 1730],
  scribble: [500, 1100, 1300, 2100],
  barrel: [480, 720, 1300, 1550],
  pills: [450, 1050, 1680, 2770],
  pixel: [403, 570, 1417, 2710],
  diecut: [380, 1370, 1620, 2700],
  sticky: [380, 910, 1320, 2220],
  brute: [450, 1120, 1400, 2980],
  mdrn: [460, 855, 1270, 2800],
  crosstape: [420, 1000, 1490, 1800],
  gumdrop: [480, 1500, 1900, 2360],
  combo: [600, 2060, 3000, 5380],
  receipt: [700, 1500, 2600, 3500, 4300],
  rainbow: [480, 1350, 1900, 3150, 4600, 6000],
  flowing: [450, 960, 1940, 2970],
  trace: [430, 1270, 1640, 1850],
  tunnel: [450, 1100, 2500, 2700, 4400, 6700],
  liquid: [480, 1200, 1900, 2250, 3000],
  chronicle: [700, 1500, 2700, 5200, 8900],
  broadway: [450, 1100, 1400, 2500, 2700, 3567, 5200],
  ripple: [1100, 1400, 2800, 5400, 6950, 8350],
  snipsnap: [450, 800, 1100, 1750, 2600],
  anime: [440, 850, 1300, 2300, 3300],
  bento: [450, 800, 1700, 2900, 4300, 6800],
  blinds: [450, 560, 1620, 1820, 2300, 6950],
  halftone: [450, 1000, 1400, 2400, 4450, 5600],
  pixelpop: [560, 900, 1200, 1500, 2300, 3150, 4300, 5500],
  tilt: [520, 1350, 1700, 2800, 3750, 5200],
  glint: [450, 1250, 1500, 2750, 3650, 5100, 5700, 6300],
  vibes: [520, 1050, 1500, 2300, 3100, 4500],
};

const out = new URL("../../../.scratch/motion-captions/out/final", import.meta.url).pathname;
mkdirSync(join(out, "triptych"), { recursive: true });
const maeFile = join(out, "mae.json");
const mae: Record<string, number | null> = existsSync(maeFile) ? JSON.parse(readFileSync(maeFile, "utf8")) : {};
const only = process.argv.slice(2);
for (const [scene, times] of Object.entries(MOMENTS)) {
  if (only.length > 0 && !only.includes(scene)) continue;
  for (const t of times) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const [result] = await triptych({ scene: scene as never, times: [t], outDir: join(out, "triptych") });
        mae[`${scene}-${result!.t}`] = result!.mae;
        break;
      } catch (error) {
        console.warn(`${scene} ${t} attempt ${attempt}: ${String(error).slice(0, 160)}`);
        if (attempt === 4) throw error;
      }
    }
  }
  writeFileSync(maeFile, JSON.stringify(mae, null, 1));
}
// Moments are stored on the 30 fps grid the triptych snaps to.
const frameMs = (t: number) => Math.round((Math.round((t * 30) / 1000) * 1000) / 30);
writeFileSync(join(out, "moments.json"), JSON.stringify(Object.fromEntries(Object.entries(MOMENTS).map(([scene, times]) => [scene, times.map(frameMs)])), null, 1));
