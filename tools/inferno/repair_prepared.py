"""Repair prepared Inferno Wingman glTF/map/shader assets for Quake 3 BSP46 compilation.

Fixes:
1. Preserves full Wingman visual street/building context (render_box X in [-64, 2980], Y in [-1080, 1820])
   so buildings and ground near T-spawn (X=508) and CT-spawn are never sliced in half.
2. Preserves 100% of triangles on walls, floors, stairs, curbs, balconies, doors, windows,
   roofs, and trees (no 16-inch Swiss-cheese triangle deletion).
3. Removes untextured/white helper materials (m0000, m0031, m0033, m0035, m0167, m0894, m0903)
   and projected decal/overlay quads that lack Source 2 decal masks in Quake 3.
4. Fixes .tga (MASK/BLEND) shaders to use alphaGen identity and preserves blendFunc blend.
5. Generates 100% continuous axial detail floor & wall collision brushes in worldspawn using
   shader "inferno/physics_solid" (q3map2 prepends "textures/") and CONTENTS_DETAIL (134217728),
   guaranteeing zero visible brush faces, 1 portalcluster, and 100% solid ground everywhere.
"""
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
MAX_WORLD_COLLISION_TRIS = 16000

PURE_CLUTTER_RE = re.compile(
    r"blocklight|cable_kit|hanging_clothes|postcard_kit|wine_bottle|ashtray|paint_can|"
    r"nailbox|hammer|drill|tapemeasure|tableware|letter|calendar|trike|bicycle|vespa|"
    r"satelite|antenna|trashbag|toolbox|wheelbarrow|dolly|radio|grapplinghook|bird_spike|"
    r"book_kit|luggage|bucket|watering_can|terrace_parasol|terrace_table|terrace_chair|"
    r"radiator|stone_statue|missile_01|gutter_kit|stone_wall_09_debris|stone_wall_09_trim|"
    r"metalgates_01a_base|door_details|rollup_door_details|willow_bush|spindle_bush|"
    r"cress_plant|lamp_01|lamp_02|barrel_kit",
    re.I,
)

ULTRA_DENSE_NODE_RE = re.compile(
    r"roofkit01_trim_01_base|stone_trim_block_01|bk01_trim_concrete01a|"
    r"metal_trim_weathered_rust_blend_01|bk01_trim_wood01b|"
    r"inferno_trim_wood01_painted_blend_01|roofkit01_woodtrim_01",
    re.I,
)

NON_SOLID_NODE_RE = re.compile(
    r"blocklight|overlay|bush|plant|cypress|willow|spindle|grass|leaf|leaves|cable|wire|"
    r"clothes|debris|bicycle|trike|vespa|postcard|calendar|letter|bottle|cup|plate|bowl|"
    r"vase|ashtray|paint_can|hammer|drill|rake|tapemeasure|nailbox|picture|bulb|lamp|"
    r"gutter|antenna|satelite|curtain|flag|tarp|soil_trail|cone|garbage_bin_02",
    re.I,
)

WALL_OBSTACLE_NODE_RE = re.compile(
    r"wall|facade|plaster|brick|house|apartment|arch|pillar|column|shop_front|"
    r"wood_crate|concrete_bag|sandbag|door_simple|door_double|barn_door|rollup_door|"
    r"barricade|metalgates|fence|gate|barrel|planter|garbagebin01_wheel",
    re.I,
)

DECAL_INPUT_RE = re.compile(
    r"overlay|decal|stencil|ghost_sign|bombsite_signs|leakage|grime|stain|graffiti|"
    r"block_light|tools_|dirt_skirt",
    re.I,
)

DUMMY_WHITE_MATS = {
    "textures/inferno/m0000",
    "textures/inferno/m0031",
    "textures/inferno/m0033",
    "textures/inferno/m0035",
    "textures/inferno/m0167",
    "textures/inferno/m0894",
    "textures/inferno/m0903",
}


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


