export interface SnapGuide {
  axis: "x" | "y";
  position: number;
}

const SNAP_LINES_X = [0, 33.333, 50, 66.667, 100];
const SNAP_LINES_Y = [0, 33.333, 50, 66.667, 100];
const SNAP_THRESHOLD = 2; // percentage points

export interface SnapResult {
  x: number;
  y: number;
  guides: SnapGuide[];
}

export function computeSnap(rawX: number, rawY: number): SnapResult {
  const guides: SnapGuide[] = [];
  let snappedX = rawX;
  let snappedY = rawY;

  for (const lineX of SNAP_LINES_X) {
    if (Math.abs(rawX - lineX) < SNAP_THRESHOLD) {
      snappedX = lineX;
      guides.push({ axis: "x", position: lineX });
      break;
    }
  }

  for (const lineY of SNAP_LINES_Y) {
    if (Math.abs(rawY - lineY) < SNAP_THRESHOLD) {
      snappedY = lineY;
      guides.push({ axis: "y", position: lineY });
      break;
    }
  }

  return { x: snappedX, y: snappedY, guides };
}
