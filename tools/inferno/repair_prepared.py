import array
import copy
import json
import math
import pathlib
import re
import struct
import subprocess
import sys

from wingman_region import IDENTITY, matrix, multiply, point, source_point

SIZES = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}
FORMATS = {5120: "b", 5121: "B", 5122: "h", 5123: "H", 5125: "I", 5126: "f"}
COUNTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}

MAX_PRIM_VERTS = 850
MAX_PRIM_TRIS = 1700

STRUCTURAL_RENDER_KEYWORDS = (
    "floor", "ground", "wall04", "wall_09_blend", "facade", "plaster", "brick",
    "tile", "stair", "step", "ceiling", "house", "apartment_interior", "arch",
    "pillar", "column", "road", "pavement", "cobble", "gravel", "dirt_blend",
    "concrete_blend", "concrete_02", "shop_front", "window", "balcony",
    "courtyard", "wood_crate", "concrete_bag", "sandbag", "door_simple",
    "door_double", "barn_door", "rollup_door_02", "shingles", "barricade", "curb"
)

WALKABLE_COLLISION_KEYWORDS = (
    "floor", "ground", "stair", "step", "curb", "road", "pavement", "cobble",
    "gravel", "dirt_blend", "concrete_blend", "concrete_02", "tile", "courtyard",
    "balcony", "wall04", "wall_09_blend", "facade", "plaster", "brick", "house",
    "apartment_interior", "arch", "pillar", "column", "shop_front", "wood_crate",
    "concrete_bag", "sandbag", "door_simple", "door_double", "barn_door",
    "rollup_door_02", "barricade"
)


def load_gltf(path):
    doc = json.loads(path.read_text())
    blob = path.with_suffix(".bin").read_bytes()
    return doc, blob


def accessor_layout(doc, blob, index):
    a = doc["accessors"][index]
    view = doc["bufferViews"][a["bufferView"]]
    size = SIZES[a["componentType"]] * COUNTS[a["type"]]
    offset = view.get("byteOffset", 0) + a.get("byteOffset", 0)
    stride = view.get("byteStride", size)
    return a, offset, stride, size


def accessor_values(doc, blob, index):
    a, offset, stride, size = accessor_layout(doc, blob, index)
    fmt = "<" + FORMATS[a["componentType"]] * COUNTS[a["type"]]
    return [struct.unpack_from(fmt, blob, offset + i * stride) for i in range(a["count"])]


def world_matrices(doc):
    result = {}
    def walk(index, parent, chain):
        if index in chain:
            raise ValueError("Cyclic scene graph")
        transform = multiply(parent, matrix(doc["nodes"][index]))
        result[index] = transform
        for child in doc["nodes"][index].get("children", []):
            walk(child, transform, chain | {index})
    for root in doc["scenes"][doc.get("scene", 0)]["nodes"]:
        walk(root, IDENTITY, set())
    return result


def tri_max_edge_sq(p0, p1, p2):
    d01 = (p0[0]-p1[0])**2 + (p0[1]-p1[1])**2 + (p0[2]-p1[2])**2
    d12 = (p1[0]-p2[0])**2 + (p1[1]-p2[1])**2 + (p1[2]-p2[2])**2
    d20 = (p2[0]-p0[0])**2 + (p2[1]-p0[1])**2 + (p2[2]-p0[2])**2
    return max(d01, d12, d20)


def tri_area_sq(p0, p1, p2):
    ux, uy, uz = p1[0]-p0[0], p1[1]-p0[1], p1[2]-p0[2]
    vx, vy, vz = p2[0]-p0[0], p2[1]-p0[1], p2[2]-p0[2]
    cx = uy*vz - uz*vy
    cy = uz*vx - ux*vz
    cz = ux*vy - uy*vx
    return 0.25 * (cx*cx + cy*cy + cz*cz)


def overlaps_box(p0, p1, p2, box):
    lo, hi = box
    if max(p0[0], p1[0], p2[0]) < lo[0] or min(p0[0], p1[0], p2[0]) > hi[0]:
        return False
    if max(p0[1], p1[1], p2[1]) < lo[1] or min(p0[1], p1[1], p2[1]) > hi[1]:
        return False
    if max(p0[2], p1[2], p2[2]) < lo[2] or min(p0[2], p1[2], p2[2]) > hi[2]:
        return False
    return True