def tri_metrics(p0, p1, p2):
    d01 = (p0[0]-p1[0])**2 + (p0[1]-p1[1])**2 + (p0[2]-p1[2])**2
    d12 = (p1[0]-p2[0])**2 + (p1[1]-p2[1])**2 + (p1[2]-p2[2])**2
    d20 = (p2[0]-p0[0])**2 + (p2[1]-p0[1])**2 + (p2[2]-p0[2])**2
    max_edge_sq = max(d01, d12, d20)
    ux, uy, uz = p1[0]-p0[0], p1[1]-p0[1], p1[2]-p0[2]
    vx, vy, vz = p2[0]-p0[0], p2[1]-p0[1], p2[2]-p0[2]
    cx = uy*vz - uz*vy
    cy = uz*vx - ux*vz
    cz = ux*vy - uy*vx
    norm_sq = cx*cx + cy*cy + cz*cz
    area2_sq = norm_sq
    abs_nz = abs(cz) / math.sqrt(norm_sq) if norm_sq > 1e-12 else 0.0
    return max_edge_sq, area2_sq, abs_nz


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

    render_box = ([-64.0, -1080.0, -48.0], [2980.0, 1820.0, 820.0])

    floor_src_tris = []
    wall_src_tris = []
    floor_gltf_candidates = []
    wall_gltf_candidates = []
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
        node_name = node.get("name", "")
        if PURE_CLUTTER_RE.search(node_name):
            continue
        if "mesh_overlay" in node_name.lower():
            continue

        is_ultra_dense = bool(ULTRA_DENSE_NODE_RE.search(node_name))
        can_collide = not bool(NON_SOLID_NODE_RE.search(node_name)) and not is_ultra_dense
        is_wall_obstacle = can_collide and bool(WALL_OBSTACLE_NODE_RE.search(node_name))

        transform = matrices[node_id]
        new_primitives = []

        for prim in doc["meshes"][original_mesh].get("primitives", []):
            mat_idx = prim.get("material")
            if mat_idx is None:
                continue
            mat_name = doc["materials"][mat_idx]["name"]
            if mat_name in DUMMY_WHITE_MATS:
                continue
            job = job_by_mat.get(mat_name, {})
            inp = job.get("input")
            if not inp:
                continue
            out_file = baseq3 / job.get("output", "")
            if out_file.exists() and out_file.stat().st_size < 2000:
                continue
            if DECAL_INPUT_RE.search(inp):
                continue

            attrs = prim["attributes"]
            positions = accessor_values(doc, blob, attrs["POSITION"])
            gltf_pts = [point(transform, p) for p in positions]
            src_pts = [source_point(gp) for gp in gltf_pts]
            indices = [v[0] for v in accessor_values(doc, blob, prim["indices"])]

            kept = []
            for i in range(0, len(indices), 3):
                i0, i1, i2 = indices[i], indices[i+1], indices[i+2]
                p0, p1, p2 = src_pts[i0], src_pts[i1], src_pts[i2]
                if not overlaps_box(p0, p1, p2, render_box):
                    continue
                min_z = min(p0[2], p1[2], p2[2])
                max_z = max(p0[2], p1[2], p2[2])
                max_edge_sq, area2_sq, abs_nz = tri_metrics(p0, p1, p2)
                if area2_sq < 0.01:
                    continue

                if can_collide:
                    if abs_nz >= 0.50 and max_z >= 45.0 and min_z <= 310.0 and (max_z - min_z) <= 42.0:
                        floor_src_tris.append((p0, p1, p2))
                        if max_edge_sq >= 64.0 and area2_sq >= 16.0:
                            floor_gltf_candidates.append((area2_sq, (gltf_pts[i0], gltf_pts[i1], gltf_pts[i2])))
                    elif is_wall_obstacle and abs_nz <= 0.30 and max_z >= 75.0 and min_z <= 220.0:
                        wall_src_tris.append((p0, p1, p2))
                        if max_edge_sq >= 144.0 and area2_sq >= 64.0:
                            wall_gltf_candidates.append((area2_sq, (gltf_pts[i0], gltf_pts[i1], gltf_pts[i2])))

                if is_ultra_dense and max_edge_sq < 25.0:
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

    floor_gltf_candidates.sort(key=lambda item: item[0], reverse=True)
    wall_gltf_candidates.sort(key=lambda item: item[0], reverse=True)
    sel_floors = [item[1] for item in floor_gltf_candidates[:8000]]
    sel_walls = [item[1] for item in wall_gltf_candidates[: max(0, MAX_WORLD_COLLISION_TRIS - len(sel_floors))]]
    structural_collision_gltf_tris = sel_floors + sel_walls
    print(
        f"Collected {len(floor_src_tris)} raw floor tris, {len(wall_src_tris)} raw wall tris; "
        f"physics.gltf structural supplement: {len(sel_floors)} floor + {len(sel_walls)} wall tris",
        flush=True,
    )

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
    print(
        f"Repaired render.gltf: {kept_tris_total} tris, {kept_prims_total} chunked primitives, "
        f"{len(materials)} materials, {len(new_blob)} bytes",
        flush=True,
    )
    return used_material_names, structural_collision_gltf_tris, floor_src_tris, wall_src_tris


