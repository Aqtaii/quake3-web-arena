"""Prepare genuine Source 2 geometry for the verified native q3map2 glTF importer.
No replacement map geometry is generated. Only triangles outside the source-derived
Wingman context are omitted; retained positions, normals, UVs and colours are copied.
Usage: prepare_map.py EXPORT_ROOT BASEQ3_ROOT SOURCE_METADATA_DIR
"""
import array
import base64
import copy
import functools
import itertools
import json
import math
import pathlib
import struct
import sys
from urllib.parse import unquote
from wingman_region import IDENTITY, matrix, multiply, point, source_point, node_bounds

SIZES={5120:1,5121:1,5122:2,5123:2,5125:4,5126:4}
FORMATS={5120:"b",5121:"B",5122:"h",5123:"H",5125:"I",5126:"f"}
COUNTS={"SCALAR":1,"VEC2":2,"VEC3":3,"VEC4":4}


class Geometry:
    def __init__(self,path,root):
        self.path,self.root=path,root.resolve()
        self.data=json.loads(path.read_text())
        self.buffers=[]
        for buffer in self.data.get("buffers",[]):
            uri=buffer["uri"]
            if uri.startswith("data:"):
                payload=base64.b64decode(uri.split(",",1)[1])
            else:
                target=(path.parent/unquote(uri)).resolve()
                if not target.is_relative_to(self.root):
                    raise ValueError("Buffer escapes export root")
                payload=target.read_bytes()
            if len(payload)<buffer["byteLength"]:
                raise ValueError("Truncated input buffer")
            self.buffers.append(payload)

    def layout(self,index):
        a=self.data["accessors"][index]
        if "sparse" in a:
            raise ValueError("Sparse geometry requires explicit expansion")
        view=self.data["bufferViews"][a["bufferView"]]
        size=SIZES[a["componentType"]]*COUNTS[a["type"]]
        return a,self.buffers[view["buffer"]],view.get("byteOffset",0)+a.get("byteOffset",0),view.get("byteStride",size),size

    @functools.lru_cache(maxsize=64)
    def values(self,index):
        a,buffer,offset,stride,size=self.layout(index)
        fmt="<"+FORMATS[a["componentType"]]*COUNTS[a["type"]]
        return [struct.unpack_from(fmt,buffer,offset+i*stride) for i in range(a["count"])]


def inside_xy(box, region):
    return all(box[0][i]>=region[0][i] and box[1][i]<=region[1][i] for i in (0,1))


def overlaps_xy(box,region):
    return all(box[1][i]>=region[0][i] and box[0][i]<=region[1][i] for i in (0,1))


def world_matrices(data):
    result={}
    def walk(index,parent,chain):
        if index in chain:
            raise ValueError("Cyclic scene graph")
        transform=multiply(parent,matrix(data["nodes"][index]))
        result[index]=transform
        for child in data["nodes"][index].get("children",[]):
            walk(child,transform,chain|{index})
    for root in data["scenes"][data.get("scene",0)]["nodes"]:
        walk(root,IDENTITY,set())
    return result


def physics_category(node):
    name=node.get("name","").lower()
    if not name.startswith(("physics","prop_","func_brush","func_breakable","func_door")):
        return None
    tags=" ".join(map(str,node.get("extras",{}).get("InteractAs",[]))).lower()
    if "grenadeclip" in tags:
        return None  # Source grenade-only filters have no identical stock Quake contents bit.
    return "playerclip" if "playerclip" in tags else "solid"


