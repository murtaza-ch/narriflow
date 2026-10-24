import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { TIMELINE_FORMATS, type FrameRate, type SourceProbe, type TimelineFormat } from "@narriflow/validators";
import { framesToTimecode, renderTimeline, secondsToFrames, TIMELINE_FILE_EXTENSIONS, timecodeToFrames, type TimelineInput } from "./timeline-export";

const NTSC_30: FrameRate = { numerator: 30000, denominator: 1001 };
const RATES = {
  "23.976": { numerator: 24000, denominator: 1001 },
  "25": { numerator: 25, denominator: 1 },
  "29.97": NTSC_30,
  "30": { numerator: 30, denominator: 1 },
  "59.94": { numerator: 60000, denominator: 1001 },
} as const satisfies Record<string, FrameRate>;

function probe(frameRate: FrameRate, overrides: Partial<SourceProbe> = {}, startTimecode: string | null = null): SourceProbe {
  return {
    durationSec: 600.6,
    video: { width: 1920, height: 1080, frameRate, startTimecode },
    audio: { sampleRate: 48_000, channels: 2 },
    ...overrides,
  };
}

/** Kept ranges of the source, laid end to end on the edited timeline the way
 * the cut plan lays them. */
function cutsOf(...ranges: Array<[start: number, end: number]>): TimelineInput["cuts"] {
  let edited = 0;
  return ranges.map(([start, end]) => {
    const cut = { sourceStartSec: start, editedStartSec: edited, editedEndSec: Math.round((edited + end - start) * 1000) / 1000 };
    edited = cut.editedEndSec;
    return cut;
  });
}

const TWO_CUTS = cutsOf([12, 14.5], [20.25, 21.5]);

function input(frameRate: FrameRate, overrides: Partial<TimelineInput> = {}): TimelineInput {
  return { title: "Big idea & more", sourceFileName: "my-talk-source.mp4", source: probe(frameRate), cuts: TWO_CUTS, ...overrides };
}

describe("frame and timecode math", () => {
  // One minute, one second, and a tenth of a second in: 61.2 s.
  test.each([
    ["23.976", 1467, "00:01:01:03"],
    ["25", 1530, "00:01:01:05"],
    ["29.97", 1834, "00:01:01:04"],
    ["30", 1836, "00:01:01:06"],
    ["59.94", 3668, "00:01:01:08"],
  ] as const)("%s fps counts exact frames and non-drop timecode", (name, frames, timecode) => {
    expect(secondsToFrames(61.2, RATES[name])).toBe(frames);
    expect(framesToTimecode(frames, RATES[name])).toBe(timecode);
  });

  test("an hour of NTSC footage is 107892 frames, labelled 00:59:56:12 in non-drop timecode", () => {
    expect(secondsToFrames(3600, NTSC_30)).toBe(107_892);
    expect(framesToTimecode(107_892, NTSC_30)).toBe("00:59:56:12");
    expect(secondsToFrames(3600, RATES["25"])).toBe(90_000);
    expect(framesToTimecode(90_000, RATES["25"])).toBe("01:00:00:00");
  });

  test("a half frame rounds up the same way every time", () => {
    // 0.02 s at 25 fps is exactly half a frame.
    expect(secondsToFrames(0.02, RATES["25"])).toBe(1);
    expect(secondsToFrames(0.06, RATES["25"])).toBe(2);
    expect(secondsToFrames(0.019, RATES["25"])).toBe(0);
  });
});

