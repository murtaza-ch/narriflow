import unittest
from uuid import uuid4
from narriflow_media.control import _disposition, ExecutionControlError
class PublicationControlReplyTests(unittest.TestCase):
    def test_checkpoint_ack_and_settlement_reply_are_metadata_only(self):
        self.assertEqual(_disposition({'disposition':'publication_recorded','result':{'kind':'recorded'}})['result'],{'kind':'recorded'})
        reply={'disposition':'publication_recorded','result':{'kind':'settled','outcome':'processing','attemptId':str(uuid4()),'socialPostId':str(uuid4()),'nextActionAt':'2026-10-31T01:00:00.000Z'}}
        self.assertEqual(_disposition(reply),reply)
    def test_credential_or_signed_url_cannot_appear_in_a_durable_reply(self):
        for field in ('accessToken','url','signedUrl','media','checkpoint'):
            with self.assertRaises(ExecutionControlError):_disposition({'disposition':'publication_recorded','result':{'kind':'recorded',field:'private'}})
        with self.assertRaises(ExecutionControlError):_disposition({'disposition':'publication_recorded','result':{'kind':'settled','outcome':'processing','attemptId':'bad','socialPostId':str(uuid4())}})

class PublicationWorkPackageTests(unittest.TestCase):
    def value(self):
        from base64 import urlsafe_b64encode
        scope={'deploymentEpoch':1,'socialPostId':str(uuid4()),'attemptId':str(uuid4()),'claimId':str(uuid4()),'bindingHash':'a'*64}
        key={'key':urlsafe_b64encode(b'k'*32).decode().rstrip('='),'scope':scope}
        return {'disposition':'work_package','functionName':'publication','inputHash':'a'*64,'input':{'kind':'inline','command':{'kind':'publication'}},'sources':[],'outputs':[],
            'publication':{'version':1,'inputKey':key,'checkpointKey':key,'account':None}}
    def test_publication_ephemeral_context_is_function_bound_and_strict(self):
        from narriflow_media.transfer import parse_transfer_disposition
        value=self.value();self.assertEqual(parse_transfer_disposition(value),value)
        value['functionName']='fetch_source'
        with self.assertRaises(ExecutionControlError):parse_transfer_disposition(value)
        value=self.value();value['publication']['masterKey']='never-present'
        with self.assertRaises(ExecutionControlError):parse_transfer_disposition(value)
    def test_purpose_context_is_not_exposed_by_work_package_repr_or_mutable_shared_reads(self):
        from narriflow_media.transfer import WorkPackage,_wire
        value=self.value();package=WorkPackage('publication','a'*64,_wire({}),_wire([]),_wire([]),_wire({}),_wire(value['publication']))
        key=package.publication['inputKey']['key']
        self.assertNotIn(key,repr(package));copy=package.publication;copy['inputKey']['key']='changed'
        self.assertEqual(package.publication['inputKey']['key'],key)