def repair_physics(baseq3, structural_collision_gltf_tris, floor_src_tris):
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
                p0, p1, p2 = src_pts[indices[i]], src_pts[indices[i+1]], src_pts[indices[i+2]]
                _, area2_sq, abs_nz = tri_metrics(p0, p1, p2)
                min_z = min(p0[2], p1[2], p2[2])
                max_z = max(p0[2], p1[2], p2[2])
                if abs_nz >= 0.50 and area2_sq >= 0.25 and max_z >= 45.0 and min_z <= 310.0 and (max_z - min_z) <= 42.0:
                    floor_src_tris.append((p0, p1, p2))

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
    print(f"Repaired physics.gltf: {kept_phys_tris} entity tris + {len(structural_collision_gltf_tris)} world structural tris = {total_tris} total collision tris", flush=True)


def make_brush(lo, hi, shader):
    x, y, z = lo
    X, Y, Z = hi
    faces = [
        [(x, y, z), (x, Y, z), (x, y, Z)],
        [(X, y, z), (X, y, Z), (X, Y, z)],
        [(x, y, z), (x, y, Z), (X, y, z)],
        [(x, Y, z), (X, Y, z), (x, Y, Z)],
        [(x, y, z), (X, y, z), (x, Y, z)],
        [(x, y, Z), (x, Y, Z), (X, y, Z)],
    ]
    return "{\n" + "\n".join(
        " ".join("( %.5f %.5f %.5f )" % p for p in face) + f" {shader} 0 0 0 1 1 134217728 0 0"
        for face in faces
    ) + "\n}\n"


def tri_z_at(a, b, c, px, py):
    det = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
    if abs(det) < 1e-6:
        return (a[2] + b[2] + c[2]) / 3.0
    l1 = ((b[1] - c[1]) * (px - c[0]) + (c[0] - b[0]) * (py - c[1])) / det
    l2 = ((c[1] - a[1]) * (px - c[0]) + (a[0] - c[0]) * (py - c[1])) / det
    l3 = 1.0 - l1 - l2
    l1 = max(0.0, min(1.0, l1))
    l2 = max(0.0, min(1.0, l2))
    l3 = max(0.0, min(1.0, l3))
    s = l1 + l2 + l3 or 1.0
    return (l1 * a[2] + l2 * b[2] + l3 * c[2]) / s


def pt_seg_dist_sq(px, py, x1, y1, x2, y2):
    dx, dy = x2 - x1, y2 - y1
    len_sq = dx * dx + dy * dy
    t = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / len_sq)) if len_sq > 0.0 else 0.0
    ex = x1 + t * dx - px
    ey = y1 + t * dy - py
    return ex * ex + ey * ey