// One second of footage starting 61.2 s into the source, hand-counted per rate.
describe("one second at 61.2 s, per frame rate", () => {
  const ONE_SECOND = cutsOf([61.2, 62.2]);
  const oneSecond = (frameRate: FrameRate) => input(frameRate, { cuts: ONE_SECOND, source: probe(frameRate, { durationSec: 3600 }) });

  test.each([
    ["23.976", "00:01:01:03 00:01:02:03 01:00:00:00 01:00:01:00"],
    ["25", "00:01:01:05 00:01:02:05 01:00:00:00 01:00:01:00"],
    ["29.97", "00:01:01:04 00:01:02:04 01:00:00:00 01:00:01:00"],
    ["30", "00:01:01:06 00:01:02:06 01:00:00:00 01:00:01:00"],
    ["59.94", "00:01:01:08 00:01:02:08 01:00:00:00 01:00:01:00"],
  ] as const)("%s fps EDL event", (name, timecodes) => {
    expect(renderTimeline("edl", oneSecond(RATES[name]))).toContain(`AA/V  C        ${timecodes}\n`);
  });

  test.each([
    ["23.976", 1467, 1491, "489489/8000s", "1001/1000s"],
    ["25", 1530, 1555, "306/5s", "1s"],
    ["29.97", 1834, 1864, "917917/15000s", "1001/1000s"],
    ["30", 1836, 1866, "306/5s", "1s"],
    ["59.94", 3668, 3728, "917917/15000s", "1001/1000s"],
  ] as const)("%s fps xmeml frames and FCPXML time", (name, inFrame, outFrame, start, duration) => {
    const xmeml = renderTimeline("xmeml", oneSecond(RATES[name]));
    expect(xmeml).toContain(`<in>${inFrame}</in>`);
    expect(xmeml).toContain(`<out>${outFrame}</out>`);
    const clip = renderTimeline("fcpxml", oneSecond(RATES[name])).split("\n").find((line) => line.includes("<asset-clip"))!;
    expect(clip).toContain(`start="${start}" duration="${duration}"`);
  });
});

describe("EDL", () => {
  test("cuts become events in order, with continuous record timecode from 01:00:00:00", () => {
    expect(renderTimeline("edl", input(NTSC_30))).toBe([
      "TITLE: Big idea & more",
      "FCM: NON-DROP FRAME",
      "",
      "001  AX       AA/V  C        00:00:12:00 00:00:14:15 01:00:00:00 01:00:02:15",
      "* FROM CLIP NAME: my-talk-source.mp4",
      "002  AX       AA/V  C        00:00:20:07 00:00:21:14 01:00:02:15 01:00:03:22",
      "* FROM CLIP NAME: my-talk-source.mp4",
      "",
    ].join("\n"));
  });

  test("a source without audio is a video-only event", () => {
    expect(renderTimeline("edl", input(RATES["25"], { source: probe(RATES["25"], { audio: null }) }))).toContain("001  AX       V     C        00:00:12:00 00:00:14:13 01:00:00:00 01:00:02:13\n");
  });
});

