from __future__ import annotations

import os
import asyncio
from pathlib import Path
import signal
import subprocess
import sys
import time
import tempfile
import threading
import unittest

from narriflow_media.process import MAX_OUTPUT_BYTES, MediaProcessError, run_owned_process, run_owned_process_async


class OwnedProcessTests(unittest.TestCase):
    def test_transfers_bounded_input_and_binary_output(self):
        result = run_owned_process(
            [sys.executable, "-c", "import sys;sys.stdout.buffer.write(sys.stdin.buffer.read()[::-1])"],
            input_bytes=b"\x00example\xff", timeout_seconds=2, kill_grace_seconds=0.1,
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b"\xffelpmaxe\x00")
        self.assertEqual(result.stderr, b"")

    def test_deadline_kills_a_detached_native_descendant(self):
        code = "import subprocess,sys,time; p=subprocess.Popen([sys.executable,'-c','import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(60)'],start_new_session=True);print(p.pid,flush=True);time.sleep(60)"
        result = run_owned_process([sys.executable, "-c", code], timeout_seconds=0.5, kill_grace_seconds=0.1)
        self.assertEqual(result.returncode, 124)
        self.assertTrue(result.stdout.strip().isdigit())
        self.assert_pid_stopped(int(result.stdout.strip()))


    def test_killed_wrapper_cannot_leave_detached_media_running(self):
        with tempfile.TemporaryDirectory() as directory:
            pid_file = Path(directory) / "native.pid"
            native = "import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(60)"
            launcher = f"import subprocess,sys,time;from pathlib import Path;p=subprocess.Popen([sys.executable,'-c',{native!r}],start_new_session=True);Path({str(pid_file)!r}).write_text(str(p.pid));time.sleep(60)"
            wrapper_code = f"from narriflow_media.process import run_owned_process;run_owned_process({[sys.executable, '-c', launcher]!r},timeout_seconds=60,kill_grace_seconds=0.1)"
            wrapper = subprocess.Popen([sys.executable, "-c", wrapper_code], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                until = time.monotonic() + 3
                while not pid_file.exists() and time.monotonic() < until:
                    time.sleep(0.025)
                self.assertTrue(pid_file.exists(), "native child never started")
                native_pid = int(pid_file.read_text())
                # Allow one supervisor sample to record a detached descendant
                # on macOS; Linux also adopts it through PR_SET_CHILD_SUBREAPER.
                time.sleep(0.2)
                wrapper.kill()
                wrapper.wait(timeout=2)
                self.assert_pid_stopped(native_pid)
            finally:
                if wrapper.poll() is None:
                    wrapper.kill()
                    wrapper.wait()


    def test_unbounded_child_output_is_stopped_at_the_protocol_limit(self):
        result = run_owned_process(
            [sys.executable, "-c", "import sys,time;sys.stdout.buffer.write(b'x'*(2*1024*1024));sys.stdout.flush();time.sleep(60)"],
            timeout_seconds=3, kill_grace_seconds=0.1,
        )
        self.assertEqual(result.returncode, 70)
        self.assertEqual(len(result.stdout), MAX_OUTPUT_BYTES)


    def test_native_children_never_inherit_database_credentials(self):
        environment = dict(os.environ, DATABASE_URL="private-database", DIRECT_URL="private-migration", PGPASSWORD="private-password", MEDIA_TEST_VALUE="kept")
        result = run_owned_process(
            [sys.executable, "-c", "import os,json;print(json.dumps({k:os.environ.get(k) for k in ['DATABASE_URL','DIRECT_URL','PGPASSWORD','MEDIA_TEST_VALUE']}))"],
            timeout_seconds=2, kill_grace_seconds=0.1, env=environment,
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.strip(), b'{"DATABASE_URL": null, "DIRECT_URL": null, "PGPASSWORD": null, "MEDIA_TEST_VALUE": "kept"}')


    def test_process_start_fires_once_after_the_actual_native_spawn(self):
        starts = []
        result = run_owned_process(
            [sys.executable, "-c", "import time;time.sleep(0.2)"],
            timeout_seconds=2, kill_grace_seconds=0.1,
            on_start=lambda pid: (os.kill(pid, 0), starts.append(pid)),
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(len(starts), 1)
        rejected = []
        failure = run_owned_process(
            ["/definitely-absent-narriflow-tool"], timeout_seconds=2,
            kill_grace_seconds=0.1, on_start=lambda pid: rejected.append(pid),
        )
        self.assertNotEqual(failure.returncode, 0)
        self.assertEqual(rejected, [])


    def test_cancellation_stops_active_work_and_waits_for_reaping(self):
        cancelled = threading.Event()
        children = []
        def started(pid):
            children.append(pid)
            threading.Timer(0.2, cancelled.set).start()
        began = time.monotonic()
        with self.assertRaises(MediaProcessError) as failure:
            run_owned_process([sys.executable, "-c", "import time;time.sleep(60)"],
                              timeout_seconds=60, kill_grace_seconds=0.1,
                              on_start=started, cancel_event=cancelled)
        self.assertEqual(failure.exception.code, "media_execution_cancelled")
        self.assertLess(time.monotonic() - began, 2)
        self.assertEqual(len(children), 1)
        self.assert_pid_stopped(children[0])

    def test_an_unconfirmed_start_ack_is_not_a_spawn_rejection(self):
        children = []
        def unconfirmed(pid):
            children.append(pid)
            raise OSError("private callback URL and credentials")
        with self.assertRaises(MediaProcessError) as failure:
            run_owned_process([sys.executable, "-c", "import time;time.sleep(60)"],
                              timeout_seconds=60, kill_grace_seconds=0.1, on_start=unconfirmed)
        self.assertEqual(failure.exception.code, "media_process_start_unconfirmed")
        self.assertEqual(str(failure.exception), "media_process_start_unconfirmed")
        self.assert_pid_stopped(children[0])

    def test_confirmed_start_retains_the_exit_result_when_the_child_finishes_during_acknowledgement(self):
        starts = []
        def acknowledge(pid):
            starts.append(pid)
            time.sleep(2.5)
        result = run_owned_process([sys.executable, '-c', "print('finished');raise SystemExit(7)"],
                                   input_bytes=b'withheld-work', timeout_seconds=5,
                                   kill_grace_seconds=0.1, on_start=acknowledge)
        self.assertEqual(len(starts), 1)
        self.assertEqual(result.returncode, 7)
        self.assertEqual(result.stdout, b'finished\n')
        self.assertEqual(result.stderr, b'')
        self.assert_pid_stopped(starts[0])

    def test_cli_work_command_is_withheld_until_the_actual_start_acknowledgement_succeeds(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'received-command'
            code = "import sys;from pathlib import Path;data=sys.stdin.buffer.read();Path(sys.argv[1]).write_bytes(data)"
            def acknowledge(pid):
                os.kill(pid, 0)
                time.sleep(0.15)
                self.assertFalse(path.exists(), 'work command reached the native child before acknowledgement')
            result = run_owned_process([sys.executable, '-c', code, str(path)], input_bytes=b'finite-work-command',
                                       timeout_seconds=3, kill_grace_seconds=0.1, on_start=acknowledge)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(path.read_bytes(), b'finite-work-command')
            path.unlink()
            def lost_ack(pid):
                time.sleep(0.1)
                raise TimeoutError('private acknowledgement details')
            with self.assertRaises(MediaProcessError):
                run_owned_process([sys.executable, '-c', code, str(path)], input_bytes=b'must-not-be-delivered',
                                  timeout_seconds=3, kill_grace_seconds=0.1, on_start=lost_ack)
            self.assertFalse(path.exists())


    def test_async_cancellation_waits_for_the_native_process_to_stop(self):
        children = []
        async def exercise():
            ready = asyncio.Event()
            loop = asyncio.get_running_loop()
            def started(pid):
                children.append(pid)
                loop.call_soon_threadsafe(ready.set)
            task = asyncio.create_task(run_owned_process_async(
                [sys.executable, "-c", "import time;time.sleep(60)"],
                timeout_seconds=60, kill_grace_seconds=0.1, on_start=started,
            ))
            await asyncio.wait_for(ready.wait(), 2)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        asyncio.run(exercise())
        self.assertEqual(len(children), 1)
        self.assert_pid_stopped(children[0])

    def test_async_external_lease_loss_stops_the_native_child(self):
        children, cancelled = [], threading.Event()
        async def exercise():
            loop, ready = asyncio.get_running_loop(), asyncio.Event()
            def started(pid):
                children.append(pid)
                loop.call_soon_threadsafe(ready.set)
            task = asyncio.create_task(run_owned_process_async(
                [sys.executable, "-c", "import time;time.sleep(60)"], timeout_seconds=60,
                kill_grace_seconds=0.1, on_start=started, cancel_event=cancelled,
            ))
            await asyncio.wait_for(ready.wait(), 2)
            cancelled.set()
            with self.assertRaises(MediaProcessError) as failure:
                await task
            self.assertEqual(failure.exception.code, "media_execution_cancelled")
        asyncio.run(exercise())
        self.assertEqual(len(children), 1)
        self.assert_pid_stopped(children[0])

    def test_native_file_limit_stops_unknown_length_output_at_the_exact_cap(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bounded.bin"
            code = "import signal,sys;signal.signal(signal.SIGXFSZ,signal.SIG_DFL);open(sys.argv[1],'wb').write(b'x'*8192)"
            result = run_owned_process([sys.executable, "-c", code, str(path)], timeout_seconds=2,
                                       kill_grace_seconds=0.1, max_file_bytes=4096)
            self.assertEqual(result.returncode, 73)
            self.assertLessEqual(path.stat().st_size, 4096)
            exact = run_owned_process([sys.executable, "-c", "import sys;open(sys.argv[1],'wb').write(b'x'*4096)", str(path)],
                                      timeout_seconds=2, kill_grace_seconds=0.1, max_file_bytes=4096)
            self.assertEqual(exact.returncode, 0)
            self.assertEqual(path.stat().st_size, 4096)

    def assert_pid_stopped(self, pid: int):
        until = time.monotonic() + 3
        while time.monotonic() < until:
            if sys.platform == 'linux':
                try:
                    state = Path(f'/proc/{pid}/stat').read_bytes().rsplit(b')', 1)[1].split()[0]
                except FileNotFoundError:
                    return
            else:
                state = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True).stdout.strip()
            if not state or state.startswith(b"Z"):
                return
            time.sleep(0.025)
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        self.fail("native descendant survived its owner")


if __name__ == "__main__":
    unittest.main()