def chunk_triangles(indices):
    chunks = []
    cur_tris = []
    cur_verts = set()
    for i in range(0, len(indices), 3):
        t0, t1, t2 = indices[i], indices[i+1], indices[i+2]
        added = (t0 not in cur_verts) + (t1 not in cur_verts) + (t2 not in cur_verts)
        if cur_tris and (len(cur_verts) + added > MAX_PRIM_VERTS or len(cur_tris) // 3 + 1 > MAX_PRIM_TRIS):
            chunks.append(cur_tris)
            cur_tris = []
            cur_verts = set()
        cur_tris.extend((t0, t1, t2))
        cur_verts.add(t0)
        cur_verts.add(t1)
        cur_verts.add(t2)
    if cur_tris:
        chunks.append(cur_tris)
    return chunks


def repair_render_and_collect_collision(baseq3):
    render_path = baseq3 / "models/inferno/render.gltf"
    doc, blob = load_gltf(render_path)
    jobs = json.loads((baseq3 / "texture-jobs.json").read_text())
    job_by_mat = {}
    for job in jobs:
        stem = pathlib.Path(job["output"]).with_suffix("").as_posix()
        job_by_mat[stem] = job

    matrices = world_matrices(doc)
    nodes = copy.deepcopy(doc["nodes"])
    meshes, accessors, views, materials, new_blob = [], [], [], [], bytearray()
    material_map = {}
    used_material_names = set()

    render_box = ([256.0, -1018.5, 16.0], [2917.5, 1794.5, 752.0])
    collision_box = ([448.0, -826.0, 60.0], [2726.0, 1602.0, 320.0])

    structural_collision_gltf_tris = []
    kept_tris_total = 0
    kept_prims_total = 0

    def add_accessor(raw, template, count, minimum=None, maximum=None, target=34962):
        while len(new_blob) % 4:
            new_blob.append(0)
        offset = len(new_blob)
        new_blob.extend(raw)
        view_index = len(views)
        views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(raw), "target": target})
        result = {k: template[k] for k in ("componentType", "type", "normalized") if k in template}
        result.update(bufferView=view_index, count=count)
        if minimum is not None:
            result.update(min=minimum, max=maximum)
        accessors.append(result)
        return len(accessors) - 1

    for node_id, node in enumerate(nodes):
        original_mesh = node.pop("mesh", None)
        node.pop("skin", None)
        node.pop("weights", None)
        if original_mesh is None or node_id not in matrices:
            continue
        node_name = node.get("name", "").lower()
        if "blocklight" in node_name:
            continue
        is_overlay = "mesh_overlay" in node_name
        transform = matrices[node_id]
        new_primitives = []

        for prim in doc["meshes"][original_mesh].get("primitives", []):
            mat_idx = prim.get("material")
            if mat_idx is None:
                continue
            mat_name = doc["materials"][mat_idx]["name"]
            job = job_by_mat.get(mat_name, {})
            inp = (job.get("input") or "").lower()
            alpha_mode = job.get("alphaMode", "OPAQUE")

            if "tools_solid_block_light" in inp:
                continue
            if is_overlay and alpha_mode == "OPAQUE":
                continue

            is_structural_render = is_overlay or alpha_mode != "OPAQUE" or any(
                k in inp for k in STRUCTURAL_RENDER_KEYWORDS
            )
            is_walkable_collision = (not is_overlay) and any(
                k in inp for k in WALKABLE_COLLISION_KEYWORDS
            )

            attrs = prim["attributes"]
            positions = accessor_values(doc, blob, attrs["POSITION"])
            gltf_pts = [point(transform, p) for p in positions]
            src_pts = [source_point(gp) for gp in gltf_pts]
            indices = [v[0] for v in accessor_values(doc, blob, prim["indices"])]

            kept = []
            for i in range(0, len(indices), 3):
                i0, i1, i2 = indices[i], indices[i+1], indices[i+2]
                p0, p1, p2 = src_pts[i0], src_pts[i1], src_pts[i2]

                if is_walkable_collision and overlaps_box(p0, p1, p2, collision_box):
                    if tri_max_edge_sq(p0, p1, p2) >= 256.0 and tri_area_sq(p0, p1, p2) >= 4.0:
                        structural_collision_gltf_tris.append((gltf_pts[i0], gltf_pts[i1], gltf_pts[i2]))

                if not overlaps_box(p0, p1, p2, render_box):
                    continue
                if not is_structural_render and tri_max_edge_sq(p0, p1, p2) < 256.0:
                    continue
                kept.extend((i0, i1, i2))

            if not kept:
                continue

            if mat_name not in material_map:
                material_map[mat_name] = len(materials)
                materials.append({"name": mat_name})
            used_material_names.add(mat_name)
            new_mat_idx = material_map[mat_name]

            for chunk in chunk_triangles(kept):
                used = list(dict.fromkeys(chunk))
                remap = {old: new for new, old in enumerate(used)}
                new_attrs = {}
                for attr_name, acc_idx in attrs.items():
                    if attr_name not in ("POSITION", "NORMAL", "COLOR_0", "TEXCOORD_0"):
                        continue
                    a, offset, stride, size = accessor_layout(doc, blob, acc_idx)
                    raw = b"".join(blob[offset + j * stride : offset + j * stride + size] for j in used)
                    minimum = maximum = None
                    if attr_name == "POSITION":
                        minimum = [min(positions[j][k] for j in used) for k in range(3)]
                        maximum = [max(positions[j][k] for j in used) for k in range(3)]
                    new_attrs[attr_name] = add_accessor(raw, a, len(used), minimum, maximum)
                packed = array.array("I", (remap[j] for j in chunk))
                if sys.byteorder != "little":
                    packed.byteswap()
                idx_acc = add_accessor(
                    packed.tobytes(),
                    {"componentType": 5125, "type": "SCALAR"},
                    len(chunk),
                    target=34963,
                )
                new_primitives.append({"attributes": new_attrs, "indices": idx_acc, "material": new_mat_idx})
                kept_tris_total += len(chunk) // 3
                kept_prims_total += 1

        if new_primitives:
            node["mesh"] = len(meshes)
            meshes.append({"name": node.get("name", "mesh"), "primitives": new_primitives})

    render_path.with_suffix(".bin").write_bytes(new_blob)
    out_doc = {
        "asset": {"version": "2.0", "generator": "Repaired Source 2 Wingman render geometry"},
        "scene": doc.get("scene", 0),
        "scenes": doc["scenes"],
        "nodes": nodes,
        "meshes": meshes,
        "materials": materials,
        "accessors": accessors,
        "bufferViews": views,
        "buffers": [{"uri": render_path.with_suffix(".bin").name, "byteLength": len(new_blob)}],
    }
    render_path.write_text(json.dumps(out_doc, separators=(",", ":")) + "\n")
    print(f"Repaired render.gltf: {kept_tris_total} tris, {kept_prims_total} chunked primitives, {len(materials)} materials, {len(new_blob)} bytes")
    return used_material_names, structural_collision_gltf_tris