describe("xmeml", () => {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", isArray: (name) => ["clipitem", "track", "link"].includes(name) });

  test("is well-formed XML with one video clip item per cut and one audio track per channel", () => {
    const text = renderTimeline("xmeml", input(NTSC_30));
    expect(XMLValidator.validate(text)).toBe(true);
    const { xmeml } = parser.parse(text);
    expect(xmeml["@_version"]).toBe("5");
    const sequence = xmeml.sequence;
    expect(sequence.name).toBe("Big idea & more");
    expect(sequence.duration).toBe(112);
    expect(sequence.rate).toEqual({ timebase: 30, ntsc: "TRUE" });
    expect(sequence.media.video.format.samplecharacteristics).toMatchObject({ width: 1920, height: 1080 });

    const [videoTrack] = sequence.media.video.track;
    expect(videoTrack.clipitem.map((item: Record<string, number>) => [item.start, item.end, item.in, item.out])).toEqual([
      [0, 75, 360, 435],
      [75, 112, 607, 644],
    ]);
    expect(sequence.media.audio.numOutputChannels).toBe(2);
    expect(sequence.media.audio.track).toHaveLength(2);
    for (const track of sequence.media.audio.track) {
      expect(track.clipitem.map((item: Record<string, number>) => [item.start, item.end, item.in, item.out])).toEqual([
        [0, 75, 360, 435],
        [75, 112, 607, 644],
      ]);
    }
  });

  test("defines the source file once and every other item refers to it by id", () => {
    const text = renderTimeline("xmeml", input(NTSC_30));
    expect(text.match(/<file id="file-1">/g)).toHaveLength(1);
    expect(text.match(/<file id="file-1"\/>/g)).toHaveLength(5);
    const { xmeml } = parser.parse(text);
    const file = xmeml.sequence.media.video.track[0].clipitem[0].file;
    expect(file).toMatchObject({ name: "my-talk-source.mp4", pathurl: "my-talk-source.mp4", duration: 18_000 });
    expect(file.media.audio).toMatchObject({ channelcount: 2 });
  });

  test("links each video item to the audio items cut from it", () => {
    const { xmeml } = parser.parse(renderTimeline("xmeml", input(NTSC_30)));
    const ids = (items: Array<Record<string, string>>) => items.map((item) => item["@_id"]);
    const [video] = xmeml.sequence.media.video.track;
    const audio = xmeml.sequence.media.audio.track;
    expect(ids(video.clipitem)).toEqual(["clipitem-1", "clipitem-2"]);
    expect(ids(audio[0].clipitem)).toEqual(["clipitem-3", "clipitem-4"]);
    expect(ids(audio[1].clipitem)).toEqual(["clipitem-5", "clipitem-6"]);
    expect(video.clipitem[0].link.map((link: Record<string, string>) => link.linkclipref)).toEqual(["clipitem-1", "clipitem-3", "clipitem-5"]);
    expect(audio[1].clipitem[1].link.map((link: Record<string, string>) => link.linkclipref)).toEqual(["clipitem-2", "clipitem-4", "clipitem-6"]);
  });

  test.each([
    ["23.976", 24, "TRUE"],
    ["25", 25, "FALSE"],
    ["29.97", 30, "TRUE"],
    ["30", 30, "FALSE"],
    ["59.94", 60, "TRUE"],
  ] as const)("%s fps is timebase %i, ntsc %s", (name, timebase, ntsc) => {
    const { xmeml } = parser.parse(renderTimeline("xmeml", input(RATES[name])));
    expect(xmeml.sequence.rate).toEqual({ timebase, ntsc });
    expect(xmeml.sequence.timecode.rate).toEqual({ timebase, ntsc });
  });

  test("escapes names and omits audio for a silent source", () => {
    const text = renderTimeline("xmeml", input(RATES["25"], { title: 'A <b> "quote" & more', source: probe(RATES["25"], { audio: null }) }));
    expect(XMLValidator.validate(text)).toBe(true);
    expect(text).toContain("<name>A &lt;b&gt; &quot;quote&quot; &amp; more</name>");
    const { xmeml } = parser.parse(text);
    expect(xmeml.sequence.media.audio).toBeUndefined();
    expect(xmeml.sequence.media.video.track[0].clipitem[0].link).toHaveLength(1);
  });
});

