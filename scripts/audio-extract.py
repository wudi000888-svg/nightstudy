#!/usr/bin/env python3
"""Extract a precomputed audio tar.gz into an empty staging directory.

The installer verifies the compressed artifact and individual assets separately.
This module never downloads content, opens a database, or uses tar.extractall.
"""
import argparse
import gzip
import json
import os
import re
import stat
import sys
import tarfile
import zlib
from dataclasses import dataclass
from pathlib import Path

MAX_MEMBERS = 20050
MAX_NAME_BYTES = 256
MAX_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024
MAX_STREAM_BYTES = MAX_EXPANDED_BYTES
MAX_PAX_BYTES = 64 * 1024
MAX_TRAILING_BYTES = 10240
CHUNK_BYTES = 65536
AUDIO_NAME = re.compile(r"files/[a-f0-9]{64}\.(?:wav|ogg|mp3)\Z")
LICENSE_NAME = re.compile(r"licenses/[A-Za-z0-9_.-]+\.(?:txt|json|md)\Z")


class ArchiveError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class Entry:
    name: str
    size: int
    directory: bool


class ExpandedReader:
    def __init__(self, compressed):
        self.stream = gzip.GzipFile(fileobj=compressed, mode="rb")
        self.expanded = 0

    def read(self, count):
        if not 0 <= count <= CHUNK_BYTES:
            raise ArchiveError("archive_read_limit")
        data = self.stream.read(count)
        self.expanded += len(data)
        if self.expanded > MAX_STREAM_BYTES:
            raise ArchiveError("archive_expansion_limit")
        return data

    def exact(self, count):
        if count > CHUNK_BYTES:
            raise ArchiveError("archive_metadata_limit")
        output = bytearray()
        while len(output) < count:
            chunk = self.read(count - len(output))
            if not chunk:
                raise ArchiveError("archive_truncated")
            output.extend(chunk)
        return bytes(output)

    def consume(self, count, destination=None):
        remaining = count
        while remaining:
            chunk = self.read(min(remaining, CHUNK_BYTES))
            if not chunk:
                raise ArchiveError("archive_truncated")
            if destination is not None:
                destination.write(chunk)
            remaining -= len(chunk)

    def close(self):
        self.stream.close()


def pax_records(raw):
    """Bound PAX headers before parsing; never let tarfile allocate their declared size."""
    result = {}
    position = 0
    allowed = {"path", "size", "mtime", "atime", "ctime", "uid", "gid", "uname", "gname"}
    while position < len(raw):
        separator = raw.find(b" ", position, position + 12)
        if separator < 0 or not raw[position:separator].isdigit():
            raise ArchiveError("archive_metadata_invalid")
        length = int(raw[position:separator])
        if length <= separator - position + 2 or position + length > len(raw):
            raise ArchiveError("archive_metadata_invalid")
        record = raw[separator + 1:position + length]
        if not record.endswith(b"\n") or b"=" not in record:
            raise ArchiveError("archive_metadata_invalid")
        key_bytes, value_bytes = record[:-1].split(b"=", 1)
        key = key_bytes.decode("ascii", "strict")
        value = value_bytes.decode("utf-8", "strict")
        if key not in allowed or key in result or len(value_bytes) > MAX_NAME_BYTES or "\x00" in value:
            raise ArchiveError("archive_metadata_invalid")
        result[key] = value
        position += length
    return result


def validate_entry(info, name, size):
    if not name or len(name.encode("utf-8")) > MAX_NAME_BYTES or "\x00" in name or "\\" in name:
        raise ArchiveError("archive_name_invalid")
    if name.startswith("/") or any(part in {".", ".."} for part in name.split("/")):
        raise ArchiveError("archive_path_rejected")
    if size < 0 or info.linkname or info.sparse is not None:
        raise ArchiveError("archive_type_rejected")
    if info.type == tarfile.DIRTYPE:
        if name not in {"files", "files/", "licenses", "licenses/"} or size != 0:
            raise ArchiveError("archive_directory_rejected")
        return Entry(name.rstrip("/"), 0, True)
    if info.type not in {tarfile.REGTYPE, tarfile.AREGTYPE}:
        raise ArchiveError("archive_type_rejected")
    if name == "manifest.json":
        maximum = 32 * 1024 * 1024
    elif name == "sources.manifest.json" or LICENSE_NAME.fullmatch(name):
        maximum = 1024 * 1024
    elif AUDIO_NAME.fullmatch(name):
        maximum = 2 * 1024 * 1024
    else:
        raise ArchiveError("archive_name_not_allowed")
    if size > maximum:
        raise ArchiveError("archive_file_limit")
    return Entry(name, size, False)


