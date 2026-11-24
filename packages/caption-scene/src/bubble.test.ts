import { describeSpeechConformance } from "./conformance-support";
import { bubbleProgram } from "./templates/bubble";

describeSpeechConformance("bubble", bubbleProgram, { anchorLineY: 1300 });
