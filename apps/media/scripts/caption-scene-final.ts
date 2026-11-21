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
  cursor: [2400, 3100, 3600],
  wallpaper: [2700, 3300, 6100],
  arthouse: [467, 800, 1700, 3433, 3700, 4033],
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
