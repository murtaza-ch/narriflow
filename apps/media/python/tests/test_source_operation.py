from __future__ import annotations

from pathlib import Path
import tempfile
from threading import Event
from types import SimpleNamespace
import unittest
from uuid import uuid4

from narriflow_media.fetch import SourceFetchFailure
from narriflow_media.source_runtime import run_fetch_source,run_pin_source
from narriflow_media.transfer import WorkPackage, _wire


class SourceOperationTests(unittest.IsolatedAsyncioTestCase):
    def fixture(self, *, seeded=False, fingerprint="a"*64):
        trace = []
        fence = {"reference": {"inputHash": "b"*64}, "attemptToken": str(uuid4()), "owner": str(uuid4())}
        session = SimpleNamespace(fence=fence, assert_live=lambda: None, cancel_event=Event(), remaining_seconds=120,
                                  on_process_start=lambda pid: trace.append("start"))
        project_id, audio_id = str(uuid4()), str(uuid4())
        audio = {"sourceAudioId": audio_id, "projectId": project_id, "sourceRevision": 1,
            "mediaIdentity": {"provider":"youtube","mediaId":"dQw4w9WgXcQ"},
            "audioTrack": {"id":"140","language":"en","codec":"aac","sampleRate":48000,"channels":2},
            "object": {"key":"assigned/audio","etag":'"etag"',"byteLength":5,"sha256":"c"*64},
            "durationSeconds":120,"wholeSource":True,"audioStartTimeSec":0,
            "probeVersion":"normalized-probe-v1","toolchainFingerprint":"a"*64}
        command = {"kind":"youtube_source","audioPolicy":"pending_pack","projectId":project_id,"sourceRevision":1,"mediaId":"dQw4w9WgXcQ",
            "sourceAudioId": audio_id, "toolchainFingerprint":"a"*64,"probeVersion":"normalized-probe-v1",
            "existingSourceAudio":audio if seeded else None,"languageProbe":None}
        package = WorkPackage("fetch_source","b"*64,_wire(command),_wire([]),_wire([]),_wire(fence))
        class Runtime:
            def __init__(self, **options): trace.append("runtime"); self.start = options["on_process_start"]
            async def resolve(self, source, proxy, work): self.start(123); return source
        class Sink:
            def __init__(self, *args, **options): pass
            async def refresh_optional_probe(self):
                if trace[-1] != "start": raise AssertionError("Probe assigned before the real metadata start")
                trace.append("seeded_probe")
        async def verify(*args, **options): trace.append("verify"); return fingerprint
        async def fetch(source, **options):
            self.assertEqual(source.media_id,"dQw4w9WgXcQ")
            await options["runtime"].resolve(source,None,options["work_directory"])
            trace.append("fetch")
            self.assertEqual(options["mode"],"local")
            self.assertEqual(options["existing_audio"] is not None,seeded)
        return session,package,trace,Runtime,Sink,verify,fetch

    async def test_same_library_starts_from_verified_input_and_refreshes_seeded_probe_after_real_start(self):
        session,package,trace,runtime,sink,verify,fetch = self.fixture(seeded=True)
        with tempfile.TemporaryDirectory() as directory:
            await run_fetch_source(session,package,Path(directory),mode="local",development=True,
                token_server_home=Path("/trusted/token-helper"),runtime_class=runtime,sink_class=sink,verify_runtime=verify,fetch=fetch)
        self.assertEqual(trace,["verify","runtime","start","seeded_probe","fetch"])

    async def test_direct_sources_use_verified_native_work_without_a_youtube_proxy_configuration(self):
        session,package,trace,_runtime,_sink,verify,_fetch=self.fixture()
        command=package.command;command.pop('mediaId');command.update(kind='direct_source',mediaIdentity={'provider':'rss','mediaId':'episode1'},source={'provider':'rss','url':'https://feed.example/audio','authorization':None})
        package=WorkPackage('fetch_source',package.input_hash,_wire(command),_wire([]),_wire([]),_wire(session.fence))
        async def direct(session,package,work,**options):trace.append('direct')
        with tempfile.TemporaryDirectory() as directory:
            await run_fetch_source(session,package,Path(directory),mode='proxy',development=False,proxy_template=None,
                token_server_home=Path('/trusted/token-helper'),verify_runtime=verify,direct_operation=direct)
        self.assertEqual(trace,['verify','direct'])

    async def test_pin_source_verifies_the_image_before_starting_its_conditional_copy(self):
        session,package,trace,_runtime,_sink,verify,_fetch=self.fixture()
        command=package.command;command.pop('mediaId');command.update(kind='upload_source',mediaIdentity={'provider':'upload','mediaId':str(uuid4())},source={'storageKey':'uploads/frozen','etag':'"frozen"','byteLength':5,'contentType':'video/mp4'})
        package=WorkPackage('pin_source',package.input_hash,_wire(command),_wire([]),_wire([]),_wire(session.fence))
        async def pin(session,package,work,**options):trace.append('pin')
        with tempfile.TemporaryDirectory() as directory:
            await run_pin_source(session,package,Path(directory),verify_runtime=verify,pin_operation=pin)
        self.assertEqual(trace,['verify','pin'])

    async def test_wrong_image_fingerprint_starts_no_metadata_or_media_process(self):
        session,package,trace,runtime,sink,verify,fetch = self.fixture(fingerprint="e"*64)
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(SourceFetchFailure,"source_runtime_invalid"):
                await run_fetch_source(session,package,Path(directory),mode="local",development=True,
                    token_server_home=Path("/trusted/token-helper"),runtime_class=runtime,sink_class=sink,verify_runtime=verify,fetch=fetch)
        self.assertEqual(trace,["verify"])

    async def test_production_local_or_unconfigured_proxy_is_refused_before_native_preflight(self):
        for mode in ["local","proxy"]:
            session,package,trace,runtime,sink,verify,fetch = self.fixture()
            with self.assertRaisesRegex(SourceFetchFailure,"source_fetch_mode_forbidden"):
                await run_fetch_source(session,package,Path("/unused"),mode=mode,development=False,
                    token_server_home=Path("/trusted/token-helper"),runtime_class=runtime,sink_class=sink,verify_runtime=verify,fetch=fetch)
            self.assertEqual(trace,[])
