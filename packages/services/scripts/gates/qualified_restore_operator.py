"""Attach to one precreated privileged operator Sandbox. Never create one.

This is not a media executor, HTTP service, SQL tunnel or credential store.
Only fixed pg_dump/pg_restore commands against the private candidate are allowed.
"""
from __future__ import annotations
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
import time
from uuid import UUID

HOST = 'ep-wispy-field-b5wyn9o3.c-7.us-east-2.aws.neon.tech'
DATABASE = 'serverless_pipeline_gates'
APP = 'narriflow-restore-operator-gates'
IMAGE = 'im-eLOXuxnLewD81EngzOgXFy'
CA_PATH = Path('/opt/homebrew/etc/ca-certificates/cert.pem')
MAX_ARCHIVE = 64 * 1024 * 1024

def refused():
    raise ValueError('qualified_restore_operator_refused')

def validate_request(request, journal, now_ms):
    if (not isinstance(request, dict) or set(request) != {'version','tool','sandboxId','journalPath','runId','localPath','deadlineUnixMs','timeoutMs','expectedSha256'}
            or request['version'] != 1 or request['tool'] not in {'pg_dump','pg_restore'}
            or not isinstance(journal, dict) or set(journal) != {'version','runId','sandboxId','appName','appId','imageId','expectedHost','expectedDatabase','caBundleSha256','createdAt','expiresAt'}):
        refused()
    if (journal['version'] != 1 or journal['appName'] != APP or journal['expectedHost'] != HOST or journal['expectedDatabase'] != DATABASE
            or journal['sandboxId'] != request['sandboxId'] or journal['runId'] != request['runId']
            or not re.fullmatch(r'sb-[A-Za-z0-9]{20,40}',str(journal['sandboxId']))
            or not re.fullmatch(r'ap-[A-Za-z0-9]{10,40}',str(journal['appId']))
            or journal['imageId'] != IMAGE
            or not re.fullmatch(r'[a-f0-9]{64}',str(journal['caBundleSha256']))):
        refused()
    if str(UUID(request['runId'])) != request['runId']:
        refused()
    from datetime import datetime
    created = datetime.fromisoformat(journal['createdAt'].replace('Z','+00:00')).timestamp()*1000
    expires = datetime.fromisoformat(journal['expiresAt'].replace('Z','+00:00')).timestamp()*1000
    if (not all(type(request[name]) is int for name in ['deadlineUnixMs','timeoutMs'])
            or not 1000 <= request['timeoutMs'] <= 180000 or request['deadlineUnixMs']-now_ms-30000<1000
            or not created <= now_ms < expires or not 0 < expires-created <= 900000
            or expires < request['deadlineUnixMs'] or not Path(request['localPath']).is_absolute()):
        refused()
    digest=request['expectedSha256']
    if request['tool']=='pg_dump' and digest is not None or request['tool']=='pg_restore' and not re.fullmatch(r'[a-f0-9]{64}',str(digest)):
        refused()
    return {'purpose':'qualified-restore','runId':request['runId'],'imageId':journal['imageId'],'caBundleSha256':journal['caBundleSha256']}

REMOTE = r'''
import hashlib,json,math,os,re,subprocess,sys,time
from pathlib import Path
r=json.load(sys.stdin)
host='ep-wispy-field-b5wyn9o3.c-7.us-east-2.aws.neon.tech';database='serverless_pipeline_gates'
assert os.environ.get('PGHOST')==host and os.environ.get('PGDATABASE')==database
assert os.environ.get('PGSSLMODE')=='verify-full' and os.environ.get('PGSSLROOTCERT')=='system'
assert os.environ.get('SSL_CERT_FILE')=='/tmp/operator-system-ca.pem'
assert hashlib.sha256(Path('/tmp/operator-system-ca.pem').read_bytes()).hexdigest()==r['caBundleSha256']
env={name:os.environ[name] for name in ['PGUSER','PGPASSWORD','PGSSLMODE','PGSSLROOTCERT','SSL_CERT_FILE']}
env.update(PGHOST=host,PGDATABASE=database,PGPORT='5432',PGCONNECT_TIMEOUT='10',PGOPTIONS='-c statement_timeout=180000 -c lock_timeout=5000')
def run(argv,timeout):
 p=subprocess.run(argv,env=env,capture_output=True,text=True,timeout=timeout)
 if p.returncode:raise RuntimeError('operator_utility_failed')
 return p.stdout.strip()
base='/usr/lib/postgresql/18/bin/'
identity=run([base+'psql','-X','-A','-t','-v','ON_ERROR_STOP=1','-c',"SELECT current_database()||'|'||current_setting('server_version_num')||'|'||current_setting('server_version')"],10).split('|')
assert len(identity)==3 and identity[0]==database and int(identity[1])//10000==18
tool=r['tool'];assert tool in ['pg_dump','pg_restore']
version=run([base+tool,'--version'],5)
assert re.fullmatch(re.escape(tool)+r' \(PostgreSQL\) 18\.6(?: \(Debian [A-Za-z0-9.+~:-]+\))?',version)
directory=Path('/tmp/qualified-restore-'+r['runId']);directory.mkdir(mode=0o700,exist_ok=True);os.chmod(directory,0o700)
archive=directory/'snapshot.dump';os.umask(0o077)
if tool=='pg_dump':
 assert not archive.exists()
 args=['--format=custom','--compress=0','--no-owner','--no-privileges','--file='+str(archive)]
else:
 assert archive.is_file() and archive.stat().st_size<=67108864
 os.chmod(archive,0o600)
 assert hashlib.sha256(archive.read_bytes()).hexdigest()==r['expectedSha256']
 args=['--clean','--if-exists','--single-transaction','--exit-on-error','--no-owner','--no-privileges','--dbname='+database,str(archive)]
timeout=min(r['timeoutMs'],180000,r['deadlineUnixMs']-int(time.time()*1000)-30000);assert timeout>=1000
began=time.monotonic();run([base+tool,*args],timeout/1000)
os.chmod(archive,0o600);size=archive.stat().st_size;assert 0<size<=67108864
print(json.dumps({'tool':tool,'utilityVersion':'18.6','utilityBuild':version,'serverMajor':18,'serverVersion':identity[2],'serverVersionNumber':int(identity[1]),'timeoutMs':timeout,'elapsedMs':math.ceil((time.monotonic()-began)*1000),'caBundleSha256':r['caBundleSha256'],'byteLength':size,'sha256':hashlib.sha256(archive.read_bytes()).hexdigest()}))
'''

