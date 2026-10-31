"""Small live provider proof for an extra Range on a frozen signed source read."""
from __future__ import annotations
import asyncio,hashlib,http.client,json,os,sys,tempfile,time
from pathlib import Path
from threading import Event
from types import SimpleNamespace
from urllib.parse import urlsplit
from uuid import uuid4
from narriflow_media.native_runtime import download_assigned_source
from narriflow_media.transfer import WorkPackage,_wire

async def main():
    assert not any(os.environ.get(name) for name in ['R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','DATABASE_URL','DIRECT_URL'])
    directory=Path(os.environ['R2_PREFIX_GATE_DIR']);ready=json.loads((directory/'ready.json').read_text())
    state={'date':'2026-10-31','scope':'real R2 signed If-Match source grant with an added bounded Range; controlled process-start acknowledgement, no live domain fence','runtime':'CPython '+sys.version.split()[0],'status':'running'}
    source=ready['source'];began=time.monotonic();starts=[]
    def on_start(pid):os.kill(pid,0);starts.append(pid)
    session=SimpleNamespace(fence={'reference':{'inputHash':'a'*64},'attemptToken':str(uuid4()),'owner':str(uuid4())},assert_live=lambda:None,on_process_start=on_start,cancel_event=Event(),remaining_seconds=60)
    package=WorkPackage('pin_source','a'*64,_wire({}),_wire([source]),_wire([]),_wire(session.fence))
    try:
        with tempfile.TemporaryDirectory(prefix='r2-prefix-read-') as scratch:
            path=await download_assigned_source(session,package,Path(scratch),source_name='upload_source',maximum_bytes=16*1024*1024,range_end=16)
            expected=b'narriflow-owned-'
            assert len(expected)==16
            if path.read_bytes()!=expected or len(starts)!=1:raise RuntimeError('gate_prefix_invalid')
            state.update(status='passed',frozenObjectBytes=source['byteLength'],rangeBytes=16,rangeSha256=hashlib.sha256(expected).hexdigest(),ownedProcessStarts=1,elapsedSeconds=round(time.monotonic()-began,3),providerCredentialsInPython=False)
    except BaseException:
        state['status']='failed'
        raise
    finally:
        endpoint=urlsplit(ready['cleanupUrl']);connection=http.client.HTTPConnection(endpoint.hostname,endpoint.port,timeout=20)
        try:
            connection.request('POST',endpoint.path,body=b'{}',headers={'authorization':'Bearer '+ready['token'],'content-type':'application/json'})
            response=connection.getresponse();data=response.read(4097);cleanup=json.loads(data)
            if response.status!=200 or cleanup!={'deleted':1,'verifiedMissing':True}:raise RuntimeError('gate_cleanup_unconfirmed')
            state['cleanup']=cleanup
        except BaseException:
            state['status']='cleanup_unconfirmed';state['cleanup']={'uncertain':True}
            raise
        finally:
            connection.close();(directory/'report.json').write_text(json.dumps(state,indent=2)+'\n')
    print(json.dumps(state))

if __name__=='__main__':asyncio.run(main())
