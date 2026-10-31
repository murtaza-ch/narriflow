from __future__ import annotations
import argparse, asyncio, base64, http.client, json, os, resource, sys, tempfile, threading, time, tracemalloc
from pathlib import Path
from urllib.parse import urlsplit
from narriflow_media.multipart import CompletedObject, MultipartDestination, MultipartTransferError, SignedGrant, SignedHttpTransport, pin_source, upload_file

gate_directory=Path(os.environ['R2_NATIVE_GATE_DIR'])
ready=json.loads((gate_directory/'ready.json').read_text())
assert not any(os.environ.get(name) for name in ['R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','DATABASE_URL','DIRECT_URL'])
endpoint=urlsplit(ready['url'])
report={'runtime':'CPython '+sys.version.split()[0], 'scope':'native multipart plus local injected TS grant service, real R2; no live domain fence claim','checks':[],'phases':[],'status':'running','gateDeadlineSeconds':14400}
report_path=gate_directory/'report.json'
def save():
    report_path.write_text(json.dumps(report,indent=2))
def call(path, payload):
    connection=http.client.HTTPConnection(endpoint.hostname,endpoint.port,timeout=60)
    try:
        body=json.dumps(payload,separators=(',',':')).encode()
        if len(body)>65536: raise RuntimeError('gate_control_body_exceeded')
        connection.request('POST',path,body=body,headers={'Content-Type':'application/json','Authorization':'Bearer '+ready['token']})
        response=connection.getresponse();data=response.read(65537)
        if len(data)>65536:raise RuntimeError('gate_control_response_exceeded')
        value=json.loads(data)
        if response.status!=200:raise RuntimeError(value.get('code','gate_control_refused'))
        return value
    finally:connection.close()
def destination(value):return MultipartDestination(value['artifactId'],value['uploadId'],value['byteLength'],value['partSizeBytes'])
def rss_mib():return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/(1024*1024 if sys.platform=='darwin' else 1024)
class Control:
    def __init__(self, assigned):self.assigned=assigned;self.last_grant=None
    async def authorize_part(self, number, byte_length, sha256, md5):
        value=await asyncio.to_thread(call,'/part',{'artifactId':self.assigned.artifact_id,'partNumber':number,'byteLength':byte_length,'checksumSha256':sha256,'checksumMd5':md5})
        grant=SignedGrant(value['url'],value['headers']);self.last_grant=(number,grant,md5);return grant
    async def authorize_source_range(self,start,end,source_etag):
        value=await asyncio.to_thread(call,'/range',{'artifactId':self.assigned.artifact_id,'start':start,'end':end,'sourceEtag':source_etag})
        return SignedGrant(value['url'],value['headers'])
    async def complete(self,parts,sha256):
        value=await asyncio.to_thread(call,'/complete',{'artifactId':self.assigned.artifact_id,'byteLength':self.assigned.byte_length,'sha256':sha256})
        return CompletedObject(value['key'],value['etag'],value['byteLength'],value['sha256'])
    async def abort(self,reason):return await asyncio.to_thread(call,'/abort',{'artifactId':self.assigned.artifact_id,'reason':reason})
class Transport:
    def __init__(self,name):self.native=SignedHttpTransport(timeout_seconds=60);self.state={'name':name,'uploadedBytes':0,'downloadedBytes':0,'startedAt':time.time()};self.last_progress=0;self.max_rss=rss_mib()
    async def request(self,grant,method,body,headers,max_response_bytes,cancelled):
        response=await self.native.request(grant,method,body,headers,max_response_bytes,cancelled)
        if method=='PUT' and response.status==200:self.state['uploadedBytes']+=len(body)
        if method=='GET' and response.status==206:self.state['downloadedBytes']+=len(response.body)
        self.max_rss=max(self.max_rss,rss_mib())
        if time.time()-self.last_progress>15:
            self.last_progress=time.time();self.state['elapsedSeconds']=round(time.time()-self.state['startedAt'],2);self.state['peakRssMiB']=round(self.max_rss,2);report['progress']=self.state;save();print(json.dumps(self.state),flush=True)
        return response
    def finish(self):self.state['elapsedSeconds']=round(time.time()-self.state['startedAt'],2);self.state['peakRssMiB']=round(max(self.max_rss,rss_mib()),2);report['phases'].append(self.state.copy())