describe("FCPXML 1.11", () => {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", isArray: (name) => name === "asset-clip" });

  test("is well-formed XML whose spine cuts the asset in order, in exact rational time", () => {
    const text = renderTimeline("fcpxml", input(NTSC_30));
    expect(XMLValidator.validate(text)).toBe(true);
    const { fcpxml } = parser.parse(text);
    expect(fcpxml["@_version"]).toBe("1.11");
    expect(fcpxml.resources.format).toEqual({ "@_id": "r1", "@_frameDuration": "1001/30000s", "@_width": "1920", "@_height": "1080" });
    expect(fcpxml.resources.asset).toMatchObject({ "@_id": "r2", "@_start": "0s", "@_duration": "3003/5s", "@_format": "r1", "@_audioChannels": "2", "@_audioRate": "48000" });
    expect(fcpxml.resources.asset["media-rep"]).toEqual({ "@_kind": "original-media", "@_src": "my-talk-source.mp4" });
    const project = fcpxml.library.event.project;
    expect(project["@_name"]).toBe("Big idea & more");
    expect(project.sequence).toMatchObject({ "@_format": "r1", "@_duration": "7007/1875s", "@_tcStart": "0s", "@_tcFormat": "NDF", "@_audioLayout": "stereo", "@_audioRate": "48k" });
    const clips = project.sequence.spine["asset-clip"];
    expect(clips.map((clip: Record<string, string>) => [clip["@_ref"], clip["@_offset"], clip["@_start"], clip["@_duration"]])).toEqual([
      ["r2", "0s", "3003/250s", "1001/400s"],
      ["r2", "1001/400s", "607607/30000s", "37037/30000s"],
    ]);
  });

  test.each([
    ["23.976", "1001/24000s"],
    ["25", "1/25s"],
    ["29.97", "1001/30000s"],
    ["30", "1/30s"],
    ["59.94", "1001/60000s"],
  ] as const)("%s fps has frame duration %s", (name, frameDuration) => {
    const { fcpxml } = parser.parse(renderTimeline("fcpxml", input(RATES[name])));
    expect(fcpxml.resources.format["@_frameDuration"]).toBe(frameDuration);
  });

  test("offsets are contiguous and sum to the sequence duration", () => {
    const { fcpxml } = parser.parse(renderTimeline("fcpxml", input(RATES["59.94"])));
    const frame = (time: string) => {
      if (time === "0s") return 0;
      const [numerator, denominator] = time.replace("s", "").split("/").map(Number) as [number, number];
      return Math.round((numerator / (denominator ?? 1)) * 60000 / 1001);
    };
    const clips = fcpxml.library.event.project.sequence.spine["asset-clip"] as Array<Record<string, string>>;
    let cursor = 0;
    for (const clip of clips) {
      expect(frame(clip["@_offset"]!)).toBe(cursor);
      cursor += frame(clip["@_duration"]!);
    }
    expect(frame(fcpxml.library.event.project.sequence["@_duration"])).toBe(cursor);
  });

  // Apple's DTD is not in the repository. Point FCPXML_DTD at a copy (1.10's
  // version attribute is fixed to "1.10", so edit it to "1.11") to validate.
  test.skipIf(!process.env.FCPXML_DTD)("validates against Apple's DTD", () => {
    for (const frameRate of Object.values(RATES)) {
      const result = Bun.spawnSync(["xmllint", "--noout", "--dtdvalid", process.env.FCPXML_DTD!, "-"], { stdin: new TextEncoder().encode(renderTimeline("fcpxml", input(frameRate))) });
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
    }
  });

  test("audio is described only when the source has it, and sample rates FCPXML does not name are left off the sequence", () => {
    const silent = parser.parse(renderTimeline("fcpxml", input(RATES["25"], { source: probe(RATES["25"], { audio: null }) }))).fcpxml;
    expect(silent.resources.asset["@_hasAudio"]).toBeUndefined();
    expect(silent.library.event.project.sequence["@_audioLayout"]).toBeUndefined();
    const odd = parser.parse(renderTimeline("fcpxml", input(RATES["25"], { source: probe(RATES["25"], { audio: { sampleRate: 22_050, channels: 1 } }) }))).fcpxml;
    expect(odd.library.event.project.sequence["@_audioRate"]).toBeUndefined();
    expect(odd.library.event.project.sequence["@_audioLayout"]).toBe("mono");
  });
});

describe("every format", () => {
  test.each(TIMELINE_FORMATS)("%s drops a cut shorter than a frame", (format) => {
    const text = renderTimeline(format, input(RATES["25"], { cuts: cutsOf([5, 5.01], [12, 14.5], [20.25, 21.5]) }));
    expect(text.match(format === "edl" ? /^\d{3} /gm : /<clipitem id="clipitem-\d+">|<asset-clip /g)).toHaveLength(format === "xmeml" ? 6 : 2);
    expect(text).not.toContain(format === "edl" ? "00:00:05:00" : "<in>125</in>");
  });

  test.each(TIMELINE_FORMATS)("%s refuses a timeline with no video, or with no footage, as a typed failure", (format) => {
    expect(() => renderTimeline(format, input(RATES["25"], { source: probe(RATES["25"], { video: null }) }))).toThrow(expect.objectContaining({ code: "timeline_video_required", kind: "unprocessable" }));
    expect(() => renderTimeline(format, input(RATES["25"], { cuts: [] }))).toThrow(expect.objectContaining({ code: "timeline_empty", kind: "unprocessable" }));
    expect(() => renderTimeline(format, input(RATES["25"], { cuts: cutsOf([5, 5.01]) }))).toThrow(expect.objectContaining({ code: "timeline_empty" }));
  });

  test.each(TIMELINE_FORMATS)("%s never reaches past the end of the source file", (format) => {
    const text = renderTimeline(format, input(RATES["25"], { source: probe(RATES["25"], { durationSec: 13 }), cuts: cutsOf([12, 20]) }));
    if (format === "edl") expect(text).toContain("00:00:12:00 00:00:13:00 01:00:00:00 01:00:01:00");
    if (format === "xmeml") expect(text).toContain("<out>325</out>");
    if (format === "fcpxml") expect(text).toContain('duration="1s"');
  });
});

