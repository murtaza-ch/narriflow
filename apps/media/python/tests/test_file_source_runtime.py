from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
from threading import Event
from types import SimpleNamespace
import unittest
from uuid import uuid4
import wave

from narriflow_media.file_source_runtime import NativeFileRuntime,run_direct_source
from narriflow_media.fetch import FileSnapshot,SourceFetchFailure,probe_failure
from narriflow_media.multipart import CompletedObject
from narriflow_media.source_sink import ScopedSourceSink
from narriflow_media.transfer import WorkPackage,_wire


class FileSourceOperationTests(unittest.IsolatedAsyncioTestCase):
    async def test_audio_extracted_past_a_minute_boundary_publishes_and_a_real_difference_stops(self):
        events=[]
        with tempfile.TemporaryDirectory() as directory:
            work=Path(directory);fence={'reference':{'inputHash':'a'*64},'attemptToken':str(uuid4()),'owner':str(uuid4())}
            session=SimpleNamespace(fence=fence,assert_live=lambda:None);durations={'audio':60.011}
            command={'kind':'direct_source','audioPolicy':'required','projectId':str(uuid4()),'sourceRevision':1,'mediaIdentity':{'provider':'direct','mediaId':'frozen'},'sourceAudioId':fence['attemptToken'],
                'toolchainFingerprint':'d'*64,'probeVersion':'normalized-probe-v1','existingSourceAudio':None,'languageProbe':None,'source':{}}
            package=WorkPackage('fetch_source','a'*64,_wire(command),_wire([]),_wire([{'role':'source_video','contentTypes':['video/mp4']}]),_wire(fence))
            class Runtime:
                async def download(self,source,work):
                    path=work/'original';path.write_bytes(b'v');return path,'video/mp4'
                async def extract_audio(self,path,probe,work):
                    audio=work/'audio';audio.write_bytes(b'a');return audio
                async def probe(self,path):return {'durationSec':durations['audio'] if path.name=='audio' else 60.0,'hasAudio':True,'hasVideo':path.name=='original','probeVersion':'normalized-probe-v1',
                    'facts':{'audios':[{'index':0,'codec':'aac','sampleRate':48000,'channels':2,'startTimeSec':0}],'videos':[]}}
                async def hash(self,path):return FileSnapshot.read(path),hashlib.sha256(path.read_bytes()).hexdigest()
            class Sink:
                def __init__(self,*args,**kwargs):pass
                async def audio_ready(self,artifact):events.append('audio')
                async def video_ready(self,*args):events.append('video')
            await run_direct_source(session,package,work,runtime=Runtime(),sink_class=Sink)
            self.assertEqual(events,['audio','video'])
            events.clear();durations['audio']=62.0
            for name in ('original','audio'):(work/name).unlink()
            with self.assertRaisesRegex(SourceFetchFailure,'source_audio_video_mismatch'):
                await run_direct_source(session,package,work,runtime=Runtime(),sink_class=Sink)
            self.assertEqual(events,[])

    async def test_a_file_no_probe_can_read_fails_once_with_its_permanent_code(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'upload.mp4';path.write_bytes(b'not media at all')
            session=SimpleNamespace(assert_live=lambda:None,remaining_seconds=60,on_process_start=lambda pid:None,cancel_event=Event())
            with self.assertRaises(SourceFetchFailure) as failure:
                await NativeFileRuntime(session).probe(path)
            self.assertEqual((failure.exception.code,failure.exception.retryable),('source_media_invalid',False))

    def test_only_a_coded_permanent_probe_failure_stops_retries(self):
        permanent=probe_failure(b'bun warning\n{"level":"error","message":"source_media_invalid","errorCode":"source_media_invalid","retryable":false}\n')
        self.assertEqual((permanent.code,permanent.retryable),('source_media_invalid',False))
        for stderr in (b'',b'not json',b'{"errorCode":"source_media_invalid","retryable":true}',b'{"errorCode":"NOT A CODE","retryable":false}',b'[]'):
            transient=probe_failure(stderr)
            self.assertEqual((transient.code,transient.retryable),('source_probe_failed',True))

    async def actual_file_operation(self,*,policy="required",silent=False):
        root=Path(__file__).resolve().parents[4]
        with tempfile.TemporaryDirectory() as directory:
            work=Path(directory);original=work/('fixture.mp4' if silent else 'fixture.wav');marker=work/'acknowledged'
            if silent:
                subprocess.run(['ffmpeg','-v','error','-y','-f','lavfi','-i','testsrc2=s=16x16:r=30','-t','1','-an','-c:v','libx264',str(original)],check=True,capture_output=True,timeout=30)
            else:
                with wave.open(str(original),'wb') as output:
                    output.setnchannels(1);output.setsampwidth(2);output.setframerate(16000);output.writeframes(bytes(40000))
            child=work/'source-child'
            child.write_text('#!'+os.sys.executable+'\nimport json,os,sys,shutil\nfrom pathlib import Path\n'+
                'command=json.load(sys.stdin)\n'+
                f'assert Path({str(marker)!r}).read_text()=="started"\n'+
                'assert "DATABASE_URL" not in os.environ\n'+
                f'shutil.copyfile({str(original)!r},command["outputPath"])\n'+
                'print(json.dumps({"byteLength":Path(command["outputPath"]).stat().st_size,"contentType":'+repr('video/mp4' if silent else 'audio/wav')+'}))\n')
            child.chmod(0o700);starts=[];trace=[];state={}
            def started(pid):os.kill(pid,0);starts.append(pid);marker.write_text('started')
            session=SimpleNamespace(fence={'reference':{'inputHash':'a'*64},'attemptToken':str(uuid4()),'owner':str(uuid4())},assert_live=lambda:None,
                on_process_start=started,cancel_event=Event(),remaining_seconds=120)
            command={'kind':'direct_source','audioPolicy':policy,'projectId':str(uuid4()),'sourceRevision':1,
                'mediaIdentity':{'provider':'rss','mediaId':'episode1'},'sourceAudioId':session.fence['attemptToken'],
                'toolchainFingerprint':'d'*64,'probeVersion':'normalized-probe-v1','existingSourceAudio':None,'languageProbe':None,
                'source':{'provider':'rss','url':'https://source.example/frozen.wav','authorization':None}}
            outputs=[{'artifactId':str(uuid4()),'role':role,'contentType':mime,'contentTypes':[mime],'maxBytes':2*1024**3,'bindingHash':'b'*64}
                for role,mime in ([('source_audio','audio/mp4')] if policy!='none' else [])+[('source_video','video/mp4' if silent else 'audio/wav')]]
            def package(refreshed=False):
                value={**command,'existingSourceAudio':state['audio']} if refreshed else command
                return WorkPackage('fetch_source','a'*64,_wire(value),_wire([]),_wire([value for value in outputs if value['role']!='source_audio'] if refreshed else outputs),_wire(session.fence))
            class Artifacts:
                def __init__(self,session,package):self.roles={value['artifactId']:value['role'] for value in package.outputs}
                async def upload(self,artifact_id,path,**options):
                    role=self.roles[artifact_id];trace.append(role)
                    actual=path.read_bytes();assert hashlib.sha256(actual).hexdigest()==options['sha256'] and len(actual)==options['byte_length']
                    facts=options['facts_builder'](CompletedObject('execution/'+role,'"sealed"',len(actual),options['sha256']))
                    if role=='source_audio':state['audio']=facts['sourceAudio']
                    else:state['video']=facts['sourceVideo']
            async def load(_):trace.append('refresh');return package(True)
            class Sink(ScopedSourceSink):
                async def audio_ready(self,artifact):
                    state['encodedCodec']=artifact.probe['facts']['audios'][0]['codec'];await super().audio_ready(artifact)
            def sink_factory(session,package,work,**options):return Sink(session,package,work,artifacts_factory=Artifacts,package_loader=load,**options)
            runtime=NativeFileRuntime(session,download_executable=[str(child)])
            previous=os.environ.get('DATABASE_URL');os.environ['DATABASE_URL']='private-poison'
            try:await run_direct_source(session,package(),work,runtime=runtime,sink_class=sink_factory)
            finally:
                if previous is None:os.environ.pop('DATABASE_URL',None)
                else:os.environ['DATABASE_URL']=previous
            if policy=='none' or silent:
                self.assertEqual(trace,['source_video']);self.assertEqual(len(starts),2);self.assertNotIn('audio',state)
                if silent:self.assertIsNone(state['video']['audioTrack']);self.assertIsNone(state['video']['probe']['audio'])
                script=f'import {{sourceVideoBindingSchema}} from "{root}/packages/validators/src/execution.ts";import {{readFileSync}} from "node:fs";sourceVideoBindingSchema.parse(JSON.parse(readFileSync(0,"utf8")));console.log("valid");'
                result=subprocess.run(['bun','-e',script],input=json.dumps(state['video']).encode(),capture_output=True,timeout=20)
                self.assertEqual(result.returncode,0,result.stderr.decode());return
            self.assertEqual(trace,['source_audio','refresh','source_video']);self.assertGreaterEqual(len(starts),4)
            self.assertEqual(state['audio']['audioTrack']['codec'],'pcm_s16le');self.assertEqual(state['encodedCodec'],'aac')
            self.assertIsNone(state['video']['probe']['video']);self.assertEqual(state['audio']['durationSeconds'],1.25)
            script=f'import {{sourceAudioBindingSchema,sourceVideoBindingSchema}} from "{root}/packages/validators/src/execution.ts";import {{sourceAudioMatchesVideo}} from "{root}/packages/services/src/source-readiness.ts";import {{readFileSync}} from "node:fs";const input=JSON.parse(readFileSync(0,"utf8")),audio=sourceAudioBindingSchema.parse(input.audio),video=sourceVideoBindingSchema.parse(input.video);if(!sourceAudioMatchesVideo(audio,video,14400))throw new Error("source_mismatch");console.log("valid");'
            result=subprocess.run(['bun','-e',script],input=json.dumps({'audio':state['audio'],'video':state['video']}).encode(),capture_output=True,timeout=20)
            self.assertEqual(result.returncode,0,result.stderr.decode());self.assertEqual(result.stdout.strip(),b'valid')

    async def test_actual_audio_only_probe_and_extraction_produce_api_valid_whole_source_bindings(self):
        await self.actual_file_operation()

    async def test_a_known_no_speech_plan_keeps_only_the_original_without_running_extraction(self):
        await self.actual_file_operation(policy='none')

    async def test_an_actual_silent_video_commits_its_original_without_fabricating_audio(self):
        await self.actual_file_operation(silent=True)


if __name__=='__main__':unittest.main()