def repair_physics(baseq3, structural_collision_gltf_tris):
    phys_path = baseq3 / "models/inferno/physics.gltf"
    doc, blob = load_gltf(phys_path)
    matrices = world_matrices(doc)
    nodes = copy.deepcopy(doc["nodes"])
    meshes, accessors, views, materials, new_blob = [], [], [], [], bytearray()
    material_map = {}

    def get_mat(name):
        if name not in material_map:
            material_map[name] = len(materials)
            materials.append({"name": name})
        return material_map[name]

    def add_accessor(raw, template, count, minimum=None, maximum=None, target=34962):
        while len(new_blob) % 4:
            new_blob.append(0)
        offset = len(new_blob)
        new_blob.extend(raw)
        view_index = len(views)
        views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(raw), "target": target})
        result = {k: template[k] for k in ("componentType", "type", "normalized") if k in template}
        result.update(bufferView=view_index, count=count)
        if minimum is not None:
            result.update(min=minimum, max=maximum)
        accessors.append(result)
        return len(accessors) - 1

    kept_phys_tris = 0
    all_collision_src_tris = []

    for node_id, node in enumerate(nodes):
        original_mesh = node.pop("mesh", None)
        node.pop("skin", None)
        node.pop("weights", None)
        if original_mesh is None or node_id not in matrices:
            continue
        name = node.get("name", "").lower()
        if "prop_physics_multiplayer" in name:
            continue
        transform = matrices[node_id]
        new_prims = []
        for prim in doc["meshes"][original_mesh].get("primitives", []):
            attrs = prim["attributes"]
            positions = accessor_values(doc, blob, attrs["POSITION"])
            src_pts = [source_point(point(transform, p)) for p in positions]
            if min(p[2] for p in src_pts) > 360.0:
                continue
            indices = [v[0] for v in accessor_values(doc, blob, prim["indices"])]
            for i in range(0, len(indices), 3):
                all_collision_src_tris.append((src_pts[indices[i]], src_pts[indices[i+1]], src_pts[indices[i+2]]))

            mat_name = doc["materials"][prim["material"]]["name"]
            mat_idx = get_mat(mat_name)
            new_attrs = {}
            for attr_name, acc_idx in attrs.items():
                a, offset, stride, size = accessor_layout(doc, blob, acc_idx)
                raw = blob[offset : offset + a["count"] * stride]
                minimum = a.get("min")
                maximum = a.get("max")
                new_attrs[attr_name] = add_accessor(raw, a, a["count"], minimum, maximum)
            idx_a, idx_off, idx_stride, idx_size = accessor_layout(doc, blob, prim["indices"])
            idx_raw = blob[idx_off : idx_off + idx_a["count"] * idx_stride]
            idx_acc = add_accessor(idx_raw, idx_a, idx_a["count"], target=34963)
            new_prims.append({"attributes": new_attrs, "indices": idx_acc, "material": mat_idx})
            kept_phys_tris += len(indices) // 3

        if new_prims:
            node["mesh"] = len(meshes)
            meshes.append({"name": node.get("name", "physics"), "primitives": new_prims})

    solid_mat_idx = get_mat("textures/inferno/physics_solid")
    world_prims = []
    batch_size = 5000
    for start in range(0, len(structural_collision_gltf_tris), batch_size):
        batch = structural_collision_gltf_tris[start : start + batch_size]
        pos_list = []
        idx_list = []
        vert_map = {}
        for p0, p1, p2 in batch:
            all_collision_src_tris.append((source_point(p0), source_point(p1), source_point(p2)))
            for p in (p0, p1, p2):
                key = (round(p[0], 4), round(p[1], 4), round(p[2], 4))
                v_idx = vert_map.get(key)
                if v_idx is None:
                    v_idx = len(pos_list)
                    vert_map[key] = v_idx
                    pos_list.append(p)
                idx_list.append(v_idx)
        pos_raw = b"".join(struct.pack("<3f", *p) for p in pos_list)
        minimum = [min(p[k] for p in pos_list) for k in range(3)]
        maximum = [max(p[k] for p in pos_list) for k in range(3)]
        pos_acc = add_accessor(pos_raw, {"componentType": 5126, "type": "VEC3"}, len(pos_list), minimum, maximum)
        packed = array.array("I", idx_list)
        if sys.byteorder != "little":
            packed.byteswap()
        idx_acc = add_accessor(packed.tobytes(), {"componentType": 5125, "type": "SCALAR"}, len(idx_list), target=34963)
        world_prims.append({"attributes": {"POSITION": pos_acc}, "indices": idx_acc, "material": solid_mat_idx})

    if world_prims:
        world_mesh_idx = len(meshes)
        meshes.append({"name": "world_structural_collision", "primitives": world_prims})
        world_node_idx = len(nodes)
        nodes.append({"name": "world_structural_collision", "mesh": world_mesh_idx})
        doc["scenes"][doc.get("scene", 0)]["nodes"].append(world_node_idx)

    phys_path.with_suffix(".bin").write_bytes(new_blob)
    out_doc = {
        "asset": {"version": "2.0", "generator": "Repaired Source 2 Wingman physics geometry"},
        "scene": doc.get("scene", 0),
        "scenes": doc["scenes"],
        "nodes": nodes,
        "meshes": meshes,
        "materials": materials,
        "accessors": accessors,
        "bufferViews": views,
        "buffers": [{"uri": phys_path.with_suffix(".bin").name, "byteLength": len(new_blob)}],
    }
    phys_path.write_text(json.dumps(out_doc, separators=(",", ":")) + "\n")
    total_tris = kept_phys_tris + len(structural_collision_gltf_tris)
    print(f"Repaired physics.gltf: {kept_phys_tris} entity tris + {len(structural_collision_gltf_tris)} world structural tris = {total_tris} total collision tris")
    return all_collision_src_tris