async def main(size):
    if not 16*1024*1024<size<=10*1024**3:raise RuntimeError('gate_size_invalid')
    tracemalloc.start();save()
    cancelled=threading.Event();deadline=time.monotonic()+14400
    def owned():
        if cancelled.is_set() or time.monotonic()>=deadline:raise MultipartTransferError('gate_owner_cancelled')
    try:
        with tempfile.TemporaryDirectory(prefix='narriflow-native-r2-') as directory:
            path=Path(directory)/'source.bin'
            descriptor=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
            try:
                os.ftruncate(descriptor,size)
                os.pwrite(descriptor,b'narriflow-native-r2-start',0)
                marker=b'narriflow-native-r2-end';os.pwrite(descriptor,marker,size-len(marker))
            finally:os.close(descriptor)
            report['logicalSourceBytes']=size;report['allocatedSourceBytes']=path.stat().st_blocks*512;save()
            assigned=destination(await asyncio.to_thread(call,'/create',{'byteLength':size}))
            control,transport=Control(assigned),Transport('file_upload')
            source=await upload_file(path,assigned,control=control,transport=transport,assert_owned=owned,cancel_event=cancelled)
            transport.finish();report['checks'].append('native file uploaded with measured SHA256 and provider MD5 verification');save()
            # The grant remains within TTL, but its MPU no longer exists.
            number,grant,md5=control.last_grant
            with path.open('rb') as stream:stream.seek((number-1)*assigned.part_size_bytes);body=stream.read(assigned.part_size_bytes)
            stale=await transport.native.request(grant,'PUT',body,{'Content-Length':str(len(body)),'Content-MD5':md5},65536,lambda:False)
            del body
            if stale.status!=404:raise RuntimeError('stale_part_grant_did_not_expire_at_completion')
            head=await asyncio.to_thread(call,'/head',{'artifactId':assigned.artifact_id})
            if head['etag']!=source.etag:raise RuntimeError('stale_part_grant_changed_object')
            report['checks'].append('still-live UploadPart grant returns404 after completion and cannot overwrite');save()
            pin_assigned=destination(await asyncio.to_thread(call,'/create',{'byteLength':size,'sourceArtifactId':assigned.artifact_id}))
            pin_control,pin_transport=Control(pin_assigned),Transport('conditional_pin')
            pinned=await pin_source(pin_assigned,source_etag=source.etag,control=pin_control,transport=pin_transport,assert_owned=owned,cancel_event=cancelled,expected_sha256=source.sha256)
            pin_transport.finish()
            if pinned.sha256!=source.sha256:raise RuntimeError('pin_full_sha256_changed')
            report['checks'].append('conditional pin preserved independently reread whole-object SHA256');save()
            fault_assigned=destination(await asyncio.to_thread(call,'/create',{'byteLength':size,'sourceArtifactId':assigned.artifact_id,'mutateOnPart':True}))
            fault_control,fault_transport=Control(fault_assigned),Transport('source_mutation_fault')
            try:
                await pin_source(fault_assigned,source_etag=source.etag,control=fault_control,transport=fault_transport,assert_owned=owned,cancel_event=cancelled,concurrency=1)
                raise RuntimeError('source_mutation_did_not_fail')
            except MultipartTransferError as error:
                if error.code!='multipart_source_changed':raise
                report['checks'].append('actual source overwrite during pin caused failed condition and aborted unpublished MPU')
            fault_transport.finish()
            report['status']='passed'
    except BaseException as error:
        report['status']='failed';message=str(error);report['failure']=message if message.replace('_','').isalnum() and len(message)<100 else type(error).__name__;raise
    finally:
        cancelled.set();_current,peak=tracemalloc.get_traced_memory();tracemalloc.stop();report['tracedPeakBytes']=peak;report['peakRssMiB']=round(rss_mib(),2)
        try:report['cleanup']=await asyncio.to_thread(call,'/cleanup',{})
        except Exception:report['cleanup']={'uncertain':True}
        report.pop('progress',None);save();print(json.dumps(report),flush=True)
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--bytes',type=int,default=17*1024*1024)
    asyncio.run(main(parser.parse_args().bytes))
