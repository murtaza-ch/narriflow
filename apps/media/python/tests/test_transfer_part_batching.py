from __future__ import annotations

import asyncio
from types import SimpleNamespace
from threading import Event
import time
import unittest

from narriflow_media.control import ExecutionControlError
from narriflow_media.multipart import MultipartDestination, MultipartTransferError
from narriflow_media.transfer import ScopedMultipartControl


class Session:
    def __init__(self):
        self.calls = []
        self.entered, self.release = Event(), Event()
        self.release.set()
        self.failure = None
        self.revoked = False
        self.missing_grant = False

    def transfer(self, action, **fields):
        self.calls.append((action, fields))
        if action != 'upload-parts':
            return SimpleNamespace(disposition={})
        self.entered.set()
        if not self.release.wait(1):
            raise AssertionError('control caller remained hung')
        if self.revoked:
            raise ExecutionControlError('execution_authority_lost')
        if self.failure:
            raise self.failure
        grants = [{'partNumber':part['partNumber'], 'url':f"https://r2.fixture.invalid/part-{part['partNumber']}",
                   'headers':{'Content-MD5':part['checksumMd5']}} for part in reversed(fields['parts'])]
        if self.missing_grant:
            grants.pop()
        return SimpleNamespace(disposition={'grants':grants})


def control(session):
    return ScopedMultipartControl(session, MultipartDestination('assigned-artifact', 'private-upload', 16*1024**2*9),
                                  content_type='application/octet-stream')


def part(adapter, number):
    # Metadata only. Production's four existing native buffers remain unchanged.
    return adapter.authorize_part(number, 16*1024**2, f'sha-{number}', f'md5-{number}')


