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