def point_in_tri_2d(px, py, a, b, c):
    def sign(x1, y1, x2, y2, x3, y3):
        return (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3)
    d1 = sign(px, py, a[0], a[1], b[0], b[1])
    d2 = sign(px, py, b[0], b[1], c[0], c[1])
    d3 = sign(px, py, c[0], c[1], a[0], a[1])
    has_neg = (d1 < -0.01) or (d2 < -0.01) or (d3 < -0.01)
    has_pos = (d1 > 0.01) or (d2 > 0.01) or (d3 > 0.01)
    return not (has_neg and has_pos)


def repair_map_and_shaders(baseq3, all_collision_src_tris):
    map_path = baseq3 / "maps/inferno_wingman.map"
    map_text = map_path.read_text()
    map_text = map_text.replace(" textures/inferno/sky ", " inferno/sky ")
    map_text = map_text.replace(
        '"model" "models/inferno/render.gltf"\n"angles" "0 90 0"\n"modelscale" "39.37007874015748"\n"spawnflags" "4"',
        '"model" "models/inferno/render.gltf"\n"angles" "0 90 0"\n"modelscale" "39.37007874015748"\n"spawnflags" "0"',
    )
    map_path.write_text(map_text)

    spawns = re.findall(r'"classname" "info_player_deathmatch"\s+"origin" "([^"]+)"', map_text)
    assert len(spawns) == 8, f"Expected 8 spawns, found {len(spawns)}"
    for idx, s in enumerate(spawns):
        sx, sy, sz = map(float, s.split())
        best_floor = -math.inf
        for a, b, c in all_collision_src_tris:
            if min(a[0], b[0], c[0]) - 8 <= sx <= max(a[0], b[0], c[0]) + 8 and min(a[1], b[1], c[1]) - 8 <= sy <= max(a[1], b[1], c[1]) + 8:
                if point_in_tri_2d(sx, sy, a, b, c):
                    tz = (a[2] + b[2] + c[2]) / 3.0
                    if tz <= sz and tz > best_floor:
                        best_floor = tz
        print(f"Spawn {idx}: origin=({sx}, {sy}, {sz}) -> solid floor below at Z={best_floor:.2f} (drop={sz - best_floor:.2f})")
        if best_floor < -100 or sz - best_floor > 96:
            raise RuntimeError(f"Spawn {idx} at ({sx}, {sy}, {sz}) lacks solid floor underneath (best_floor={best_floor})")

    shader_path = baseq3 / "scripts/inferno.shader"
    shader_text = shader_path.read_text()
    shader_text = shader_text.replace("sort banner\n{", "polygonOffset\nsort banner\n{")
    shader_path.write_text(shader_text)


