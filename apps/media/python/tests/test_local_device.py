import json
import unittest
from datetime import datetime, timezone
from uuid import uuid4
from narriflow_media.control import ControlResponse,ExecutionControlClient,ExecutionControlError
from narriflow_media.entrypoint import invocation_reference
from narriflow_media.signing import verify_execution_request

class LocalDeviceTests(unittest.TestCase):
 def test_local_reference_has_the_same_strict_fence_without_becoming_a_modal_reference(self):
  value={'reference':{'dispatchId':str(uuid4()),'deploymentEpoch':1,'kind':'local_fetch','subject':{'kind':'ingest_job','id':str(uuid4())},'generation':1,'inputHash':'a'*64},'attemptToken':str(uuid4())}
  self.assertEqual(invocation_reference(value,'fetch_source','local_fetch'),value)
  with self.assertRaises(ExecutionControlError):invocation_reference(value,'fetch_source')
  with self.assertRaises(ExecutionControlError):invocation_reference(value,'asset_validation','local_fetch')
  with self.assertRaises(ExecutionControlError):invocation_reference({**value,'reference':{**value['reference'],'subject':[]}},'fetch_source','local_fetch')
 def test_device_audience_and_header_never_use_modal_control_routes(self):
  key=b'x'*32;now=1793406000;seen=[]
  def transport(origin,target,body,headers,timeout):
   self.assertEqual(target,'/api/dev-device/execution/command');self.assertEqual(headers['X-Local-Fetch-Session'],'payload.signature')
   verify_execution_request(signature=json.loads(headers['X-Execution-Signature']),key_ring={'device':key},audience='dev-device',method='POST',target=target,body=body,now_seconds=now)
   seen.append(target)
   return ControlResponse(200,{'X-Execution-Server-Time':datetime.fromtimestamp(now,timezone.utc).isoformat().replace('+00:00','Z')},b'{"disposition":"started"}')
  client=ExecutionControlClient(origin='https://api.narriflow.test',key_id='device',key=key,clock=lambda:now,transport=transport,device_session_token='payload.signature')
  self.assertEqual(client.command({'action':'process-start'}).disposition['disposition'],'started');self.assertEqual(len(seen),1)