def crop_geometry(source,region,destination,physics=False):
    data=source.data
    boxes=node_bounds(data)
    matrices=world_matrices(data)
    nodes=copy.deepcopy(data["nodes"])
    meshes,accessors,views,materials,blob=[],[],[],[],bytearray()
    material_map={}
    used_original_materials=set()
    stats={"input_triangles":0,"retained_triangles":0,"retained_nodes":0,"vertices":0}
    world_min=[math.inf]*3;world_max=[-math.inf]*3

    def add_accessor(raw,template,count,minimum=None,maximum=None,target=34962):
        while len(blob)%4:blob.append(0)
        offset=len(blob);blob.extend(raw)
        view_index=len(views)
        views.append({"buffer":0,"byteOffset":offset,"byteLength":len(raw),"target":target})
        result={k:template[k] for k in ("componentType","type","normalized") if k in template}
        result.update(bufferView=view_index,count=count)
        if minimum is not None:result.update(min=minimum,max=maximum)
        accessors.append(result)
        return len(accessors)-1

    for node_id,node in enumerate(nodes):
        original_mesh=node.pop("mesh",None)
        node.pop("skin",None);node.pop("weights",None)
        if original_mesh is None or node_id not in matrices:
            continue
        category=physics_category(node) if physics else None
        if physics and category is None:
            continue
        box=boxes.get(node_id)
        if box is None or not overlaps_xy(box,region):
            continue
        transform=matrices[node_id]
        primitives=[]
        fully_inside=inside_xy(box,region)
        for primitive in data["meshes"][original_mesh].get("primitives",[]):
            if primitive.get("mode",4)!=4:
                raise ValueError("Non-triangle source primitive")
            attributes=primitive["attributes"]
            positions=source.values(attributes["POSITION"])
            if source.data["accessors"][attributes["POSITION"]]["componentType"]!=5126:
                raise ValueError("Unexpected quantized source positions")
            indices=([v[0] for v in source.values(primitive["indices"])]
                     if "indices" in primitive else list(range(len(positions))))
            stats["input_triangles"]+=len(indices)//3
            if len(indices)%3:raise ValueError("Incomplete triangle list")
            if fully_inside:
                kept=indices
            else:
                transformed=[source_point(point(transform,p)) for p in positions]
                kept=[]
                for i in range(0,len(indices),3):
                    tri=indices[i:i+3]
                    corners=[transformed[j] for j in tri]
                    triangle_box=[[min(p[k] for p in corners) for k in range(3)],
                                  [max(p[k] for p in corners) for k in range(3)]]
                    if overlaps_xy(triangle_box,region):kept.extend(tri)
            if not kept:continue
            used=list(dict.fromkeys(kept))
            remap={old:new for new,old in enumerate(used)}
            old_material=primitive.get("material")
            key=category if physics else old_material
            if key not in material_map:
                material_map[key]=len(materials)
                name="textures/inferno/physics_"+category if physics else "textures/inferno/m"+str(old_material).zfill(4)
                materials.append({"name":name})
            if not physics:
                if old_material is None:raise ValueError("Retained source surface lacks a material")
                used_original_materials.add(old_material)
                material=data["materials"][old_material]
                texture=material.get("pbrMetallicRoughness",{}).get("baseColorTexture",{})
                if texture.get("extensions"):raise ValueError("Texture transforms need explicit baking")
                uv="TEXCOORD_"+str(texture.get("texCoord",0))
            else:uv="TEXCOORD_0"
            new_attributes={}
            for name,index in attributes.items():
                if name not in ("POSITION","NORMAL","COLOR_0",uv):continue
                a,buffer,offset,stride,size=source.layout(index)
                raw=b"".join(buffer[offset+j*stride:offset+j*stride+size] for j in used)
                minimum=maximum=None
                if name=="POSITION":
                    minimum=[min(positions[j][k] for j in used) for k in range(3)]
                    maximum=[max(positions[j][k] for j in used) for k in range(3)]
                    for j in used:
                        p=source_point(point(transform,positions[j]))
                        for k in range(3):
                            world_min[k]=min(world_min[k],p[k]);world_max[k]=max(world_max[k],p[k])
                output_name="TEXCOORD_0" if name==uv else name
                new_attributes[output_name]=add_accessor(raw,a,len(used),minimum,maximum)
            packed=array.array("I",(remap[j] for j in kept))
            if sys.byteorder!="little":packed.byteswap()
            index=add_accessor(packed.tobytes(),{"componentType":5125,"type":"SCALAR"},len(kept),target=34963)
            primitives.append({"attributes":new_attributes,"indices":index,"material":material_map[key]})
            stats["retained_triangles"]+=len(kept)//3;stats["vertices"]+=len(used)
        if primitives:
            node["mesh"]=len(meshes)
            meshes.append({"name":node.get("name","mesh"),"primitives":primitives})
            stats["retained_nodes"]+=1
    if not meshes:raise ValueError("Source-derived region contains no geometry")
    destination.parent.mkdir(parents=True,exist_ok=True)
    destination.with_suffix(".bin").write_bytes(blob)
    result={"asset":{"version":"2.0","generator":"Original Source 2 geometry to Quake import preparation"},
            "scene":data.get("scene",0),"scenes":data["scenes"],"nodes":nodes,"meshes":meshes,"materials":materials,
            "accessors":accessors,"bufferViews":views,"buffers":[{"uri":destination.with_suffix(".bin").name,"byteLength":len(blob)}]}
    destination.write_text(json.dumps(result,separators=(",",":"))+"\n")
    stats.update(binary_bytes=len(blob),source_bounds=[world_min,world_max])
    return used_original_materials,stats


