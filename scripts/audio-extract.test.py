"""Real tar.gz safety regressions; no network, database or voice model required."""
import gzip
import importlib.util
import io
import os
import stat
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("audio_extract", Path(__file__).with_name("audio-extract.py"))
extractor = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = extractor
spec.loader.exec_module(extractor)


class SafeAudioExtraction(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="nightstudy-audio-extract-")
        self.directory = Path(self.temporary.name)
        self.archive = self.directory / "archive.tar.gz"
        self.output = self.directory / "output"

    def tearDown(self):
        self.temporary.cleanup()

    def pack(self, entries):
        with tarfile.open(self.archive, "w:gz", format=tarfile.PAX_FORMAT) as archive:
            for name, content, kind in entries:
                info = tarfile.TarInfo(name)
                info.mtime = 1.25  # Exercises a real, safely bounded PAX extended header.
                info.type = kind
                if kind == tarfile.SYMTYPE:
                    info.linkname = "../../outside"
                if kind in {tarfile.REGTYPE, tarfile.AREGTYPE}:
                    info.size = len(content)
                    archive.addfile(info, io.BytesIO(content))
                else:
                    archive.addfile(info)

    def reject(self, entries, code=None):
        self.pack(entries)
        with self.assertRaises(extractor.ArchiveError) as result:
            extractor.extract_archive(self.archive, self.output)
        if code:
            self.assertEqual(result.exception.code, code)
        self.assertFalse(self.output.exists(), "All metadata must be validated before extraction starts")

    def test_streams_ordinary_files_with_exact_contents_and_permissions(self):
        name = "files/" + "a" * 64 + ".wav"
        payload = b"RIFF" + b"original synthetic test fixture" * 3
        self.pack([(name, payload, tarfile.REGTYPE), ("files", b"", tarfile.DIRTYPE),
                   ("licenses", b"", tarfile.DIRTYPE), ("manifest.json", b"{}", tarfile.REGTYPE),
                   ("sources.manifest.json", b"{}", tarfile.REGTYPE),
                   ("licenses/original-test-license.txt", b"Original test fixture", tarfile.REGTYPE)])
        summary = extractor.extract_archive(self.archive, self.output)
        self.assertEqual(summary["files"], 4)
        self.assertEqual((self.output / name).read_bytes(), payload)
        self.assertEqual(stat.S_IMODE((self.output / name).stat().st_mode), 0o644)
        self.assertEqual(stat.S_IMODE((self.output / "files").stat().st_mode), 0o755)
        self.assertEqual(stat.S_IMODE(self.output.stat().st_mode), 0o755)

    def test_rejects_traversal_absolute_paths_backslashes_and_wrapper_directories(self):
        for name in ["../outside", "/etc/passwd", "files\\private.wav", "pack/manifest.json", "./manifest.json"]:
            with self.subTest(name=name):
                self.reject([("manifest.json", b"{}", tarfile.REGTYPE), (name, b"private", tarfile.REGTYPE)])

    def test_rejects_links_devices_and_fifo(self):
        for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.CHRTYPE, tarfile.BLKTYPE, tarfile.FIFOTYPE, tarfile.GNUTYPE_SPARSE]:
            with self.subTest(kind=kind):
                self.reject([("manifest.json", b"{}", tarfile.REGTYPE), ("files/" + "b" * 64 + ".wav", b"", kind)], "archive_type_rejected")

    def test_rejects_unlisted_files_and_duplicate_names(self):
        self.reject([("manifest.json", b"{}", tarfile.REGTYPE), ("licenses/run.py", b"not executed", tarfile.REGTYPE)], "archive_name_not_allowed")
        self.reject([("manifest.json", b"{}", tarfile.REGTYPE), ("manifest.json", b"duplicate", tarfile.REGTYPE)], "archive_duplicate_name")

    def test_rejects_oversized_effective_names_and_the_actual_60050_member_boundary(self):
        self.reject([("manifest.json", b"{}", tarfile.REGTYPE), ("licenses/" + "a" * 250 + ".txt", b"notice", tarfile.REGTYPE)])
        def entries():
            yield "manifest.json", b"{}", tarfile.REGTYPE
            for index in range(extractor.MAX_MEMBERS):
                yield "files/" + format(index, "064x") + ".wav", b"", tarfile.REGTYPE
        self.pack(entries())
        with self.assertRaises(extractor.ArchiveError) as result:
            extractor.extract_archive(self.archive, self.output)
        self.assertEqual(result.exception.code, "archive_member_limit")
        self.assertFalse(self.output.exists())

    def test_refuses_nonempty_or_symlink_output_without_overwriting_anything(self):
        self.pack([("manifest.json", b"{}", tarfile.REGTYPE)])
        self.output.mkdir()
        (self.output / "private").write_text("preserve")
        with self.assertRaises(extractor.ArchiveError):
            extractor.extract_archive(self.archive, self.output)
        self.assertEqual((self.output / "private").read_text(), "preserve")
        (self.output / "private").unlink()
        self.output.rmdir()
        other = self.directory / "other"
        other.mkdir()
        self.output.symlink_to(other, target_is_directory=True)
        with self.assertRaises(extractor.ArchiveError):
            extractor.extract_archive(self.archive, self.output)
        self.assertEqual(list(other.iterdir()), [])

    def test_rejects_member_and_total_payload_limits_using_real_tar_streams(self):
        self.pack([("manifest.json", b"{}", tarfile.REGTYPE), ("sources.manifest.json", b"{}", tarfile.REGTYPE)])
        with patch.object(extractor, "MAX_MEMBERS", 1), self.assertRaises(extractor.ArchiveError) as member_error:
            extractor.extract_archive(self.archive, self.output)
        self.assertEqual(member_error.exception.code, "archive_member_limit")
        with patch.object(extractor, "MAX_EXPANDED_BYTES", 3), self.assertRaises(extractor.ArchiveError) as size_error:
            extractor.extract_archive(self.archive, self.output)
        self.assertEqual(size_error.exception.code, "archive_expansion_limit")
        self.assertFalse(self.output.exists())

    def test_rejects_oversized_declared_file_and_pax_metadata_before_reading_payload(self):
        for name, size in [("manifest.json", 128 * 1024 * 1024 + 1),
                           ("sources.manifest.json", 32 * 1024 * 1024 + 1),
                           ("licenses/notice.txt", 1024 * 1024 + 1),
                           ("files/" + "c" * 64 + ".mp3", 2 * 1024 * 1024 + 1)]:
            with self.subTest(name=name):
                info = tarfile.TarInfo(name)
                info.size = size
                self.archive.write_bytes(gzip.compress(info.tobuf() + b"\0" * 1024))
                with self.assertRaises(extractor.ArchiveError) as result:
                    extractor.extract_archive(self.archive, self.output)
                self.assertEqual(result.exception.code, "archive_file_limit")
        info = tarfile.TarInfo("././@PaxHeader")
        info.type = tarfile.XHDTYPE
        info.size = extractor.MAX_PAX_BYTES + 1
        self.archive.write_bytes(gzip.compress(info.tobuf() + b"\0" * 1024))
        with self.assertRaises(extractor.ArchiveError) as result:
            extractor.extract_archive(self.archive, self.output)
        self.assertEqual(result.exception.code, "archive_metadata_limit")

    def test_rejects_truncation_bad_checksum_and_trailing_non_tar_content(self):
        self.pack([("manifest.json", b"{}", tarfile.REGTYPE)])
        packed = self.archive.read_bytes()
        self.archive.write_bytes(packed[:-8])
        with self.assertRaises((EOFError, OSError, extractor.ArchiveError)):
            extractor.extract_archive(self.archive, self.output)
        raw = bytearray(gzip.decompress(packed))
        raw[0] ^= 1
        self.archive.write_bytes(gzip.compress(raw))
        with self.assertRaises(tarfile.TarError):
            extractor.extract_archive(self.archive, self.output)
        raw = gzip.decompress(packed) + b"unexpected data"
        self.archive.write_bytes(gzip.compress(raw))
        with self.assertRaises(extractor.ArchiveError) as result:
            extractor.extract_archive(self.archive, self.output)
        self.assertEqual(result.exception.code, "archive_trailing_data")


if __name__ == "__main__":
    unittest.main()
