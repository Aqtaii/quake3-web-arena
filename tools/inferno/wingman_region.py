"""Derive Wingman reachability from original navigation and original blocker models."""
import itertools
import json
import math
import pathlib
import sys


IDENTITY = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]


def multiply(a, b):
    return [sum(a[k*4+r]*b[c*4+k] for k in range(4)) for c in range(4) for r in range(4)]


def matrix(node):
    if "matrix" in node:
        return node["matrix"]
    x,y,z,w = node.get("rotation", [0,0,0,1])
    sx,sy,sz = node.get("scale", [1,1,1])
    tx,ty,tz = node.get("translation", [0,0,0])
    return [(1-2*(y*y+z*z))*sx, 2*(x*y+z*w)*sx, 2*(x*z-y*w)*sx, 0,
            2*(x*y-z*w)*sy, (1-2*(x*x+z*z))*sy, 2*(y*z+x*w)*sy, 0,
            2*(x*z+y*w)*sz, 2*(y*z-x*w)*sz, (1-2*(x*x+y*y))*sz, 0, tx,ty,tz,1]


def point(m, p):
    return [sum(m[k*4+r]*p[k] for k in range(3))+m[12+r] for r in range(3)]


def source_point(p):
    # Exact inverse of Source 2 Viewer 20.1's baked basis/units.
    return [p[2]/.0254, p[0]/.0254, p[1]/.0254]


def node_bounds(data):
    result = {}
    nodes, meshes, accessors = data.get("nodes", []), data.get("meshes", []), data.get("accessors", [])
    def walk(index, parent, ancestry):
        if index in ancestry:
            raise ValueError("Cycle in glTF scene graph")
        node=nodes[index]
        transform=multiply(parent, matrix(node))
        points=[]
        if "mesh" in node:
            for primitive in meshes[node["mesh"]].get("primitives", []):
                accessor=accessors[primitive["attributes"]["POSITION"]]
                if "min" not in accessor or "max" not in accessor:
                    raise ValueError("Geometry accessor has no bounds")
                for corner in itertools.product(*zip(accessor["min"],accessor["max"])):
                    points.append(source_point(point(transform,corner)))
        if points:
            result[index]=[[min(p[i] for p in points) for i in range(3)],
                           [max(p[i] for p in points) for i in range(3)]]
        for child in node.get("children", []):
            walk(child,transform,ancestry|{index})
    scene=data.get("scene",0)
    for root in data["scenes"][scene]["nodes"]:
        walk(root,IDENTITY,set())
    return result


def bounds(points):
    return [[min(p[i] for p in points) for i in range(3)],
            [max(p[i] for p in points) for i in range(3)]]


def overlap(a,b):
    return all(a[1][i]>=b[0][i]-.1 and b[1][i]>=a[0][i]-.1 for i in range(3))


def contains_xy(p, corners):
    signs=[]
    for a,b in zip(corners,corners[1:]+corners[:1]):
        cross=(b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0])
        if abs(cross)>.01:
            signs.append(cross>0)
    return not signs or all(s==signs[0] for s in signs)


def select_region(nav, source, folder):
    blockers=[]
    for entity in source["entities"]:
        if entity["classname"]!="func_nav_blocker":
            continue
        if max(abs(float(a)) for a in entity.get("angles",[0,0,0]))>.01 or entity.get("scales",[1,1,1])!=[1,1,1]:
            raise ValueError("Blocker placement requires explicit rotated-volume handling")
        name=json.loads(entity["model"].split("resource_name:",1)[1])
        stem=pathlib.PurePosixPath(name).stem
        candidates=sorted(pathlib.Path(folder).rglob(stem+"*.gltf"),key=lambda p: "_physics" not in p.stem)
        if not candidates:
            raise ValueError("Missing original blocker geometry: "+name)
        local=None
        for candidate in candidates:
            boxes=node_bounds(json.loads(candidate.read_text()))
            if boxes:
                local=bounds([corner for box in boxes.values() for corner in box])
                break
        if local is None:
            raise ValueError("Blocker model has no geometry: "+name)
        origin=entity["origin"]
        world=[[corner[i]+origin[i] for i in range(3)] for corner in local]
        blockers.append({"source_id":entity["hammeruniqueid"],"model":name,"local_bounds":local,"bounds":world})
    areas={a["id"]:a for a in nav["areas"] if a["hull"]==0 and a["movable"]==0xffffffff}
    blocked={key for key,a in areas.items() if any(overlap(bounds(a["corners"]),b["bounds"]) for b in blockers)}
    eligible={key:a for key,a in areas.items() if key not in blocked}
    print('BLOCKER_DIAGNOSTICS',json.dumps({'blockers':blockers,'eligible':len(eligible),'blocked':len(blocked)}))
    seeds=[]
    for entity in source["entities"]:
        if not entity["classname"].startswith("info_player_"):
            continue
        p=entity["origin"]
        candidates=[a for a in eligible.values() if contains_xy(p,a["corners"])]
        if not candidates:
            def distance(area):
                best=float("inf")
                poly=area["corners"]
                for a,b in zip(poly,poly[1:]+poly[:1]):
                    dx,dy=b[0]-a[0],b[1]-a[1]
                    length=dx*dx+dy*dy
                    t=max(0,min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/length)) if length else 0
                    best=min(best,math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy))
                vertical=abs(sum(c[2] for c in poly)/len(poly)-p[2])
                return best,vertical
            nearby=sorted(eligible.values(),key=lambda a:(distance(a)[0]+distance(a)[1]*.05))
            print("SPAWN_NAV_DIAGNOSTICS",json.dumps({"spawn":p,"nearest":[
                {"id":a["id"],"distance":distance(a),"bounds":bounds(a["corners"])}
                for a in nearby[:3]]}))
            if not nearby or distance(nearby[0])[0]>128 or distance(nearby[0])[1]>128:
                raise ValueError("Original spawn is too far from unblocked navigation: "+str(p))
            candidates=[nearby[0]]
        selected=min(candidates,key=lambda a:abs(sum(c[2] for c in a["corners"])/len(a["corners"])-p[2]))
        seeds.append(selected["id"])
    if len(seeds)!=8:
        raise ValueError("Expected eight original Wingman spawns")
    reached,queue=set(),[seeds[0]]
    while queue:
        key=queue.pop()
        if key in reached or key not in eligible:
            continue
        reached.add(key)
        queue.extend(eligible[key]["adjacent"])
    if not set(seeds)<=reached:
        raise ValueError("Original spawns are not in one Wingman navigation component")
    if not 5<len(reached)<len(areas)*.75:
        raise ValueError("Navigation blockers did not isolate a plausible Wingman section")
    selected=[eligible[key] for key in sorted(reached)]
    return {"method":"Original hull-0 navigation connectivity with original 2v2 blocker volumes",
            "blockers":blockers,"total_areas":len(areas),"blocked_areas":len(blocked),
            "spawn_area_ids":seeds,"selected_area_ids":sorted(reached),
            "source_bounds":bounds([p for a in selected for p in a["corners"]]),
            "areas":selected}


if __name__=="__main__":
    nav=json.loads(pathlib.Path(sys.argv[1]).read_text())
    source=json.loads(pathlib.Path(sys.argv[2]).read_text())
    result=select_region(nav,source,sys.argv[3])
    pathlib.Path(sys.argv[4]).write_text(json.dumps(result,separators=(",",":"))+"\n")
    summary={k:v for k,v in result.items() if k not in ("areas","selected_area_ids")}
    summary["selected_areas"]=len(result["areas"])
    print(json.dumps(summary,indent=2))
