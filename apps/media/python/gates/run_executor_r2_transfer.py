"""Operator-side caller. Only bounded invocation metadata reaches Modal."""
from __future__ import annotations

import argparse
from importlib.metadata import version
import json
import os
from pathlib import Path
import tempfile


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--app',required=True)
    parser.add_argument('--function',default='verify_executor_r2_transfer')
    parser.add_argument('--phase',choices=['upload','pin'],required=True)
    parser.add_argument('--arguments',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--expected-function-id')
    args=parser.parse_args()
    if os.environ.get('MODAL_PROFILE','murtazach275')!='murtazach275':
        raise RuntimeError('gate_modal_profile_mismatch')
    os.environ['MODAL_PROFILE']='murtazach275'
    if version('modal')!='1.6.3':
        raise RuntimeError('gate_modal_sdk_version_mismatch')
    info=args.arguments.stat()
    if info.st_mode&0o077 or info.st_size>65536:
        raise RuntimeError('gate_private_arguments_required')
    value=json.loads(args.arguments.read_text())
    if args.phase=='upload':
        if set(value)!={'reference','attemptToken'}:raise RuntimeError('gate_arguments_invalid')
        invocation,source=value,None
    else:
        if set(value)!={'invocation','source'}:raise RuntimeError('gate_arguments_invalid')
        invocation,source=value['invocation'],value['source']
    import modal
    function=modal.Function.from_name(args.app,args.function,environment_name='main')
    if args.expected_function_id is not None:
        import re
        if not re.fullmatch(r'fu-[A-Za-z0-9]{10,40}',args.expected_function_id):
            raise RuntimeError('gate_function_id_invalid')
        function.hydrate()
        if function.object_id!=args.expected_function_id:
            raise RuntimeError('gate_function_id_changed')
    result=function.remote(invocation,phase=args.phase,source=source)
    if type(result) is not dict or result.get('version')!=1 or result.get('phase')!=args.phase:
        raise RuntimeError('gate_report_invalid')
    # Preserve a failed or uncertain report too. Never automatically resubmit
    # an accepted logical invocation after the first result is lost.
    descriptor,temporary=tempfile.mkstemp(prefix=args.output.name+'.',dir=args.output.parent)
    try:
        with os.fdopen(descriptor,'w') as target:json.dump(result,target,indent=2);target.write('\n')
        os.replace(temporary,args.output)
    finally:
        Path(temporary).unlink(missing_ok=True)
    print(json.dumps({name:result.get(name) for name in ('status','phase','artifactId','requestedBytes',
        'qualifies10GiBUpload','qualifiesGreaterThan5GiBPin','elapsedSeconds','combinedElapsedSeconds',
        'peakRssBytes','containerLifetimePeakBytes','containerMemoryLimitBytes','failureCode')}))
    if result.get('status')!='passed':raise SystemExit(1)


if __name__=='__main__':main()
