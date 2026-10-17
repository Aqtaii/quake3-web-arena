"""Resolve missing Source 2 resources from official Steam VPK chunks on a cloud runner.

Reads package indexes separately from the game search path. Downloads one required
chunk at a time, extracts only requested assets, then deletes that chunk.
No Steam credentials, third-party asset mirrors, pip packages or game binaries.
"""
import argparse
import collections
import json
import pathlib
import re
import struct
import subprocess


def cstring(stream):
    out = bytearray()
    while True:
        value = stream.read(1)
        if not value:
            raise ValueError("Truncated VPK string")
        if value == b"\0":
            return out.decode("utf-8")
        out.extend(value)
        if len(out) > 4096:
            raise ValueError("Oversized VPK path")


def read_index(path):
    entries = {}
    with path.open("rb") as stream:
        signature, version, tree_size = struct.unpack("<III", stream.read(12))
        if signature != 0x55AA1234 or version not in (1, 2):
            raise ValueError("Unsupported VPK header")
        header_size = 28 if version == 2 else 12
        stream.seek(header_size)
        tree_end = header_size + tree_size
        while True:
            ext = cstring(stream)
            if not ext:
                break
            while True:
                directory = cstring(stream)
                if not directory:
                    break
                while True:
                    name = cstring(stream)
                    if not name:
                        break
                    raw = stream.read(18)
                    if len(raw) != 18:
                        raise ValueError("Truncated VPK entry")
                    crc, preload_size, archive, offset, length, terminator = struct.unpack("<IHHIIH", raw)
                    if terminator != 65535:
                        raise ValueError("Invalid VPK entry terminator")
                    preload = stream.read(preload_size)
                    if len(preload) != preload_size or stream.tell() > tree_end:
                        raise ValueError("Invalid VPK tree bounds")
                    asset = (directory + "/" if directory != " " else "") + name
                    if ext != " ":
                        asset += "." + ext
                    entries[asset.lower()] = {
                        "archive": archive, "offset": offset, "length": length, "crc": crc,
                        "preload": preload, "data_start": tree_end,
                    }
    return entries


def safe_target(root, asset):
    target = (root / asset).resolve()
    if not target.is_relative_to(root.resolve()):
        raise ValueError("Resource escapes game directory")
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--log", type=pathlib.Path, required=True)
    parser.add_argument("--indexes", type=pathlib.Path, required=True)
    parser.add_argument("--game", type=pathlib.Path, required=True)
    parser.add_argument("--downloader", required=True)
    parser.add_argument("--report", type=pathlib.Path, required=True)
    parser.add_argument("--max-chunks", type=int, default=100)
    args = parser.parse_args()
    text = args.log.read_text(encoding="utf-8", errors="replace")
    missing = sorted(set(re.findall(r'Failed to load "([^"]+)"', text)))
    packages = []
    for index in sorted(args.indexes.glob("game/*/pak01_dir.vpk")):
        packages.append((index, read_index(index)))
    groups = collections.defaultdict(list)
    unknown = []
    for asset in missing:
        if safe_target(args.game / "csgo", asset).is_file():
            continue
        for index, entries in packages:
            if asset.lower() in entries:
                entry = entries[asset.lower()]
                groups[(index, entry["archive"])].append((asset, entry))
                break
        else:
            unknown.append(asset)
    if len(groups) > args.max_chunks:
        raise SystemExit("Dependency chunk limit exceeded: " + str(len(groups)))
    extracted = []
    for (index, archive), assets in groups.items():
        relative_index = index.relative_to(args.indexes)
        game_folder = relative_index.parent.name
        if archive == 0x7FFF:
            chunk = index
        else:
            name = index.name.replace("_dir.vpk", "_" + format(archive, "03d") + ".vpk")
            relative_chunk = relative_index.with_name(name)
            filelist = args.report.parent / "dependency-filelist.txt"
            filelist.parent.mkdir(parents=True, exist_ok=True)
            filelist.write_text(relative_chunk.as_posix() + "\n")
            command = [
                args.downloader, "-app", "730", "-depot", "2347770",
                "-filelist", str(filelist), "-dir", str(args.indexes),
                "-validate", "-max-downloads", "4",
            ]
            subprocess.run(command, check=True, timeout=180)
            chunk = args.indexes / relative_chunk
        with chunk.open("rb") as stream:
            for asset, entry in assets:
                target = safe_target(args.game / game_folder, asset)
                target.parent.mkdir(parents=True, exist_ok=True)
                offset = entry["offset"] + (entry["data_start"] if archive == 0x7FFF else 0)
                stream.seek(offset)
                remaining = entry["length"]
                with target.open("wb") as output:
                    output.write(entry["preload"])
                    while remaining:
                        block = stream.read(min(1024 * 1024, remaining))
                        if not block:
                            raise ValueError("Truncated VPK asset: " + asset)
                        output.write(block)
                        remaining -= len(block)
                # VPK stores CRC32 over preload and archive data.
                import zlib
                crc = 0
                with target.open("rb") as check:
                    for block in iter(lambda: check.read(1024 * 1024), b""):
                        crc = zlib.crc32(block, crc)
                if (crc & 0xFFFFFFFF) != entry["crc"]:
                    target.unlink()
                    raise ValueError("VPK CRC mismatch: " + asset)
                extracted.append({"asset": asset, "folder": game_folder, "bytes": target.stat().st_size,
                                  "crc32": format(crc & 0xFFFFFFFF, "08x")})
        if archive != 0x7FFF:
            chunk.unlink()
    report = {"requested": len(missing), "chunks": len(groups), "extracted": extracted, "not_in_indexes": unknown}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"requested": len(missing), "chunks": len(groups),
                      "extracted": len(extracted), "not_in_indexes": unknown}, indent=2))


if __name__ == "__main__":
    main()
