"""Read Source 2 navigation topology for selecting the original Wingman area.
Format reference: ValveResourceFormat 20.1 NavMesh classes (MIT).
The optional KV3 metadata is skipped by its declared byte lengths, never executed.
"""
import json
import pathlib
import struct
import sys


class Reader:
    def __init__(self, data):
        self.data, self.pos = data, 0

    def take(self, fmt):
        size = struct.calcsize("<" + fmt)
        if self.pos + size > len(self.data):
            raise ValueError("Truncated navigation file")
        result = struct.unpack_from("<" + fmt, self.data, self.pos)
        self.pos += size
        return result[0] if len(result) == 1 else result

    def skip(self, size):
        if size < 0 or self.pos + size > len(self.data):
            raise ValueError("Invalid navigation block length")
        self.pos += size

    def count(self, maximum=1000000):
        count = self.take("I")
        if count > maximum:
            raise ValueError("Navigation count exceeds limit")
        return count

    def string(self):
        end = self.data.find(b"\0", self.pos)
        if end < 0 or end - self.pos > 4096:
            raise ValueError("Invalid navigation string")
        self.pos = end + 1

    def kv3(self):
        self.pos = (self.pos + 7) & ~7
        start = self.pos
        magic = self.take("I")
        version = magic & 255
        if magic & 0xffffff00 != 0x4b563300 or not 2 <= version <= 5:
            raise ValueError("Unsupported embedded navigation KV3 version")
        self.skip(16)
        compression = self.take("I")
        self.skip(4 + 16 + 4)
        uncompressed, compressed, blocks, blobs = self.take("4I")
        if version >= 4:
            self.skip(8)
        if version >= 5:
            u1, c1, u2, c2 = self.take("4I")
            self.skip(32)
            if u1 + u2 != uncompressed:
                raise ValueError("Invalid embedded KV3 buffer lengths")
        if compression == 0:
            self.skip(uncompressed + (blobs + 4 if blocks else 0))
        elif compression == 2:
            self.skip(compressed + (4 if blocks else 0))
        elif compression == 1 and not blocks:
            self.skip(compressed)
        else:
            raise ValueError("Embedded KV3 blob compression needs an explicit decoder")
        return {"offset": start, "version": version, "compression": compression, "blocks": blocks}


def read_nav(path):
    reader = Reader(pathlib.Path(path).read_bytes())
    magic, version, subversion, flags = reader.take("4I")
    if magic != 0xfeedface or not 30 <= version <= 36:
        raise ValueError("Unsupported Source 2 navigation header")
    metadata = []
    if version >= 36:
        metadata.append(reader.kv3())
    polygons = []
    if version >= 31:
        corners = [reader.take("3f") for _ in range(reader.count())]
        for _ in range(reader.count()):
            count = reader.take("B")
            if not 3 <= count <= 64:
                raise ValueError("Invalid navigation polygon size")
            polygon = [corners[reader.take("I")] for _ in range(count)]
            movable = reader.take("I") if version >= 35 else 0xffffffff
            polygons.append((polygon, movable))
    if version >= 32 and reader.take("I") != 0:
        raise ValueError("Unknown navigation header field is nonzero")
    if version >= 35:
        for _ in range(reader.count(10000)):
            reader.string()
            reader.skip(48)
    if version >= 36:
        metadata.append(reader.kv3())
    areas = []
    for _ in range(reader.count()):
        area_id, attributes, hull = reader.take("IqB")
        if version >= 31:
            polygon, movable = polygons[reader.take("I")]
        else:
            polygon = [reader.take("3f") for _ in range(reader.count(64))]
            movable = 0xffffffff
        reader.take("f")
        adjacent = []
        for _ in polygon:
            adjacent.extend(reader.take("2I")[0] for _ in range(reader.count(10000)))
        legacy_hiding, legacy_encounters = reader.take("BI")
        if legacy_hiding or legacy_encounters:
            raise ValueError("Unsupported legacy navigation records")
        above = [reader.take("I") for _ in range(reader.count(10000))]
        below = [reader.take("I") for _ in range(reader.count(10000))]
        areas.append({"id": area_id, "flags": attributes, "hull": hull, "movable": movable,
                      "corners": polygon, "adjacent": sorted(set(adjacent)),
                      "ladders_above": above, "ladders_below": below})
    ladder_count = reader.take("I")
    return {"version": version, "subversion": subversion, "flags": flags, "metadata": metadata,
            "areas": areas, "ladder_count": ladder_count}


if __name__ == "__main__":
    data = read_nav(sys.argv[1])
    pathlib.Path(sys.argv[2]).write_text(json.dumps(data, separators=(",", ":")) + "\n")
    points = [point for area in data["areas"] for point in area["corners"]]
    summary = {key: data[key] for key in ("version", "subversion", "metadata", "ladder_count")}
    summary.update(areas=len(data["areas"]), hulls=sorted(set(a["hull"] for a in data["areas"])),
                   source_bounds=[[min(p[i] for p in points) for i in range(3)],
                                  [max(p[i] for p in points) for i in range(3)]])
    print(json.dumps(summary, indent=2))
