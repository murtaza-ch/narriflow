from __future__ import annotations
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
from threading import Event
import unittest
from unittest.mock import patch
from uuid import uuid4

from narriflow_media.generated_image_runtime import run_generated_image
from narriflow_media.process import MediaProcessError

PNG=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWNgYPj/HxWTLAAAHGAf4ah9/4IAAAAASUVORK5CYII=')

@unittest.skipUnless(shutil.which('bun'),'real Bun is required')
class GeneratedImageRuntimeTests(unittest.IsolatedAsyncioTestCase):
    def command(self,mode='recover'):
        common={'kind':'generated_image','mode':mode,'jobId':str(uuid4()),'requestId':str(uuid4()),'inputHash':'a'*64,'maxOutputBytes':100000000}
        return {**common,'providerRef':'verified-provider','expected':{'sha256':hashlib.sha256(PNG).hexdigest(),'byteLength':len(PNG),'contentType':'image/png'}} if mode=='recover' else {**common,'prompt':'A native image','aspectRatio':'9:16','style':'editorial','model':'native-fixture','quality':'medium'}

    async def test_real_recovery_decodes_pixels_and_returns_readonly_files_without_inheriting_other_keys(self):
        with tempfile.TemporaryDirectory() as value:
            work=Path(value);source=work/'source.png';source.write_bytes(PNG);starts=[]
            shim=work/'bun-guard';bun=shutil.which('bun')
            shim.write_text('#!/usr/bin/env python3\nimport os,sys\nassert not any(k in os.environ for k in ["DATABASE_URL","DIRECT_URL","REDIS_URL","R2_SECRET_ACCESS_KEY","OPENAI_API_KEY","EXECUTOR_CONTROL_KEYS_JSON"])\nos.execv('+repr(bun)+',['+repr(bun)+']+sys.argv[1:])\n');shim.chmod(0o700)
            with patch.dict(os.environ,{'DATABASE_URL':'poison','REDIS_URL':'poison','R2_SECRET_ACCESS_KEY':'poison','OPENAI_API_KEY':'poison','EXECUTOR_CONTROL_KEYS_JSON':'poison'}):
                result=await run_generated_image(self.command(),work,binary_artifact_id=str(uuid4()),source_path=source,on_process_start=starts.append,cancel_event=Event(),bun_executable=str(shim))
            self.assertEqual(len(starts),1);self.assertEqual(result.image_path.read_bytes(),PNG)
            self.assertEqual(result.evidence['outcome'],'completed');self.assertEqual(result.evidence['image']['width'],4)
            self.assertEqual(result.evidence['image']['sha256'],hashlib.sha256(PNG).hexdigest())
            self.assertEqual(result.evidence_path.stat().st_mode&0o777,0o400)

    async def test_largest_unicode_command_uses_local_file_not_oversized_control_stdin(self):
        with tempfile.TemporaryDirectory() as value:
            work=Path(value);command=self.command('generate');command['prompt']='🙂'*10000;starts=[]
            result=await run_generated_image(command,work,binary_artifact_id=str(uuid4()),on_process_start=starts.append,cancel_event=Event())
            self.assertEqual(len(starts),1);self.assertGreater((work/'generated-command.json').stat().st_size,65536)
            self.assertEqual(result.evidence['code'],'generated_media_provider_not_configured');self.assertEqual(result.evidence['outcome'],'failed');self.assertIsNone(result.image_path)

    async def test_unconfirmed_process_start_never_releases_provider_stdin(self):
        with tempfile.TemporaryDirectory() as value:
            work=Path(value)
            def rejected(_): raise TimeoutError('private start ACK')
            with self.assertRaises(MediaProcessError) as raised:
                await run_generated_image(self.command('generate'),work,binary_artifact_id=str(uuid4()),on_process_start=rejected,cancel_event=Event())
            self.assertEqual(raised.exception.code,'media_process_start_unconfirmed')
            self.assertFalse((work/'generated-evidence.json').exists())