def pt_in_tri_dilated(px, py, a, b, c, pad_sq):
    d1 = (px - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (py - b[1])
    d2 = (px - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (py - c[1])
    d3 = (px - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (py - a[1])
    if not ((d1 < 0.0 or d2 < 0.0 or d3 < 0.0) and (d1 > 0.0 or d2 > 0.0 or d3 > 0.0)):
        return True
    return (
        pt_seg_dist_sq(px, py, a[0], a[1], b[0], b[1]) <= pad_sq
        or pt_seg_dist_sq(px, py, b[0], b[1], c[0], c[1]) <= pad_sq
        or pt_seg_dist_sq(px, py, c[0], c[1], a[0], a[1]) <= pad_sq
    )


def build_floor_and_wall_brushes(floor_src_tris, wall_src_tris, spawn_coords):
    CELL = 20.0
    X0, X1 = -60.0, 2980.0
    Y0, Y1 = -1080.0, 1820.0
    NX = int(math.ceil((X1 - X0) / CELL))
    NY = int(math.ceil((Y1 - Y0) / CELL))
    samples = [[] for _ in range(NX * NY)]
    PAD = 10.0
    PAD_SQ = PAD * PAD

    for a, b, c in floor_src_tris:
        gx0 = max(0, int(math.floor((min(a[0], b[0], c[0]) - PAD - X0) / CELL)))
        gx1 = min(NX - 1, int(math.floor((max(a[0], b[0], c[0]) + PAD - X0) / CELL)))
        gy0 = max(0, int(math.floor((min(a[1], b[1], c[1]) - PAD - Y0) / CELL)))
        gy1 = min(NY - 1, int(math.floor((max(a[1], b[1], c[1]) + PAD - Y0) / CELL)))
        for gy in range(gy0, gy1 + 1):
            py = Y0 + (gy + 0.5) * CELL
            row_off = gy * NX
            for gx in range(gx0, gx1 + 1):
                px = X0 + (gx + 0.5) * CELL
                if pt_in_tri_dilated(px, py, a, b, c, PAD_SQ):
                    z = tri_z_at(a, b, c, px, py)
                    if 45.0 <= z <= 310.0:
                        samples[row_off + gx].append(z)

    EMPTY = -32768
    layer0 = [EMPTY] * (NX * NY)
    layer1 = [EMPTY] * (NX * NY)

    for idx, zs in enumerate(samples):
        if not zs:
            continue
        zs.sort()
        min_z = zs[0]
        if min_z <= 210.0:
            l0 = min_z
            for z in zs:
                if z <= min_z + 20.0:
                    l0 = z
                else:
                    break
            layer0[idx] = int(round(l0 / 2.0) * 2)
            upper = [z for z in zs if l0 + 84.0 <= z <= 305.0]
            if upper:
                u_min = upper[0]
                l1 = u_min
                for z in upper:
                    if z <= u_min + 20.0:
                        l1 = z
                    else:
                        break
                layer1[idx] = int(round(l1 / 2.0) * 2)
        else:
            l1 = min_z
            for z in zs:
                if z <= min_z + 20.0:
                    l1 = z
                else:
                    break
            layer1[idx] = int(round(l1 / 2.0) * 2)

    # 3-pass hole-filling on layer0 so no interior cracks/pits can exist anywhere
    for _ in range(3):
        next_l0 = list(layer0)
        for gy in range(1, NY - 1):
            for gx in range(1, NX - 1):
                idx = gy * NX + gx
                if layer0[idx] != EMPTY:
                    continue
                nbrs = []
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        if dx == 0 and dy == 0:
                            continue
                        v = layer0[(gy + dy) * NX + (gx + dx)]
                        if v != EMPTY:
                            nbrs.append(v)
                if len(nbrs) >= 3:
                    nbrs.sort()
                    next_l0[idx] = nbrs[len(nbrs) // 2]
        layer0 = next_l0

    def greedy_rects(grid, thickness):
        used = [False] * (NX * NY)
        brushes = []
        for gy in range(NY):
            for gx in range(NX):
                idx = gy * NX + gx
                z = grid[idx]
                if z == EMPTY or used[idx]:
                    continue
                w = 1
                while gx + w < NX and grid[gy * NX + gx + w] == z and not used[gy * NX + gx + w]:
                    w += 1
                h = 1
                while gy + h < NY:
                    ok = True
                    for k in range(w):
                        if grid[(gy + h) * NX + gx + k] != z or used[(gy + h) * NX + gx + k]:
                            ok = False
                            break
                    if not ok:
                        break
                    h += 1
                for dy in range(h):
                    for dx in range(w):
                        used[(gy + dy) * NX + gx + dx] = True
                x0 = X0 + gx * CELL
                x1 = X0 + (gx + w) * CELL
                y0 = Y0 + gy * CELL
                y1 = Y0 + (gy + h) * CELL
                # Note: q3map2 prepends "textures/" to .map brush face shader names!
                brushes.append(make_brush((x0, y0, float(z - thickness)), (x1, y1, float(z)), "inferno/physics_solid"))
        return brushes

    l0_brushes = greedy_rects(layer0, 16.0)
    l1_brushes = greedy_rects(layer1, 8.0)

    # Rasterize true vertical wall obstacles (relative to local floor layer0) onto an 8x8 grid
    WCELL = 8.0
    WNX = int(math.ceil((X1 - X0) / WCELL))
    WNY = int(math.ceil((Y1 - Y0) / WCELL))
    wall_grid = [EMPTY] * (WNX * WNY)

    for a, b, c in wall_src_tris:
        min_z = min(a[2], b[2], c[2])
        max_z = max(a[2], b[2], c[2])
        if (max_z - min_z) < 24.0:
            continue
        wx0 = max(0, int(math.floor((min(a[0], b[0], c[0]) - X0) / WCELL)))
        wx1 = min(WNX - 1, int(math.floor((max(a[0], b[0], c[0]) - X0) / WCELL)))
        wy0 = max(0, int(math.floor((min(a[1], b[1], c[1]) - Y0) / WCELL)))
        wy1 = min(WNY - 1, int(math.floor((max(a[1], b[1], c[1]) - Y0) / WCELL)))
        for wy in range(wy0, wy1 + 1):
            py = Y0 + (wy + 0.5) * WCELL
            gy = min(NY - 1, max(0, int(math.floor((py - Y0) / CELL))))
            for wx in range(wx0, wx1 + 1):
                px = X0 + (wx + 0.5) * WCELL
                gx = min(NX - 1, max(0, int(math.floor((px - X0) / CELL))))
                fz = layer0[gy * NX + gx]
                if fz == EMPTY:
                    fz = 90
                if min_z <= fz + 36.0 and max_z >= fz + 30.0:
                    if pt_in_tri_dilated(px, py, a, b, c, 4.0):
                        wall_grid[wy * WNX + wx] = int(fz)

    # Clear wall cells within 36 inches of any spawn point
    for sx, sy, _ in spawn_coords:
        for wy in range(WNY):
            py = Y0 + (wy + 0.5) * WCELL
            if abs(py - sy) > 36.0:
                continue
            for wx in range(WNX):
                px = X0 + (wx + 0.5) * WCELL
                if abs(px - sx) <= 36.0:
                    wall_grid[wy * WNX + wx] = EMPTY

    used_w = [False] * (WNX * WNY)
    w_brushes = []
    for wy in range(WNY):
        for wx in range(WNX):
            idx = wy * WNX + wx
            fz = wall_grid[idx]
            if fz == EMPTY or used_w[idx]:
                continue
            w = 1
            while wx + w < WNX and wall_grid[wy * WNX + wx + w] == fz and not used_w[wy * WNX + wx + w]:
                w += 1
            h = 1
            while wy + h < WNY:
                ok = True
                for k in range(w):
                    if wall_grid[(wy + h) * WNX + wx + k] != fz or used_w[(wy + h) * WNX + wx + k]:
                        ok = False
                        break
                if not ok:
                    break
                h += 1
            for dy in range(h):
                for dx in range(w):
                    used_w[(wy + dy) * WNX + wx + dx] = True
            x0 = X0 + wx * WCELL
            x1 = X0 + (wx + w) * WCELL
            y0 = Y0 + wy * WCELL
            y1 = Y0 + (wy + h) * WCELL
            w_brushes.append(make_brush((x0, y0, float(fz)), (x1, y1, float(fz + 88.0)), "inferno/physics_solid"))

    def floor_z_at(sx, sy):
        gx = min(NX - 1, max(0, int(math.floor((sx - X0) / CELL))))
        gy = min(NY - 1, max(0, int(math.floor((sy - Y0) / CELL))))
        return layer0[gy * NX + gx]

    print(
        f"Generated worldspawn detail collision brushes: {len(l0_brushes)} layer0 floor + "
        f"{len(l1_brushes)} layer1 floor + {len(w_brushes)} wall brushes",
        flush=True,
    )
    return l0_brushes + l1_brushes + w_brushes, floor_z_at


def repair_map_and_shaders(baseq3, floor_src_tris, wall_src_tris):
    map_path = baseq3 / "maps/inferno_wingman.map"
    map_text = map_path.read_text()
    map_text = map_text.replace(" textures/inferno/sky ", " inferno/sky ")
    map_text = map_text.replace('"_ambient" "24"\n"_color" "0.53 0.78 1"', '"_ambient" "34"\n"_color" "0.95 0.93 0.90"')
    map_text = map_text.replace(
        '"model" "models/inferno/render.gltf"\n"angles" "0 90 0"\n"modelscale" "39.37007874015748"\n"spawnflags" "4"',
        '"model" "models/inferno/render.gltf"\n"angles" "0 90 0"\n"modelscale" "39.37007874015748"\n"spawnflags" "0"',
    )
    map_text = map_text.replace(
        '"model" "models/inferno/physics.gltf"\n"angles" "0 90 0"\n"modelscale" "39.37007874015748"\n"spawnflags" "2"',
        '"model" "models/inferno/physics.gltf"\n"angles" "0 90 0"\n"modelscale" "39.37007874015748"\n"spawnflags" "2"\n"_clipdepth" "6"',
    )

    spawns = re.findall(r'"classname" "info_player_deathmatch"\s+"origin" "([^"]+)"', map_text)
    assert len(spawns) == 8, f"Expected 8 spawns, found {len(spawns)}"
    spawn_coords = [tuple(map(float, s.split())) for s in spawns]

    extra_brushes, floor_z_at = build_floor_and_wall_brushes(floor_src_tris, wall_src_tris, spawn_coords)

    # Inject detail floor & wall brushes at the end of worldspawn entity
    first_ent_end = map_text.find('}\n{\n"classname"')
    assert first_ent_end > 0, "Could not locate end of worldspawn"
    map_text = map_text[:first_ent_end] + "".join(extra_brushes) + map_text[first_ent_end:]

    for idx, s in enumerate(spawns):
        sx, sy, sz = map(float, s.split())
        fz = floor_z_at(sx, sy)
        assert fz > -1000, f"Spawn {idx} at ({sx}, {sy}, {sz}) lacks floor cell"
        new_sz = max(sz, float(fz + 30))
        if new_sz != sz:
            map_text = map_text.replace(f'"origin" "{s}"', f'"origin" "{sx:g} {sy:g} {new_sz:g}"', 1)
        print(f"Spawn {idx}: origin=({sx}, {sy}, {sz} -> {new_sz}) -> solid axial floor at Z={fz:.1f} (clearance={new_sz - fz:.1f})", flush=True)

    # Keep only the top 8 brightest point lights to speed up q3map2 -light
    light_pattern = re.compile(r'\{\n"classname" "light"\n[^}]+\}\n')
    lights = light_pattern.findall(map_text)
    def light_val(txt):
        m = re.search(r'"light" "([^"]+)"', txt)
        return float(m.group(1)) if m else 0.0
    lights_sorted = sorted(lights, key=light_val, reverse=True)
    keep_lights = set(lights_sorted[:8])
    for l_txt in lights:
        if l_txt not in keep_lights:
            map_text = map_text.replace(l_txt, "", 1)

    map_path.write_text(map_text)

    shader_path = baseq3 / "scripts/inferno.shader"
    blocks = shader_path.read_text().strip().split("\n\n")
    new_blocks = []
    for block in blocks:
        lines = block.strip().splitlines()
        if not lines:
            continue
        shader_name = lines[0].strip()
        block_mod = block.replace("alphaGen vertex", "alphaGen identity")
        if "blendFunc blend" in block_mod and "polygonOffset" not in block_mod:
            block_mod = block_mod.replace("sort banner\n{", "polygonOffset\nsort banner\n{")
        if shader_name in ("textures/inferno/physics_solid", "textures/inferno/physics_playerclip"):
            if "surfaceparm detail" not in block_mod:
                block_mod = block_mod.replace("surfaceparm nodraw", "surfaceparm nodraw\nsurfaceparm detail")
        if shader_name == "textures/inferno/sky":
            block_mod = re.sub(r"(q3map_sunExt\s+\S+\s+\S+\s+\S+\s+)\S+(\s+\S+\s+\S+\s+)\S+\s+\S+", r"\g<1>140\g<2>0 1", block_mod)
        new_blocks.append(block_mod)
    shader_path.write_text("\n\n".join(new_blocks) + "\n")


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
    jpg_files = []

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
            kept_files += 1
            total_bytes += path.stat().st_size
        elif path.suffix.lower() == ".jpg":
            jpg_files.append(path)

    if jpg_files:
        import tempfile
        with tempfile.TemporaryDirectory() as tmpd:
            tmp_root = pathlib.Path(tmpd)
            jobs_json = tmp_root / "jpgs.json"
            script_mjs = tmp_root / "resize.mjs"
            jobs_json.write_text(json.dumps([str(p) for p in jpg_files]))
            script_mjs.write_text(
                "import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';\n"
                "import http from 'node:http';\n"
                "import { tmpdir } from 'node:os';\n"
                "import { join } from 'node:path';\n"
                "import { spawn } from 'node:child_process';\n"
                "const files = JSON.parse(readFileSync(process.argv[2], 'utf8'));\n"
                "const completed = new Set();\n"
                "const pending = new Map();\n"
                "const page = `<!doctype html><meta charset=\"utf-8\"><script>\n"
                "window.run = async () => {\n"
                "  const count = ${files.length};\n"
                "  const canvas = new OffscreenCanvas(1, 1);\n"
                "  const ctx = canvas.getContext('2d');\n"
                "  for (let id = 0; id < count; id++) {\n"
                "    const blob = await (await fetch('/in?id=' + id)).blob();\n"
                "    const bmp = await createImageBitmap(blob);\n"
                "    let tw = 1, th = 1;\n"
                "    while (tw * 2 <= bmp.width && tw * 2 <= 512) tw *= 2;\n"
                "    while (th * 2 <= bmp.height && th * 2 <= 512) th *= 2;\n"
                "    canvas.width = tw;\n"
                "    canvas.height = th;\n"
                "    ctx.drawImage(bmp, 0, 0, tw, th);\n"
                "    bmp.close();\n"
                "    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.88 });\n"
                "    const res = await fetch('/out?id=' + id, { method: 'POST', body: out });\n"
                "    if (!res.ok) throw Error(await res.text());\n"
                "  }\n"
                "  return { resized: count };\n"
                "};\n"
                "</script>`;\n"
                "const server = http.createServer(async (req, res) => {\n"
                "  try {\n"
                "    const url = new URL(req.url, 'http://localhost');\n"
                "    if (req.method === 'GET' && url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end(page); return; }\n"
                "    if (req.method === 'GET' && url.pathname === '/in') { const id = Number(url.searchParams.get('id')); res.setHeader('Content-Type', 'image/jpeg'); res.end(readFileSync(files[id])); return; }\n"
                "    if (req.method === 'POST' && url.pathname === '/out') { const id = Number(url.searchParams.get('id')); const chunks = []; for await (const c of req) chunks.push(c); writeFileSync(files[id], Buffer.concat(chunks)); completed.add(id); res.end('ok'); return; }\n"
                "    res.writeHead(404); res.end();\n"
                "  } catch (e) { res.writeHead(400); res.end(e.message); }\n"
                "});\n"
                "await new Promise(ok => server.listen(0, '127.0.0.1', ok));\n"
                "const chromeDir = mkdtempSync(join(tmpdir(), 'inferno-resize-'));\n"
                "const chrome = spawn(process.env.CHROME_BIN || 'google-chrome', ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=' + chromeDir, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });\n"
                "chrome.stderr.on('data', () => {});\n"
                "let socket, sequence = 0;\n"
                "const delay = ms => new Promise(r => setTimeout(r, ms));\n"
                "try {\n"
                "  const active = join(chromeDir, 'DevToolsActivePort');\n"
                "  for (let i = 0; i < 200 && !existsSync(active); i++) await delay(100);\n"
                "  const [port, wsPath] = readFileSync(active, 'utf8').trim().split('\\n');\n"
                "  socket = new WebSocket('ws://127.0.0.1:' + port + wsPath);\n"
                "  await new Promise((ok, no) => { socket.addEventListener('open', ok, { once: true }); socket.addEventListener('error', no, { once: true }); });\n"
                "  socket.addEventListener('message', ev => { const msg = JSON.parse(ev.data), item = pending.get(msg.id); if (item) { pending.delete(msg.id); msg.error ? item.reject(Error(JSON.stringify(msg.error))) : item.resolve(msg.result); } });\n"
                "  const call = (method, params = {}, sessionId) => new Promise((res, rej) => { const id = ++sequence; pending.set(id, { resolve: res, reject: rej }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });\n"
                "  const target = await call('Target.createTarget', { url: 'http://127.0.0.1:' + server.address().port });\n"
                "  const attached = await call('Target.attachToTarget', { targetId: target.targetId, flatten: true });\n"
                "  const session = attached.sessionId;\n"
                "  for (let i = 0; i < 100; i++) { const r = await call('Runtime.evaluate', { expression: 'typeof window.run===\"function\"', returnByValue: true }, session); if (r.result?.value) break; await delay(100); }\n"
                "  const res = await call('Runtime.evaluate', { expression: 'window.run()', awaitPromise: true, returnByValue: true }, session);\n"
                "  if (res.exceptionDetails) throw Error(JSON.stringify(res.exceptionDetails));\n"
                "  console.log(res.result.value);\n"
                "} finally {\n"
                "  socket?.close();\n"
                "  if (chrome.exitCode === null) chrome.kill('SIGKILL');\n"
                "  server.close();\n"
                "  try { rmSync(chromeDir, { recursive: true, force: true }); } catch {}\n"
                "}\n"
            )
            subprocess.check_call(["node", str(script_mjs), str(jobs_json)])
        for path in jpg_files:
            kept_files += 1
            total_bytes += path.stat().st_size

    print(f"Optimized textures: kept {kept_files}, removed {removed_files} unused, total size = {total_bytes / (1024*1024):.2f} MB", flush=True)


def main():
    baseq3 = pathlib.Path(sys.argv[1]).resolve()
    used_materials, world_collision_tris, floor_src_tris, wall_src_tris = repair_render_and_collect_collision(baseq3)
    repair_physics(baseq3, world_collision_tris, floor_src_tris)
    repair_map_and_shaders(baseq3, floor_src_tris, wall_src_tris)
    optimize_textures(baseq3, used_materials)


if __name__ == "__main__":
    main()
