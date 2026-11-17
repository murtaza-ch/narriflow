from __future__ import annotations

from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
from threading import Event
from types import SimpleNamespace
import unittest

from narriflow_media.file_source_runtime import NativeFileRuntime


def top_level_atoms(path: Path):
    atoms, data, offset = [], path.read_bytes(), 0
    while offset + 8 <= len(data):
        size, kind = struct.unpack(">I4s", data[offset:offset + 8])
        if size == 1:
            size = struct.unpack(">Q", data[offset + 8:offset + 16])[0]
        atoms.append(kind.decode())
        if size == 0:
            break
        offset += size
    return atoms


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is not installed")
class ServiceSourceRemuxTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_fragmented_download_becomes_a_regular_mp4_with_its_index_first(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            fragmented = work / "original.bin"
            # The shape the download service delivers: empty moov, then moof/mdat fragments.
            subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25",
                            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "6", "-c:v", "libx264", "-g", "25",
                            "-c:a", "aac", "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", str(fragmented)], check=True)
            self.assertIn("moof", top_level_atoms(fragmented))
            starts = []
            session = SimpleNamespace(assert_live=lambda: None, remaining_seconds=120, on_process_start=starts.append, cancel_event=Event())
            output = await NativeFileRuntime(session).remux_faststart(fragmented, work)
            atoms = top_level_atoms(output)
            self.assertEqual(output.name, "original.mp4")
            self.assertNotIn("moof", atoms)
            self.assertLess(atoms.index("moov"), atoms.index("mdat"))
            self.assertFalse(fragmented.exists())
            self.assertEqual(len(starts), 1)
            streams = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", str(output)],
                                     capture_output=True, text=True, check=True).stdout.split()
            self.assertEqual(sorted(streams), ["audio", "video"])

    async def test_an_unreadable_download_is_a_retryable_failure_that_leaves_no_output(self):
        from narriflow_media.fetch import SourceFetchFailure
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            broken = work / "original.bin"
            broken.write_bytes(b"not a video")
            session = SimpleNamespace(assert_live=lambda: None, remaining_seconds=60, on_process_start=lambda pid: None, cancel_event=Event())
            with self.assertRaises(SourceFetchFailure) as failure:
                await NativeFileRuntime(session).remux_faststart(broken, work)
            self.assertEqual((failure.exception.code, failure.exception.retryable), ("source_download_failed", True))
            self.assertFalse((work / "original.mp4").exists())


if __name__ == "__main__":
    unittest.main()