def next_pow2_down(n, max_dim):
    p = 1
    while p * 2 <= n and p * 2 <= max_dim:
        p *= 2
    return max(1, min(p, max_dim))


def optimize_textures(baseq3, used_material_names):
    tex_dir = baseq3 / "textures/inferno"
    kept_files = 0
    removed_files = 0
    total_bytes = 0

    for path in sorted(tex_dir.glob("*")):
        if not path.is_file():
            continue
        mat_name = "textures/inferno/" + path.stem
        if mat_name not in used_material_names:
            path.unlink()
            removed_files += 1
            continue

        if path.suffix.lower() == ".tga":
            data = path.read_bytes()
            w, h = struct.unpack_from("<HH", data, 12)
            tw, th = next_pow2_down(w, 256), next_pow2_down(h, 256)
            if (tw, th) != (w, h):
                src = memoryview(data)[18:]
                out = bytearray(18 + tw * th * 4)
                out[:18] = data[:18]
                struct.pack_into("<HH", out, 12, tw, th)
                sx, sy = w // tw, h // th
                for y in range(th):
                    row_off = (y * sy) * w * 4
                    dst_row = 18 + y * tw * 4
                    for x in range(tw):
                        p_off = row_off + (x * sx) * 4
                        d_off = dst_row + x * 4
                        out[d_off : d_off + 4] = src[p_off : p_off + 4]
                path.write_bytes(out)
        elif path.suffix.lower() == ".jpg":
            out = subprocess.check_output(["identify", "-format", "%w %h", str(path)], text=True).strip()
            w, h = map(int, out.split())
            tw, th = next_pow2_down(w, 512), next_pow2_down(h, 512)
            subprocess.check_call([
                "convert", str(path),
                "-resize", f"{tw}x{th}!",
                "-quality", "90",
                "-sampling-factor", "4:2:0",
                "-strip",
                str(path)
            ])
        kept_files += 1
        total_bytes += path.stat().st_size

    print(f"Optimized textures: kept {kept_files}, removed {removed_files} unused, total size = {total_bytes / (1024*1024):.2f} MB")


def main():
    baseq3 = pathlib.Path(sys.argv[1]).resolve()
    used_materials, world_collision_tris = repair_render_and_collect_collision(baseq3)
    all_collision_tris = repair_physics(baseq3, world_collision_tris)
    repair_map_and_shaders(baseq3, all_collision_tris)
    optimize_textures(baseq3, used_materials)


if __name__ == "__main__":
    main()