def brush(lo,hi,shader):
    x,y,z=lo;X,Y,Z=hi
    faces=[[(x,y,z),(x,Y,z),(x,y,Z)],[(X,y,z),(X,y,Z),(X,Y,z)],
           [(x,y,z),(x,y,Z),(X,y,z)],[(x,Y,z),(X,Y,z),(x,Y,Z)],
           [(x,y,z),(X,y,z),(x,Y,z)],[(x,y,Z),(x,Y,Z),(X,y,Z)]]
    return "{\n"+"\n".join(" ".join("( %.5f %.5f %.5f )"%p for p in face)+
                          " "+shader+" 0 0 0 1 1 0 0 0" for face in faces)+"\n}\n"


def entity(fields):
    return "{\n"+"\n".join(json.dumps(str(k))+" "+json.dumps(str(v)) for k,v in fields.items())+"\n}\n"


def main():
    export,output,metadata=map(pathlib.Path,sys.argv[1:4])
    export=export.resolve();output=output.resolve()
    region=json.loads((metadata/"region-source.json").read_text())
    source=json.loads((metadata/"wingman-source.json").read_text())
    lighting=json.loads((metadata/"lighting-source.json").read_text())["lights"]
    base=region["source_bounds"]
    render_box=[[base[0][0]-512,base[0][1]-512,-1e9],[base[1][0]+512,base[1][1]+512,1e9]]
    collision_box=[[base[0][0]-256,base[0][1]-256,-1e9],[base[1][0]+256,base[1][1]+256,1e9]]
    model=output/"models/inferno"
    original=Geometry(export/"maps/de_inferno.gltf",export)
    used,render_stats=crop_geometry(original,render_box,model/"render.gltf")
    _,physics_stats=crop_geometry(Geometry(export/"maps/de_inferno_physics.gltf",export),
                                 collision_box,model/"physics.gltf",True)
    jobs=[];shaders=[]
    for index in sorted(used):
        material=original.data["materials"][index]
        pbr=material.get("pbrMetallicRoughness",{})
        texture=pbr.get("baseColorTexture")
        input_path=None
        if texture is not None:
            image=original.data["images"][original.data["textures"][texture["index"]]["source"]]
            if "uri" not in image or image["uri"].startswith("data:"):
                raise ValueError("Expected satellite source image")
            path=(original.path.parent/unquote(image["uri"])).resolve()
            if not path.is_relative_to(export):raise ValueError("Texture escapes export root")
            input_path=path.relative_to(export).as_posix()
        name="textures/inferno/m"+str(index).zfill(4)
        alpha=material.get("alphaMode","OPAQUE")
        extension=".jpg" if alpha=="OPAQUE" else ".tga"
        jobs.append({"input":input_path,"output":name+extension,
                     "factor":pbr.get("baseColorFactor",[1,1,1,1]),"alphaMode":alpha,
                     "alphaCutoff":material.get("alphaCutoff",.5)})
        lines=[name,"{","q3map_shadeAngle 60","surfaceparm nonsolid","surfaceparm nolightmap"]
        if material.get("doubleSided",False):lines.append("cull disable")
        if alpha=="BLEND":lines.append("sort banner")
        lines+=["{","map "+name+extension,"rgbGen vertex","alphaGen identity" if alpha=="OPAQUE" else "alphaGen vertex"]
        if alpha=="MASK":lines+=["alphaFunc GE128","depthWrite"]
        elif alpha=="BLEND":lines.append("blendFunc blend")
        lines+=["}","}"];shaders.append("\n".join(lines))
    shaders+=["textures/inferno/physics_solid\n{\nsurfaceparm nodraw\nq3map_clipModel\n}",
              "textures/inferno/physics_playerclip\n{\nsurfaceparm nodraw\nsurfaceparm playerclip\nq3map_clipModel\n}"]
    sun=next(e for e in lighting if e["classname"]=="light_environment" and e.get("enabled",True))
    rgb=[c/255 for c in sun["color"]]
    yaw=(float(sun["angles"][1])+180)%360;elevation=float(sun["angles"][0])
    # Preserve source sun direction/colour. Source 2 HDR energy is not a Quake light unit.
    shaders.append("textures/inferno/sky\n{\nsurfaceparm sky\nsurfaceparm noimpact\nsurfaceparm nolightmap\n"+
        "q3map_sunExt %g %g %g 144 %g %g 0.3 8\n"%(*rgb,yaw,elevation)+
        "skyparms - 512 -\n{\nmap $whiteimage\nrgbGen const ( 0.53 0.78 1 )\n}\n}")
    (output/"scripts").mkdir(parents=True,exist_ok=True)
    (output/"scripts/inferno.shader").write_text("\n\n".join(shaders)+"\n")
    (output/"scripts/shaderlist.txt").write_text("inferno\n")
    (output/"texture-jobs.json").write_text(json.dumps(jobs)+"\n")
    points=[p for stats in (render_stats,physics_stats) for p in stats["source_bounds"]]
    lo=[math.floor(min(p[i] for p in points)-512) for i in range(3)]
    hi=[math.ceil(max(p[i] for p in points)+512) for i in range(3)]
    if max(abs(v) for v in lo+hi)>32700:raise ValueError("Converted map exceeds conservative Quake world limits")
    x,y,z=lo;X,Y,Z=hi;t=64
    boxes=[((x-t,y-t,z-t),(x,Y+t,Z+t)),((X,y-t,z-t),(X+t,Y+t,Z+t)),
           ((x,y-t,z-t),(X,y,Z+t)),((x,Y,z-t),(X,Y+t,Z+t)),
           ((x,y,z-t),(X,Y,z)),((x,y,Z),(X,Y,Z+t))]
    text='{\n"classname" "worldspawn"\n"_ambient" "24"\n"_color" "0.53 0.78 1"\n'
    text+=''.join(brush(*b,"textures/inferno/sky") for b in boxes)+"}\n"
    for name,flags in (("render",4),("physics",2)):
        text+=entity({"classname":"misc_model","model":"models/inferno/"+name+".gltf",
                      "angles":"0 90 0","modelscale":"39.37007874015748","spawnflags":flags})
    for e in source["entities"]:
        if e["classname"].startswith("info_player_"):
            p=e["origin"]
            text+=entity({"classname":"info_player_deathmatch","origin":"%g %g %g"%(p[0],p[1],p[2]+24),
                          "angle":"%g"%e["angles"][1]})
    for light in lighting:
        if not light["classname"].startswith(("light_omni","light_spot")) or not light.get("enabled",True):
            continue
        p=light["origin"]
        if not all(base[0][i]-128<=p[i]<=base[1][i]+128 for i in (0,1)):continue
        color=light.get("color",[255,255,255])
        intensity=max(30,min(500,float(light.get("brightness_candelas",150))))
        text+=entity({"classname":"light","origin":"%g %g %g"%tuple(p),"_color":"%g %g %g"%tuple(c/255 for c in color),
                      "light":"%g"%intensity})
    (output/"maps").mkdir(parents=True,exist_ok=True)
    (output/"maps/inferno_wingman.map").write_text(text)
    report={"render":render_stats,"physics":physics_stats,"textures":len(jobs),
            "region_source":region["source"],"ready_for_gameplay":False,
            "limitations":["Source 2 PBR/HDR lighting is adapted, not reproduced identically.",
                           "Original sky cubemap still needs conversion; current sky colour is a prototype.",
                           "Source grenade-only collision tags need a Quake-specific gameplay policy.",
                           "Converted Source 2 props are static; Source 2 entity logic is not executed."]}
    (output/"preparation-report.json").write_text(json.dumps(report,indent=2)+"\n")
    print(json.dumps(report,indent=2))


if __name__=="__main__":
    main()
