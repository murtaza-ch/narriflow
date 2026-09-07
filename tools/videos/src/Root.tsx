import "./index.css";
import { Composition } from "remotion";
import { MomentDetect } from "./MomentDetect";
import { CaptionLoop } from "./CaptionLoop";
import { RepurposeBurst } from "./RepurposeBurst";

// moment-detect: 5.6s + 4.9s + 2.9s scenes minus 16+12 transition frames
const MOMENT_DETECT_FRAMES = Math.round(5.6 * 30) + Math.round(4.9 * 30) + Math.round(2.9 * 30) - 16 - 12;
// caption-loop: 3 × 3.2s segments minus 2 × 12 transition frames
const CAPTION_LOOP_FRAMES = 3 * Math.round(3.2 * 30) - 2 * 12;

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="moment-detect"
        component={MomentDetect}
        durationInFrames={MOMENT_DETECT_FRAMES}
        fps={30}
        width={1600}
        height={1000}
      />
      <Composition
        id="caption-loop"
        component={CaptionLoop}
        durationInFrames={CAPTION_LOOP_FRAMES}
        fps={30}
        width={1080}
        height={1920}
      />
      <Composition
        id="repurpose-burst"
        component={RepurposeBurst}
        durationInFrames={8 * 30}
        fps={30}
        width={1200}
        height={1200}
      />
    </>
  );
};
