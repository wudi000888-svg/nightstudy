"""Model-free transport fixtures; cloud CI only, without any network requests."""
from pathlib import Path
import hashlib
import importlib.util
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('publication_transport', Path(__file__).with_name('run-ci-sentence-audio-publication.py'))
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)

PAYLOAD = b'candidate'
NAME = 'candidate.json'
INDEX = {NAME: dict(id=123, size=len(PAYLOAD), digest='sha256:' + hashlib.sha256(PAYLOAD).hexdigest())}


def successful(command, **options):
    options['stdout'].write(PAYLOAD)
    return subprocess.CompletedProcess(command, 0)


def unavailable(command, **options):
    options['stdout'].write(b'partial response')
    options['stderr'].write(b'gh: HTTP 502: Bad Gateway\n')
    raise subprocess.CalledProcessError(1, command)


class DownloadTests(unittest.TestCase):
    def test_one502_then_success_preserves_only_the_verified_final_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            actions = iter((unavailable, successful))
            def execute(command, **options):
                self.assertEqual(command[:2], ['gh', 'api'])
                self.assertEqual(command[command.index('--method') + 1], 'GET')
                self.assertIn('Accept: application/octet-stream', command)
                self.assertTrue(options['check'])
                self.assertEqual(options['timeout'], 600)
                return next(actions)(command, **options)
            with patch.object(m.subprocess, 'run', side_effect=execute) as run, patch.object(m.time, 'sleep') as sleep:
                result = m.download(INDEX, NAME, root)
            self.assertEqual(result, root / NAME)
            self.assertEqual(result.read_bytes(), PAYLOAD)
            self.assertEqual(list(root.iterdir()), [result])
            self.assertEqual(run.call_count, 2)
            sleep.assert_called_once_with(1)

    def test_three502_attempts_are_the_limit_and_all_partial_bytes_are_removed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with patch.object(m.subprocess, 'run', side_effect=unavailable) as run, patch.object(m.time, 'sleep') as sleep:
                with self.assertRaises(subprocess.CalledProcessError):
                    m.download(INDEX, NAME, root)
            self.assertEqual(run.call_count, 3)
            self.assertEqual([call.args for call in sleep.call_args_list], [(1,), (2,)])
            self.assertEqual(list(root.iterdir()), [])

    def test_successful_transfer_with_bad_checksum_is_not_retried(self):
        def changed(command, **options):
            options['stdout'].write(b'changed!!')
            return subprocess.CompletedProcess(command, 0)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with patch.object(m.subprocess, 'run', side_effect=changed) as run, patch.object(m.time, 'sleep') as sleep:
                with self.assertRaisesRegex(ValueError, 'downloaded_candidate_pin'):
                    m.download(INDEX, NAME, root)
            run.assert_called_once()
            sleep.assert_not_called()
            self.assertEqual(list(root.iterdir()), [])

    def test_existing_regular_symlink_and_late_target_are_never_overwritten(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / NAME
            target.write_bytes(b'original')
            with patch.object(m.subprocess, 'run') as run:
                with self.assertRaisesRegex(ValueError, 'candidate_download_target_exists'):
                    m.download(INDEX, NAME, root)
                run.assert_not_called()
            self.assertEqual(target.read_bytes(), b'original')
            target.unlink()
            target.symlink_to(root / 'absent')
            with patch.object(m.subprocess, 'run') as run:
                with self.assertRaisesRegex(ValueError, 'candidate_download_target_exists'):
                    m.download(INDEX, NAME, root)
                run.assert_not_called()
            self.assertTrue(target.is_symlink())
            target.unlink()
            def raced(command, **options):
                target.write_bytes(b'concurrent owner')
                return successful(command, **options)
            with patch.object(m.subprocess, 'run', side_effect=raced) as run, patch.object(m.time, 'sleep') as sleep:
                with self.assertRaises(FileExistsError):
                    m.download(INDEX, NAME, root)
            run.assert_called_once()
            sleep.assert_not_called()
            self.assertEqual(target.read_bytes(), b'concurrent owner')
            self.assertEqual(list(root.iterdir()), [target])

    def test_authentication_and_other_local_errors_are_not_retried(self):
        def denied(command, **options):
            options['stderr'].write(b'gh: HTTP 403: Resource not accessible\n')
            raise subprocess.CalledProcessError(1, command)
        for error in (denied, FileNotFoundError('gh unavailable'), PermissionError('local filesystem denied')):
            with self.subTest(error=error), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                with patch.object(m.subprocess, 'run', side_effect=error) as run, patch.object(m.time, 'sleep') as sleep:
                    with self.assertRaises((subprocess.CalledProcessError, FileNotFoundError, PermissionError)):
                        m.download(INDEX, NAME, root)
                run.assert_called_once()
                sleep.assert_not_called()
                self.assertEqual(list(root.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
