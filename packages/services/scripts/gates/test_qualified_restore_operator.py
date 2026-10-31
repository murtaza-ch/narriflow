import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import hashlib
from uuid import uuid4
import time
from qualified_restore_operator import validate_request, REMOTE, APP, HOST, DATABASE, IMAGE
import qualified_restore_operator as operator

class QualifiedOperatorGuards(unittest.TestCase):
    def fixture(self):
        now=1793550000000
        from datetime import datetime,timezone
        instant=lambda n:datetime.fromtimestamp(n/1000,timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
        run=str(uuid4());sandbox='sb-01M69XYH8X4D1RJR2RZAA42M8N'
        journal={'version':1,'runId':run,'sandboxId':sandbox,'appName':APP,'appId':'ap-12345678901234567890','imageId':IMAGE,'expectedHost':HOST,'expectedDatabase':DATABASE,'caBundleSha256':'a'*64,'createdAt':instant(now-1000),'expiresAt':instant(now+899000)}
        request={'version':1,'tool':'pg_dump','sandboxId':sandbox,'journalPath':'/private/journal.json','runId':run,'localPath':'/private/snapshot.dump','deadlineUnixMs':now+600000,'timeoutMs':180000,'expectedSha256':None}
        return request,journal,now

    def test_exact_precreated_operator_is_selected_without_any_sdk_or_database_call(self):
        request,journal,now=self.fixture()
        self.assertEqual(validate_request(request,journal,now),{'purpose':'qualified-restore','runId':request['runId'],'imageId':IMAGE,'caBundleSha256':'a'*64})
        compile(REMOTE,'trusted_operator_remote','exec')

    def test_wrong_app_image_run_host_database_or_sandbox_is_refused(self):
        request,journal,now=self.fixture()
        for key,value in [('appName','narriflow-media'),('imageId','im-12345678901234567890'),('expectedHost','shared.neon.tech'),('expectedDatabase','neondb'),('runId',str(uuid4())),('sandboxId','sb-99999999999999999999999999')]:
            with self.subTest(key=key),self.assertRaises(ValueError):validate_request(request,{**journal,key:value},now)

    def test_other_commands_expired_lifetimes_and_arbitrary_timeouts_are_refused(self):
        request,journal,now=self.fixture()
        for changes in [{'tool':'psql'},{'timeoutMs':180001},{'deadlineUnixMs':now+30000},{'localPath':'relative.dump'},{'tool':'pg_restore','expectedSha256':None}]:
            with self.subTest(changes=changes),self.assertRaises(ValueError):validate_request({**request,**changes},journal,now)
        with self.assertRaises(ValueError):validate_request(request,{**journal,'expiresAt':journal['createdAt']},now)

    def test_restore_requires_an_exact_byte_hash_and_allows_elapsed_sdk_setup_within_original_deadline(self):
        request,journal,now=self.fixture()
        request.update(tool='pg_restore',expectedSha256='b'*64,deadlineUnixMs=now+150000,timeoutMs=120000)
        self.assertEqual(validate_request(request,journal,now+500)['purpose'],'qualified-restore')
        with self.assertRaises(ValueError):validate_request({**request,'expectedSha256':'not-a-hash'},journal,now)

    def test_fixed_sdk_attachment_downloads_measured_archive_into_the_private_reserved_file(self):
        request,journal,now=self.fixture();archive=b'PGDMP-controlled-private-snapshot';ca=b'controlled-public-CA'
        journal['caBundleSha256']=hashlib.sha256(ca).hexdigest()
        tags={'purpose':'qualified-restore','runId':request['runId'],'imageId':IMAGE,'caBundleSha256':journal['caBundleSha256']}
        writes={};calls=[]
        report={'tool':'pg_dump','utilityVersion':'18.6','utilityBuild':'pg_dump (PostgreSQL) 18.6 (Debian 18.6-1.pgdg12+2)','serverMajor':18,'serverVersion':'18.6','serverVersionNumber':180006,'timeoutMs':180000,'elapsedMs':500,'caBundleSha256':journal['caBundleSha256'],'byteLength':len(archive),'sha256':hashlib.sha256(archive).hexdigest()}
        class Stdin:
            def write(self,wire):calls.append(json.loads(wire))
            def write_eof(self):pass
            def drain(self):pass
        process=SimpleNamespace(stdin=Stdin(),stdout=SimpleNamespace(read=lambda:json.dumps(report)),stderr=SimpleNamespace(read=lambda:''),wait=lambda:0)
        def execute(*args,**kwargs):
            self.assertEqual(args,('python','-c',REMOTE));self.assertEqual(kwargs['env'],{'PGSSLROOTCERT':'system','SSL_CERT_FILE':'/tmp/operator-system-ca.pem'});return process
        sandbox=SimpleNamespace(object_id=request['sandboxId'],get_tags=lambda:tags,exec=execute,filesystem=SimpleNamespace(write_bytes=lambda data,path:writes.update({path:data}),read_bytes=lambda path:archive))
        def lookup(name,**kwargs):
            self.assertEqual((name,kwargs),(APP,{'environment_name':'main','create_if_missing':False}));return SimpleNamespace(object_id=journal['appId'])
        def sandboxes(**kwargs):
            self.assertEqual(kwargs,{'app_id':journal['appId'],'tags':{'purpose':'qualified-restore','runId':request['runId']}});return iter([sandbox])
        modal=SimpleNamespace(__version__='1.6.3',App=SimpleNamespace(lookup=lookup),Sandbox=SimpleNamespace(list=sandboxes))
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);local=root/'snapshot';local.write_bytes(b'');local.chmod(0o600)
            cert=root/'ca.pem';cert.write_bytes(ca)
            path=root/'operator.json';path.write_text(json.dumps(journal));path.chmod(0o600)
            request.update(localPath=str(local),journalPath=str(path))
            with patch.object(operator,'CA_PATH',cert),patch.object(operator.time,'time',return_value=now/1000),patch.dict('sys.modules',{'modal':modal}):
                self.assertEqual(operator.execute(request),report)
            self.assertEqual(local.read_bytes(),archive);self.assertEqual(local.stat().st_mode&0o077,0)
        self.assertEqual(writes,{'/tmp/operator-system-ca.pem':ca})
        self.assertEqual(set(calls[0]),{'tool','runId','deadlineUnixMs','timeoutMs','expectedSha256','caBundleSha256'})

if __name__=='__main__':unittest.main()