describe("many cuts", () => {
  // 20 cuts of 1.013 s: each is 25.325 frames at 25 fps, so rounding every cut
  // on its own drifts by a third of a frame per cut. Record time follows the
  // edited timeline instead, the same clock the captions use.
  const ranges = Array.from({ length: 20 }, (_, index): [number, number] => [10 + index * 3, 10 + index * 3 + 1.013]);
  const cuts = cutsOf(...ranges);
  const parser = new XMLParser({ ignoreAttributes: false, isArray: (name) => ["clipitem", "track"].includes(name) });

  test("every cut starts on the frame of its edited time and the last ends on the frame of the edited duration", () => {
    const { xmeml } = parser.parse(renderTimeline("xmeml", input(RATES["25"], { cuts })));
    const items = xmeml.sequence.media.video.track[0].clipitem as Array<Record<string, number>>;
    expect(items).toHaveLength(20);
    items.forEach((item, index) => {
      expect(item.start).toBe(secondsToFrames(cuts[index]!.editedStartSec, RATES["25"]));
      expect(Math.abs(item.start! / 25 - cuts[index]!.editedStartSec)).toBeLessThanOrEqual(0.02);
      if (index > 0) expect(item.start).toBe(items[index - 1]!.end);
      expect(item.in).toBe(secondsToFrames(cuts[index]!.sourceStartSec, RATES["25"]));
    });
    const total = cuts.at(-1)!.editedEndSec;
    expect(items.at(-1)!.end).toBe(secondsToFrames(total, RATES["25"]));
    expect(Math.abs(items.at(-1)!.end! / 25 - total)).toBeLessThanOrEqual(0.02);
    expect(xmeml.sequence.duration).toBe(items.at(-1)!.end);
  });

  test("the EDL and FCPXML agree with the xmeml on where the last cut ends", () => {
    const end = secondsToFrames(cuts.at(-1)!.editedEndSec, RATES["25"]);
    expect(renderTimeline("edl", input(RATES["25"], { cuts }))).toContain(`${framesToTimecode(90_000 + end, RATES["25"])}\n`);
    const { fcpxml } = new XMLParser({ ignoreAttributes: false }).parse(renderTimeline("fcpxml", input(RATES["25"], { cuts })));
    const [seconds, divisor = "1"] = String(fcpxml.library.event.project.sequence["@_duration"]).replace("s", "").split("/");
    expect(Math.round((Number(seconds) / Number(divisor)) * 25)).toBe(end);
  });
});

describe("drop-frame timecode", () => {
  test.each([
    [NTSC_30, 1799, "00:00:59;29"],
    [NTSC_30, 1800, "00:01:00;02"],
    [NTSC_30, 17_982, "00:10:00;00"],
    [NTSC_30, 107_892, "01:00:00;00"],
    [RATES["59.94"], 3599, "00:00:59;59"],
    [RATES["59.94"], 3600, "00:01:00;04"],
    [RATES["59.94"], 35_964, "00:10:00;00"],
  ] as const)("%j frame %i is %s", (rate, frames, timecode) => {
    expect(framesToTimecode(frames, rate, true)).toBe(timecode);
    expect(timecodeToFrames(timecode, rate)).toEqual({ frames, dropFrame: true });
  });

  test("every frame round-trips through its label", () => {
    for (const rate of [NTSC_30, RATES["59.94"]]) {
      for (let frames = 0; frames < 250_000; frames += 7) {
        expect(timecodeToFrames(framesToTimecode(frames, rate, true), rate).frames).toBe(frames);
      }
    }
  });

  test("a colon-separated label is non-drop-frame, and rates without drop-frame ignore the mark", () => {
    expect(timecodeToFrames("01:00:00:00", NTSC_30)).toEqual({ frames: 108_000, dropFrame: false });
    expect(timecodeToFrames("01:00:00;00", RATES["25"])).toEqual({ frames: 90_000, dropFrame: false });
    expect(framesToTimecode(1800, RATES["30"], true)).toBe("00:01:00:00");
  });
});