class PartAuthorizationBatchTests(unittest.IsolatedAsyncioTestCase):
    async def test_four_ready_parts_share_one_command_and_grants_match_each_number(self):
        session = Session()
        adapter = control(session)
        grants = await asyncio.wait_for(asyncio.gather(*(part(adapter, number) for number in range(1,5))), 0.5)
        self.assertEqual(len(session.calls), 1)
        self.assertEqual([item['partNumber'] for item in session.calls[0][1]['parts']], [1,2,3,4])
        self.assertEqual([grant.url.rsplit('-',1)[1] for grant in grants], ['1','2','3','4'])
        self.assertEqual([grant.headers['Content-MD5'] for grant in grants], ['md5-1','md5-2','md5-3','md5-4'])

    async def test_partial_batch_flushes_without_waiting_for_four_participants(self):
        session = Session()
        adapter = control(session)
        started = time.monotonic()
        grants = await asyncio.wait_for(asyncio.gather(part(adapter,1), part(adapter,2)), 0.2)
        self.assertLess(time.monotonic()-started, 0.05)
        self.assertEqual(len(grants),2)
        self.assertEqual(len(session.calls),1)
        self.assertEqual(len(session.calls[0][1]['parts']),2)

    async def test_every_command_is_bounded_at_four_and_no_part_is_lost(self):
        session = Session()
        adapter = control(session)
        grants = await asyncio.wait_for(asyncio.gather(*(part(adapter,number) for number in range(1,10))), 0.5)
        self.assertEqual(len(grants),9)
        self.assertEqual(sorted(part['partNumber'] for _,fields in session.calls for part in fields['parts']), list(range(1,10)))
        self.assertTrue(all(1 <= len(fields['parts']) <= 4 for _,fields in session.calls))

    async def test_cancelled_queued_part_is_not_sent_and_cannot_hold_other_participants(self):
        session = Session()
        adapter = control(session)
        cancelled = asyncio.create_task(part(adapter,1))
        await asyncio.sleep(0)
        cancelled.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await cancelled
        await asyncio.sleep(0.02)
        self.assertEqual(session.calls,[])
        grant = await asyncio.wait_for(part(adapter,2),0.2)
        self.assertTrue(grant.url.endswith('part-2'))

    async def test_one_cancelled_inflight_part_does_not_cancel_its_three_siblings(self):
        session = Session();session.release.clear()
        adapter = control(session)
        tasks = [asyncio.create_task(part(adapter,number)) for number in range(1,5)]
        try:
            self.assertTrue(await asyncio.to_thread(session.entered.wait,0.3))
            tasks[0].cancel()
            session.release.set()
            results = await asyncio.wait_for(asyncio.gather(*tasks,return_exceptions=True),0.5)
            self.assertIsInstance(results[0],asyncio.CancelledError)
            self.assertEqual([grant.url.rsplit('-',1)[1] for grant in results[1:]], ['2','3','4'])
            self.assertEqual(len(session.calls),1)
        finally:
            session.release.set()

    async def test_cancelling_every_inflight_waiter_releases_the_batch_and_all_four_slots(self):
        session = Session();session.release.clear()
        adapter = control(session)
        tasks = [asyncio.create_task(part(adapter,number)) for number in range(1,5)]
        try:
            self.assertTrue(await asyncio.to_thread(session.entered.wait,0.3))
            for task in tasks:
                task.cancel()
            results = await asyncio.wait_for(asyncio.gather(*tasks,return_exceptions=True),0.2)
            self.assertTrue(all(isinstance(result,asyncio.CancelledError) for result in results))
            session.release.set()
            grants = await asyncio.wait_for(asyncio.gather(*(part(adapter,number) for number in range(5,9))),0.3)
            self.assertEqual(len(grants),4)
            self.assertEqual(len(session.calls),2)
        finally:
            session.release.set()

    async def test_duplicate_part_numbers_keep_separate_commands(self):
        session = Session()
        adapter = control(session)
        grants = await asyncio.wait_for(asyncio.gather(part(adapter,1),part(adapter,1)),0.3)
        self.assertEqual(len(grants),2)
        self.assertEqual(len(session.calls),2)
        self.assertTrue(all([item['partNumber'] for item in fields['parts']]==[1] for _,fields in session.calls))

    async def test_control_error_and_revocation_reach_all_waiters_without_hanging(self):
        for failure in [MultipartTransferError('multipart_transport_failed'),ExecutionControlError('execution_authority_lost')]:
            session = Session();session.failure=failure
            adapter = control(session)
            results = await asyncio.wait_for(asyncio.gather(*(part(adapter,number) for number in range(1,5)),return_exceptions=True),0.5)
            self.assertTrue(all(isinstance(result,type(failure)) for result in results))
            self.assertEqual(len(session.calls),1)

    async def test_missing_grant_fails_the_whole_batch(self):
        session = Session();session.missing_grant=True
        adapter = control(session)
        results = await asyncio.wait_for(asyncio.gather(*(part(adapter,number) for number in range(1,5)),return_exceptions=True),0.5)
        self.assertTrue(all(isinstance(result,MultipartTransferError) for result in results))
        self.assertTrue(all(str(result)=='multipart_grant_invalid' for result in results))

    async def test_abort_settles_a_full_batch_even_before_its_control_task_starts(self):
        session = Session()
        adapter = control(session)
        tasks = [asyncio.create_task(part(adapter,number)) for number in range(1,5)]
        await asyncio.sleep(0)
        await adapter.abort('cancelled')
        results = await asyncio.wait_for(asyncio.gather(*tasks,return_exceptions=True),0.2)
        self.assertTrue(all(isinstance(result,MultipartTransferError) for result in results))
        self.assertEqual([action for action,_ in session.calls],['upload-abort'])

    async def test_abort_settles_all_inflight_participants_without_waiting_for_the_old_reply(self):
        session = Session();session.release.clear()
        adapter = control(session)
        tasks = [asyncio.create_task(part(adapter,number)) for number in range(1,5)]
        try:
            self.assertTrue(await asyncio.to_thread(session.entered.wait,0.3))
            await asyncio.wait_for(adapter.abort('cancelled'),0.2)
            results = await asyncio.wait_for(asyncio.gather(*tasks,return_exceptions=True),0.2)
            self.assertTrue(all(isinstance(result,MultipartTransferError) for result in results))
        finally:
            session.release.set()

    async def test_abort_settles_queued_part_without_a_later_authorization(self):
        session = Session()
        adapter = control(session)
        queued = asyncio.create_task(part(adapter,1))
        await asyncio.sleep(0)
        await adapter.abort('cancelled')
        result = await asyncio.wait_for(asyncio.gather(queued,return_exceptions=True),0.2)
        self.assertIsInstance(result[0],MultipartTransferError)
        await asyncio.sleep(0.02)
        self.assertEqual([action for action,_ in session.calls],['upload-abort'])


if __name__ == '__main__':
    unittest.main()
