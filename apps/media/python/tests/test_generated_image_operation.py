from __future__ import annotations
import base64
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
from threading import Event
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from narriflow_media.generated_image_runtime import GeneratedImageFiles
from narriflow_media.native_runtime import run_generated_image, NativeOperationFailure

PNG=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWNgYPj/HxWTLAAAHGAf4ah9/4IAAAAASUVORK5CYII=')

class GeneratedImageOperationTests(unittest.IsolatedAsyncioTestCase):
    def fixture(self, mode='recover'):
        starts=[]
        session=SimpleNamespace(assert_live=lambda:None,on_process_start=starts.append,cancel_event=Event())
        command={'kind':'generated_image','mode':mode,'jobId':str(uuid4()),'requestId':str(uuid4()),'inputHash':'a'*64,'maxOutputBytes':100000000}
        if mode=='recover':command.update(providerRef='accepted-provider',expected={'sha256':hashlib.sha256(PNG).hexdigest(),'byteLength':len(PNG),'contentType':'image/png'})
        else:command.update(prompt='A native frame',aspectRatio='9:16',style='editorial',model='fixture',quality='medium')
        outputs=[{'artifactId':str(uuid4()),'role':role,'contentType':mime,'contentTypes':[mime],'maxBytes':limit,'bindingHash':'a'*64} for role,mime,limit in [('validated_asset','image/png',100000000),('probe','application/json',65536)]]
        package=SimpleNamespace(input_hash='a'*64,function_name='generated_image',command=command,sources=[{'name':'generated_result','sha256':hashlib.sha256(PNG).hexdigest(),'byteLength':len(PNG)}] if mode=='recover' else [],outputs=outputs,assert_session=lambda _:None)
        return session,package,starts

    @unittest.skipUnless(shutil.which('bun'),'real Bun is required')
    async def test_real_recovery_uploads_probe_before_binary_and_never_passes_a_provider_key(self):
        session,package,starts=self.fixture();uploads=[]
        with tempfile.TemporaryDirectory() as value:
            work=Path(value);source=work/'verified.png';source.write_bytes(PNG);source.chmod(0o400)
            async def upload(artifact,path,**facts):
                uploads.append((artifact,path.read_bytes(),facts))
            with patch('narriflow_media.native_runtime.download_assigned_source',new=AsyncMock(return_value=source)) as download, patch('narriflow_media.native_runtime.AssignedArtifacts') as artifacts:
                artifacts.return_value.upload=upload
                await run_generated_image(session,package,work,api_key='must-not-reach-recovery')
            self.assertEqual(len(starts),1)
            self.assertEqual([item[0] for item in uploads],[package.outputs[1]['artifactId'],package.outputs[0]['artifactId']])
            self.assertEqual(json.loads(uploads[0][1])['image']['sha256'],hashlib.sha256(PNG).hexdigest())
            self.assertEqual(uploads[1][1],PNG)
            self.assertEqual(download.call_args.kwargs['source_name'],'generated_result')

    async def test_ambiguous_provider_result_only_commits_its_bounded_probe(self):
        session,package,_=self.fixture('generate');uploads=[]
        with tempfile.TemporaryDirectory() as value:
            work=Path(value);proof=work/'proof.json'
            evidence={k:package.command[k] for k in ('kind','jobId','requestId','inputHash')}
            evidence.update(version=1,outcome='unknown',code='generated_media_provider_outcome_unknown',providerRef=None,retryable=False,retryAfterMs=None)
            proof.write_text(json.dumps(evidence))
            async def upload(artifact,path,**_):uploads.append(artifact)
            with patch('narriflow_media.native_runtime.execute_generated_image',new=AsyncMock(return_value=GeneratedImageFiles(None,proof,evidence))) as execute,patch('narriflow_media.native_runtime.AssignedArtifacts') as artifacts:
                artifacts.return_value.upload=upload
                await run_generated_image(session,package,work,api_key='dedicated-key')
            self.assertEqual(uploads,[package.outputs[1]['artifactId']])
            self.assertEqual(execute.call_args.kwargs['api_key'],'dedicated-key')

    async def test_mismatched_recovery_source_starts_no_process_and_uploads_nothing(self):
        session,package,starts=self.fixture();package.sources[0]['sha256']='f'*64
        with tempfile.TemporaryDirectory() as value,patch('narriflow_media.native_runtime.execute_generated_image',new=AsyncMock()) as execute:
            with self.assertRaises(NativeOperationFailure):await run_generated_image(session,package,Path(value))
            execute.assert_not_called();self.assertEqual(starts,[])
