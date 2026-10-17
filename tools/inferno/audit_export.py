"""Audit Source 2 glTF exports before any Quake map is advertised as usable.

Python standard library only. Does not rewrite or approximate source geometry.
Usage: python3 tools/inferno/audit_export.py exported reports/export-audit.json reports/export.log
"""
import json
import pathlib
import re
import sys
from urllib.parse import unquote, urlparse


def local_uri(document, uri, export_root):
    if uri.startswith("data:"):
        return None
    if urlparse(uri).scheme or uri.startswith(("/", "\\\\")):
        raise ValueError("External or absolute asset URI: " + uri)
    root = export_root.resolve()
    target = (document.parent / unquote(uri)).resolve()
    if not target.is_relative_to(root):
        raise ValueError("Asset URI escapes export directory: " + uri)
    return target


def audit_document(path, export_root):
    data = json.loads(path.read_text(encoding="utf-8"))
    errors, missing, triangles = [], [], 0
    if data.get("asset", {}).get("version") != "2.0":
        errors.append("Expected glTF 2.0")
    buffers = data.get("buffers", [])
    for buffer in buffers:
        uri = buffer.get("uri")
        if uri is None:
            errors.append("JSON glTF buffer has no URI")
            continue
        target = local_uri(path, uri, export_root)
        if target is not None:
            if not target.is_file():
                missing.append(uri)
            elif target.stat().st_size < buffer.get("byteLength", 0):
                errors.append("Truncated buffer: " + uri)
    views = data.get("bufferViews", [])
    for view in views:
        index = view.get("buffer", -1)
        if not 0 <= index < len(buffers):
            errors.append("Invalid buffer view buffer index")
        elif view.get("byteOffset", 0) + view.get("byteLength", 0) > buffers[index].get("byteLength", 0):
            errors.append("Buffer view exceeds buffer size")
    accessors = data.get("accessors", [])
    component_bytes = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}
    components = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT2": 4, "MAT3": 9, "MAT4": 16}
    for accessor in accessors:
        view_index = accessor.get("bufferView")
        if view_index is None:
            # Sparse or all-zero accessors are legal glTF; the converter must handle them explicitly.
            continue
        if not 0 <= view_index < len(views):
            errors.append("Invalid accessor buffer view index")
            continue
        size = component_bytes.get(accessor.get("componentType"))
        count = components.get(accessor.get("type"))
        if size is None or count is None or accessor.get("count", 0) < 0:
            errors.append("Invalid accessor component type or count")
            continue
        kind = accessor["type"]
        element_size = size * count
        if kind.startswith("MAT"):
            dimension = int(kind[-1])
            element_size = ((dimension * size + 3) // 4 * 4) * dimension
        view = views[view_index]
        stride = view.get("byteStride", element_size)
        total = accessor.get("byteOffset", 0) + max(0, accessor.get("count", 0) - 1) * stride
        if accessor.get("count", 0):
            total += element_size
        if stride < element_size or total > view.get("byteLength", 0):
            errors.append("Accessor exceeds its buffer view")
    for mesh in data.get("meshes", []):
        for primitive in mesh.get("primitives", []):
            position = primitive.get("attributes", {}).get("POSITION", -1)
            if not 0 <= position < len(accessors):
                errors.append("Primitive has no valid POSITION accessor")
                continue
            indices = primitive.get("indices", position)
            if not 0 <= indices < len(accessors):
                errors.append("Invalid index accessor")
                continue
            count = accessors[indices].get("count", 0)
            mode = primitive.get("mode", 4)
            if mode == 4:
                if count % 3:
                    errors.append("Triangle list count is not divisible by three")
                triangles += count // 3
            elif mode in (5, 6):
                triangles += max(0, count - 2)
    for image in data.get("images", []):
        uri = image.get("uri")
        if uri:
            target = local_uri(path, uri, export_root)
            if target is not None and not target.is_file():
                missing.append(uri)
        elif not 0 <= image.get("bufferView", -1) < len(views):
            errors.append("Image has no valid URI or buffer view")
    if not triangles:
        errors.append("No renderable triangles")
    return {
        "file": str(path),
        "physics": "_physics" in path.stem.lower(),
        "meshes": len(data.get("meshes", [])),
        "nodes": len(data.get("nodes", [])),
        "triangles": triangles,
        "materials": len(data.get("materials", [])),
        "images": len(data.get("images", [])),
        "required_extensions": data.get("extensionsRequired", []),
        "missing_files": sorted(set(missing)),
        "errors": errors,
    }


def main():
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    root, output, log_path = map(pathlib.Path, sys.argv[1:])
    documents = []
    for path in sorted(root.rglob("*.gltf")):
        try:
            documents.append(audit_document(path, root))
        except (ValueError, OSError, TypeError, KeyError) as exc:
            documents.append({"file": str(path), "errors": [str(exc)]})
    log = log_path.read_text(encoding="utf-8", errors="replace") if log_path.exists() else ""
    unresolved = sorted(set(re.findall(r'Failed to load "([^"]+)"', log)))
    non_visual = [name for name in unresolved if name.startswith(
        ("materials/tools/", "materials/tools_", "materials/editor/")
    )]
    required = [name for name in unresolved if name not in non_visual]
    valid = bool(documents) and not required and all(
        not doc.get("errors") and not doc.get("missing_files") for doc in documents
    )
    result = {
        "documents": documents,
        "unresolved_source_assets": required,
        "missing_editor_materials": non_visual,
        "export_integrity_passed": valid,
        "ready_for_quake": False,
        "remaining": "Wingman selection, BSP46 conversion, collision, lighting and multiplayer validation",
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))
    return 0 if valid else 1


if __name__ == "__main__":
    raise SystemExit(main())
