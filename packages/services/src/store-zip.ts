import { crc32 } from "node:zlib";

export interface ZipEntry {
  name: string;
  content: string;
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_DIRECTORY = 0x06054b50;
const UTF8_NAMES = 0x0800;
const VERSION = 20;

/** MS-DOS date and time, the only clock a ZIP entry has (two-second steps). */
function dosDateTime(date: Date) {
  return {
    date: ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
  };
}

/** A ZIP of small text files, stored without compression. Timelines and
 * subtitles are a few kilobytes, so this is all the format a download needs. */
export function storeZip(entries: readonly ZipEntry[], modifiedAt: Date): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const { date, time } = dosDateTime(modifiedAt);
  const files = entries.map((entry) => ({ name: encoder.encode(entry.name), data: encoder.encode(entry.content), crc: crc32(entry.content) }));
  const localSize = files.reduce((total, file) => total + 30 + file.name.length + file.data.length, 0);
  const directorySize = files.reduce((total, file) => total + 46 + file.name.length, 0);
  const bytes = new Uint8Array(localSize + directorySize + 22);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  const u16 = (value: number) => { view.setUint16(offset, value, true); offset += 2; };
  const u32 = (value: number) => { view.setUint32(offset, value, true); offset += 4; };
  const put = (value: Uint8Array) => { bytes.set(value, offset); offset += value.length; };

  const localOffsets = files.map((file) => {
    const start = offset;
    u32(LOCAL_HEADER); u16(VERSION); u16(UTF8_NAMES); u16(0); u16(time); u16(date);
    u32(file.crc); u32(file.data.length); u32(file.data.length); u16(file.name.length); u16(0);
    put(file.name); put(file.data);
    return start;
  });
  const directoryStart = offset;
  files.forEach((file, index) => {
    u32(CENTRAL_HEADER); u16(VERSION); u16(VERSION); u16(UTF8_NAMES); u16(0); u16(time); u16(date);
    u32(file.crc); u32(file.data.length); u32(file.data.length); u16(file.name.length);
    u16(0); u16(0); u16(0); u16(0); u32(0); u32(localOffsets[index]!);
    put(file.name);
  });
  u32(END_OF_DIRECTORY); u16(0); u16(0); u16(files.length); u16(files.length); u32(directorySize); u32(directoryStart); u16(0);
  return bytes;
}