def private_json(path):
    info=path.stat()
    if path.is_symlink() or info.st_mode & 0o077 or info.st_size>131072:
        refused()
    return json.loads(path.read_bytes())

def execute(request):
    journal=private_json(Path(request['journalPath']))
    tags=validate_request(request,journal,int(time.time()*1000))
    ca=CA_PATH.read_bytes()
    if hashlib.sha256(ca).hexdigest()!=journal['caBundleSha256']:
        refused()
    import modal
    if modal.__version__!='1.6.3':
        refused()
    app=modal.App.lookup(APP,environment_name='main',create_if_missing=False)
    if app.app_id!=journal['appId']:
        refused()
    sandbox=None
    for count, candidate in enumerate(modal.Sandbox.list(app_id=app.app_id,tags={'purpose':'qualified-restore','runId':request['runId']})):
        if count>=32:
            refused()
        if candidate.object_id==request['sandboxId']:
            sandbox=candidate
            break
    if sandbox is None:
        refused()
    actual_tags=sandbox.get_tags()
    if any(actual_tags.get(k)!=v for k,v in tags.items()):
        refused()
    remote_path='/tmp/qualified-restore-'+request['runId']+'/snapshot.dump'
    local=Path(request['localPath'])
    if local.is_symlink() or local.stat().st_mode & 0o077:
        refused()
    if request['tool']=='pg_restore':
        if not 0<local.stat().st_size<=MAX_ARCHIVE:
            refused()
        archive=local.read_bytes()
        if hashlib.sha256(archive).hexdigest()!=request['expectedSha256']:
            refused()
        sandbox.filesystem.write_bytes(archive,remote_path)
    elif local.stat().st_size:
        refused()
    sandbox.filesystem.write_bytes(ca,'/tmp/operator-system-ca.pem')
    command={k:request[k] for k in ['tool','runId','deadlineUnixMs','timeoutMs','expectedSha256']}
    command['caBundleSha256']=journal['caBundleSha256']
    process=sandbox.exec('python','-c',REMOTE,timeout=math.ceil(request['timeoutMs']/1000),env={'PGSSLROOTCERT':'system','SSL_CERT_FILE':'/tmp/operator-system-ca.pem'})
    process.stdin.write(json.dumps(command).encode());process.stdin.write_eof();process.stdin.drain()
    output=process.stdout.read();process.stderr.read();status=process.wait()
    if status or len(output)>4096:
        refused()
    result=json.loads(output)
    if result['tool']!=request['tool'] or result['caBundleSha256']!=journal['caBundleSha256']:
        refused()
    if request['tool']=='pg_dump':
        archive=sandbox.filesystem.read_bytes(remote_path)
        if len(archive)!=result['byteLength'] or len(archive)>MAX_ARCHIVE or hashlib.sha256(archive).hexdigest()!=result['sha256']:
            refused()
        fd=os.open(local,os.O_WRONLY|os.O_NOFOLLOW)
        with os.fdopen(fd,'wb') as target:
            target.write(archive)
    elif result['sha256']!=request['expectedSha256']:
        refused()
    return result

if __name__=='__main__':
    try:
        wire=sys.stdin.buffer.read(16385)
        if len(wire)>16384:
            refused()
        print(json.dumps(execute(json.loads(wire))))
    except BaseException:
        print(json.dumps({'mode':'failed','code':'qualified_restore_operator_refused'}))
        sys.exit(1)
