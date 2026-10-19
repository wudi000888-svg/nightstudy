#!/usr/bin/env python3
"""Model-free archive rejection tests; no model, network or child process."""
import gzip
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

FILE = Path(__file__).with_name('prepare-ci-sentence-audio-run.py')
SPEC = importlib.util.spec_from_file_location('bounded_ci_audio_plan_run', FILE)
run = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(run)


def info(name, data=b'{}', kind=tarfile.REGTYPE, link=''):
    member = tarfile.TarInfo(name)
    member.type = kind
    member.size = len(data) if kind in (tarfile.REGTYPE, tarfile.AREGTYPE) else 0
    member.linkname = link
    return member, data


def archive(root, members):
    file = root / 'ci-audio-plan-123-1.tar.gz'
    with tarfile.open(file, 'w:gz', format=tarfile.USTAR_FORMAT) as output:
        output.addfile(info(run.ROOT_NAME, kind=tarfile.DIRTYPE)[0])
        for member, data in members:
            output.addfile(member, io.BytesIO(data) if member.isfile() else None)
    raw = file.read_bytes()
    return file, dict(fileName=file.name, bytes=len(raw), sha256=run.sha(raw))


class PreparedRunTests(unittest.TestCase):
    def test_extracts_only_regular_plan_files_under_fresh_fixed_root(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            file, pin = archive(root, [info('.ci-audio-plan/job-manifest.json'),
                                       info('.ci-audio-plan/targets-0001.json', b'[]')])
            files = run.unpack_plan(run.Inputs(root), file, pin)
            self.assertEqual(files, {'.ci-audio-plan/job-manifest.json', '.ci-audio-plan/targets-0001.json'})
            self.assertEqual((root / '.ci-audio-plan/targets-0001.json').read_bytes(), b'[]')
            with self.assertRaisesRegex(ValueError, 'fresh_fixed_plan_root'):
                run.unpack_plan(run.Inputs(root), file, pin)

    def test_rejects_links_and_special_nodes_before_creating_output(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE, tarfile.CHRTYPE):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary).resolve()
                file, pin = archive(root, [info('.ci-audio-plan/request-0001.json', kind=kind,
                                                link='outside' if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE) else '')])
                with self.assertRaisesRegex(ValueError, 'archive_header_metadata|archive_regular_only'):
                    run.unpack_plan(run.Inputs(root), file, pin)
                self.assertFalse((root / '.ci-audio-plan').exists())

    def test_rejects_traversal_absolute_nested_and_sqlite_paths(self):
        for name in ('../escape.json', '/tmp/escape.json', '.ci-audio-plan/../escape.json',
                     '.ci-audio-plan/nested/request-0001.json', '.ci-audio-plan/planning.sqlite'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary).resolve()
                file, pin = archive(root, [info(name)])
                with self.assertRaises(ValueError):
                    run.unpack_plan(run.Inputs(root), file, pin)
                self.assertFalse((root / '.ci-audio-plan').exists())

    def test_duplicate_member_cannot_overwrite_earlier_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            file, pin = archive(root, [info('.ci-audio-plan/request-0001.json', b'first'),
                                       info('.ci-audio-plan/request-0001.json', b'changed')])
            with self.assertRaisesRegex(ValueError, 'archive_duplicate_or_member_limit'):
                run.unpack_plan(run.Inputs(root), file, pin)
            self.assertFalse((root / '.ci-audio-plan').exists())

    def test_oversized_header_is_rejected_without_allocating_member(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            member, _ = info('.ci-audio-plan/targets-0001.json')
            member.size = run.MAX_FILE + 1
            file = root / 'ci-audio-plan-123-1.tar.gz'
            file.write_bytes(gzip.compress(member.tobuf(format=tarfile.USTAR_FORMAT) + b'\0' * 1024))
            raw = file.read_bytes()
            pin = dict(fileName=file.name, bytes=len(raw), sha256=run.sha(raw))
            with self.assertRaisesRegex(ValueError, 'archive_allowed_plan_member'):
                run.unpack_plan(run.Inputs(root), file, pin)
            self.assertFalse((root / '.ci-audio-plan').exists())

    def test_total_expanded_budget_fails_in_preflight(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            file, pin = archive(root, [info('.ci-audio-plan/request-0001.json', b'a' * 10),
                                       info('.ci-audio-plan/targets-0001.json', b'b' * 10)])
            with patch.object(run, 'MAX_TOTAL', 19), self.assertRaisesRegex(ValueError, 'archive_total_limit'):
                run.unpack_plan(run.Inputs(root), file, pin)
            self.assertFalse((root / '.ci-audio-plan').exists())

    def test_member_count_budget_fails_before_extraction(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            file, pin = archive(root, [info('.ci-audio-plan/request-0001.json'), info('.ci-audio-plan/targets-0001.json')])
            with patch.object(run, 'MAX_MEMBERS', 2), self.assertRaisesRegex(ValueError, 'archive_duplicate_or_member_limit'):
                run.unpack_plan(run.Inputs(root), file, pin)
            self.assertFalse((root / '.ci-audio-plan').exists())

    def test_wrong_full_archive_hash_fails_before_tar_or_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            file, pin = archive(root, [info('.ci-audio-plan/job-manifest.json')])
            pin['sha256'] = '0' * 64
            with self.assertRaisesRegex(ValueError, 'input_hash_identity'):
                run.unpack_plan(run.Inputs(root), file, pin)
            self.assertFalse((root / '.ci-audio-plan').exists())

    def test_late_input_replacement_is_not_an_accepted_plan(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            file = root / 'input.json'
            file.write_bytes(b'{}')
            inputs = run.Inputs(root)
            self.assertEqual(inputs.read(file), b'{}')
            replacement = root / 'replacement.json'
            replacement.write_bytes(b'{}')
            os.replace(replacement, file)
            with self.assertRaisesRegex(ValueError, 'late_input_change'):
                inputs.unchanged()

    def test_one_line_matrix_never_replaces_existing_matrix(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            output = root / 'github-output'
            output.write_bytes(b'prior=value\n')
            matrix = dict(include=[dict(sliceNumber=1, packId='sentence-audio-v4-0101',
                requestFile='.ci-audio-plan/request-0001.json', requestSha256='a' * 64, groups=256, pairs=512)])
            run.write_matrix(output, matrix)
            lines = output.read_text().splitlines()
            self.assertEqual(lines[0], 'prior=value')
            self.assertEqual(json.loads(lines[1].removeprefix('matrix=')), matrix)
            original = output.read_bytes()
            with self.assertRaisesRegex(ValueError, 'fresh_matrix_output_key'):
                run.write_matrix(output, matrix)
            self.assertEqual(output.read_bytes(), original)

    def test_github_output_symlink_is_never_followed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            target = root / 'target'
            target.write_bytes(b'original\n')
            link = root / 'github-output'
            link.symlink_to(target)
            with self.assertRaisesRegex(ValueError, 'real_github_output_file'):
                run.write_matrix(link, dict(include=[]))
            self.assertEqual(target.read_bytes(), b'original\n')

    def test_rest_scope_has_no_implicit_approval(self):
        with patch.object(run.sys, 'argv', ['run', '--archive', 'unused.tar.gz', '--scope', 'rest', '--github-output', 'unused']):
            with self.assertRaises(SystemExit) as stopped:
                run.main()
            self.assertEqual(stopped.exception.code, 2)

    def test_duplicate_json_or_fabricated_first_approval_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'duplicate_json_key'):
            run.decode(b'{"kind":"one","kind":"other"}')
        with self.assertRaisesRegex(ValueError, 'committed_actual_plan_manifest'):
            run.plan_manifest(dict(kind='nightstudy-ci-audio-prepared-plan-pin-v1', approvedFirst={'invented': True}))


if __name__ == '__main__':
    unittest.main()