describe("a source with an embedded start timecode", () => {
  const oneCut = cutsOf([12, 14.5]);

  test("the EDL reads source timecode from it and leaves record timecode alone", () => {
    const text = renderTimeline("edl", input(RATES["25"], { source: probe(RATES["25"], {}, "10:00:00:00"), cuts: oneCut }));
    expect(text).toContain("FCM: NON-DROP FRAME");
    expect(text).toContain("AA/V  C        10:00:12:00 10:00:14:13 01:00:00:00 01:00:02:13\n");
  });

  test("xmeml states the file's start timecode and keeps in and out relative to the file", () => {
    const { xmeml } = new XMLParser({ isArray: (name) => ["clipitem", "track"].includes(name) }).parse(
      renderTimeline("xmeml", input(RATES["25"], { source: probe(RATES["25"], {}, "10:00:00:00"), cuts: oneCut })));
    const item = xmeml.sequence.media.video.track[0].clipitem[0];
    expect(item.file.timecode).toMatchObject({ string: "10:00:00:00", frame: 900_000, displayformat: "NDF" });
    expect([item.in, item.out]).toEqual([300, 363]);
    expect(xmeml.sequence.timecode).toMatchObject({ string: "00:00:00:00", frame: 0 });
  });

  test("FCPXML starts the asset at it and cuts from there", () => {
    const { fcpxml } = new XMLParser({ ignoreAttributes: false, isArray: (name) => name === "asset-clip" }).parse(
      renderTimeline("fcpxml", input(RATES["25"], { source: probe(RATES["25"], {}, "10:00:00:00"), cuts: oneCut })));
    expect(fcpxml.resources.asset["@_start"]).toBe("36000s");
    expect(fcpxml.library.event.project.sequence.spine["asset-clip"][0]["@_start"]).toBe("36012s");
  });

  test("a drop-frame start timecode makes the whole timeline drop-frame", () => {
    const source = probe(NTSC_30, {}, "01:00:00;00");
    const edl = renderTimeline("edl", input(NTSC_30, { source, cuts: cutsOf([12, 14.5]) }));
    expect(edl).toContain("FCM: DROP FRAME");
    expect(edl).toContain("AA/V  C        01:00:12;00 01:00:14;15 01:00:00;00 01:00:02;15\n");
    const xmeml = renderTimeline("xmeml", input(NTSC_30, { source, cuts: cutsOf([12, 14.5]) }));
    expect(xmeml).toContain("<string>01:00:00;00</string>");
    expect(xmeml).toContain("<frame>107892</frame>");
    expect(xmeml.match(/<displayformat>DF<\/displayformat>/g)).toHaveLength(2);
    const fcpxml = renderTimeline("fcpxml", input(NTSC_30, { source, cuts: cutsOf([12, 14.5]) }));
    expect(fcpxml).toContain('tcFormat="DF"');
    expect(fcpxml).not.toContain('tcFormat="NDF"');
  });
});

// Golden files hold the exact text editors import. Review them by eye when
// they change; regenerate with UPDATE_GOLDEN=1.
describe("golden files", () => {
  const directory = join(import.meta.dir, "timeline-golden");
  function golden(name: string, format: TimelineFormat, text: string) {
    const path = join(directory, `${name}.${TIMELINE_FILE_EXTENSIONS[format]}`);
    if (process.env.UPDATE_GOLDEN) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(path, text);
    }
    expect(text).toBe(readFileSync(path, "utf8"));
  }

  test.each(TIMELINE_FORMATS)("29.97 fps stereo source, two cuts: %s", (format: TimelineFormat) => {
    golden("29.97-two-cuts", format, renderTimeline(format, input(NTSC_30)));
  });

  test.each(TIMELINE_FORMATS)("29.97 fps source with a drop-frame start timecode: %s", (format: TimelineFormat) => {
    golden("29.97-drop-frame-start", format, renderTimeline(format, input(NTSC_30, { source: probe(NTSC_30, {}, "01:00:00;00") })));
  });
});