def walk_archive(compressed, on_entry=None):
    """Read 512-byte headers directly so oversized hidden PAX/GNU metadata cannot OOM."""
    compressed.seek(0)
    reader = ExpandedReader(compressed)
    entries = []
    names = set()
    global_pax = {}
    pending_pax = {}
    payload_bytes = 0
    headers = 0
    try:
        while True:
            header = reader.exact(512)
            if header == b"\x00" * 512:
                if reader.exact(512) != b"\x00" * 512 or pending_pax:
                    raise ArchiveError("archive_end_invalid")
                trailing = 0
                while True:
                    chunk = reader.read(CHUNK_BYTES)
                    if not chunk:
                        break
                    trailing += len(chunk)
                    if any(chunk) or trailing > MAX_TRAILING_BYTES:
                        raise ArchiveError("archive_trailing_data")
                break
            headers += 1
            if headers > MAX_MEMBERS * 2 + 32:
                raise ArchiveError("archive_member_limit")
            info = tarfile.TarInfo.frombuf(header, "utf-8", "strict")
            if len(info.name.encode("utf-8")) > MAX_NAME_BYTES:
                raise ArchiveError("archive_name_invalid")
            if info.type in {tarfile.XHDTYPE, tarfile.XGLTYPE}:
                if info.size < 0 or info.size > MAX_PAX_BYTES or info.linkname:
                    raise ArchiveError("archive_metadata_limit")
                records = pax_records(reader.exact(info.size))
                reader.consume((-info.size) % 512)
                if info.type == tarfile.XGLTYPE:
                    global_pax.update(records)
                else:
                    if pending_pax:
                        raise ArchiveError("archive_metadata_invalid")
                    pending_pax = records
                continue
            attributes = {**global_pax, **pending_pax}
            pending_pax = {}
            name = attributes.get("path", info.name)
            raw_size = attributes.get("size")
            if raw_size is not None and not re.fullmatch(r"[0-9]{1,12}", raw_size):
                raise ArchiveError("archive_metadata_invalid")
            entry = validate_entry(info, name, int(raw_size) if raw_size is not None else info.size)
            if entry.name in names:
                raise ArchiveError("archive_duplicate_name")
            names.add(entry.name)
            entries.append(entry)
            if len(entries) > MAX_MEMBERS:
                raise ArchiveError("archive_member_limit")
            payload_bytes += entry.size
            if payload_bytes > MAX_EXPANDED_BYTES:
                raise ArchiveError("archive_expansion_limit")
            destination = on_entry(entry) if on_entry else None
            try:
                reader.consume(entry.size, destination)
            finally:
                if destination is not None:
                    destination.close()
            reader.consume((-entry.size) % 512)
        if "manifest.json" not in names:
            raise ArchiveError("archive_manifest_missing")
        return entries, payload_bytes
    finally:
        reader.close()


def extract_archive(archive, output):
    archive_flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    with os.fdopen(os.open(archive, archive_flags), "rb") as source:
        source_stat = os.fstat(source.fileno())
        if not stat.S_ISREG(source_stat.st_mode):
            raise ArchiveError("archive_not_regular")
        # Validate the entire stream before creating a single output file.
        expected, payload_bytes = walk_archive(source)
        output_path = Path(output)
        if output_path.is_symlink():
            raise ArchiveError("output_not_empty_directory")
        if output_path.exists():
            if not output_path.is_dir() or any(output_path.iterdir()):
                raise ArchiveError("output_not_empty_directory")
        else:
            output_path.mkdir(mode=0o755)
        directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
        root_fd = os.open(output_path, directory_flags)
        directory_fds = {}
        position = 0
        try:
            os.fchmod(root_fd, 0o755)

            def directory(name):
                if name not in directory_fds:
                    os.mkdir(name, mode=0o755, dir_fd=root_fd)
                    fd = os.open(name, directory_flags, dir_fd=root_fd)
                    os.fchmod(fd, 0o755)
                    directory_fds[name] = fd
                return directory_fds[name]

            def write_entry(entry):
                nonlocal position
                if position >= len(expected) or expected[position] != entry:
                    raise ArchiveError("archive_changed")
                position += 1
                if entry.directory:
                    directory(entry.name)
                    return None
                if "/" in entry.name:
                    parent, filename = entry.name.split("/", 1)
                    parent_fd = directory(parent)
                else:
                    parent_fd, filename = root_fd, entry.name
                flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
                fd = os.open(filename, flags, 0o644, dir_fd=parent_fd)
                os.fchmod(fd, 0o644)
                return os.fdopen(fd, "wb")

            current_stat = os.fstat(source.fileno())
            if (current_stat.st_size, current_stat.st_mtime_ns) != (source_stat.st_size, source_stat.st_mtime_ns):
                raise ArchiveError("archive_changed")
            actual, actual_payload = walk_archive(source, write_entry)
            if actual != expected or actual_payload != payload_bytes:
                raise ArchiveError("archive_changed")
        finally:
            for fd in directory_fds.values():
                os.close(fd)
            os.close(root_fd)
    return {"ok": True, "members": len(expected), "files": sum(not entry.directory for entry in expected), "expandedBytes": payload_bytes}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True)
    parser.add_argument("--output", required=True)
    arguments = parser.parse_args()
    try:
        result = extract_archive(arguments.archive, arguments.output)
    except ArchiveError as error:
        print(json.dumps({"ok": False, "code": error.code}), file=sys.stderr)
        return 1
    except (OSError, EOFError, tarfile.TarError, UnicodeError, ValueError, zlib.error):
        print(json.dumps({"ok": False, "code": "archive_invalid_or_unreadable"}), file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
