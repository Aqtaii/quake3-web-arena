import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

ROOT_DIR = r"d:\proje\quake3"
Q3_CODE = os.path.join(ROOT_DIR, "Quake-III-Arena", "code")
INC_DIR = os.path.join(ROOT_DIR, "src", "include")
WASM_SRC_DIR = os.path.join(ROOT_DIR, "src", "wasm")
BUILD_DIR = os.path.join(ROOT_DIR, "build")
WEB_DIR = os.path.join(ROOT_DIR, "web")

LLVM_BIN = r"D:\Tools\psemu-build\llvm-20.1.8\clang+llvm-20.1.8-x86_64-pc-windows-msvc\bin"
CLANG = os.path.join(LLVM_BIN, "clang.exe")
WASM_LD = os.path.join(LLVM_BIN, "wasm-ld.exe")
LLVM_NM = os.path.join(LLVM_BIN, "llvm-nm.exe")
LLVM_AR = os.path.join(LLVM_BIN, "llvm-ar.exe")

COMMON_CFLAGS = [
    "--target=wasm32-unknown-unknown",
    "-std=gnu89",
    "-O2",
    "-fsigned-char",
    "-fno-strict-aliasing",
    "-fno-builtin",
    "-Wno-everything",
    "-D__linux__",
    "-DC_ONLY",
    "-DBOTLIB",
    f"-I{INC_DIR}",
]

ENGINE_SOURCES = [
    # qcommon
    "qcommon/cmd.c",
    "qcommon/cm_load.c",
    "qcommon/cm_patch.c",
    "qcommon/cm_polylib.c",
    "qcommon/cm_test.c",
    "qcommon/cm_trace.c",
    "qcommon/common.c",
    "qcommon/cvar.c",
    "qcommon/files.c",
    "qcommon/huffman.c",
    "qcommon/md4.c",
    "qcommon/msg.c",
    "qcommon/net_chan.c",
    "qcommon/unzip.c",
    "qcommon/vm.c",
    "qcommon/vm_interpreted.c",
    # game shared
    "game/q_math.c",
    "game/q_shared.c",
    # server
    "server/sv_bot.c",
    "server/sv_ccmds.c",
    "server/sv_client.c",
    "server/sv_game.c",
    "server/sv_init.c",
    "server/sv_main.c",
    "server/sv_net_chan.c",
    "server/sv_snapshot.c",
    "server/sv_world.c",
    # client
    "client/cl_cgame.c",
    "client/cl_cin.c",
    "client/cl_console.c",
    "client/cl_input.c",
    "client/cl_keys.c",
    "client/cl_main.c",
    "client/cl_net_chan.c",
    "client/cl_parse.c",
    "client/cl_scrn.c",
    "client/cl_ui.c",
    "client/snd_adpcm.c",
    "client/snd_dma.c",
    "client/snd_mem.c",
    "client/snd_mix.c",
    "client/snd_wavelet.c",
    # renderer
    "renderer/tr_animation.c",
    "renderer/tr_backend.c",
    "renderer/tr_bsp.c",
    "renderer/tr_cmds.c",
    "renderer/tr_curve.c",
    "renderer/tr_flares.c",
    "renderer/tr_font.c",
    "renderer/tr_image.c",
    "renderer/tr_init.c",
    "renderer/tr_light.c",
    "renderer/tr_main.c",
    "renderer/tr_marks.c",
    "renderer/tr_mesh.c",
    "renderer/tr_model.c",
    "renderer/tr_noise.c",
    "renderer/tr_scene.c",
    "renderer/tr_shade.c",
    "renderer/tr_shade_calc.c",
    "renderer/tr_shader.c",
    "renderer/tr_shadows.c",
    "renderer/tr_sky.c",
    "renderer/tr_surface.c",
    "renderer/tr_world.c",
    # jpeg-6
    "jpeg-6/jcapimin.c",
    "jpeg-6/jccoefct.c",
    "jpeg-6/jccolor.c",
    "jpeg-6/jcdctmgr.c",
    "jpeg-6/jchuff.c",
    "jpeg-6/jcinit.c",
    "jpeg-6/jcmainct.c",
    "jpeg-6/jcmarker.c",
    "jpeg-6/jcmaster.c",
    "jpeg-6/jcomapi.c",
    "jpeg-6/jcparam.c",
    "jpeg-6/jcphuff.c",
    "jpeg-6/jcprepct.c",
    "jpeg-6/jcsample.c",
    "jpeg-6/jctrans.c",
    "jpeg-6/jdapimin.c",
    "jpeg-6/jdapistd.c",
    "jpeg-6/jdatadst.c",
    "jpeg-6/jdatasrc.c",
    "jpeg-6/jdcoefct.c",
    "jpeg-6/jdcolor.c",
    "jpeg-6/jddctmgr.c",
    "jpeg-6/jdhuff.c",
    "jpeg-6/jdinput.c",
    "jpeg-6/jdmainct.c",
    "jpeg-6/jdmarker.c",
    "jpeg-6/jdmaster.c",
    "jpeg-6/jdpostct.c",
    "jpeg-6/jdsample.c",
    "jpeg-6/jdtrans.c",
    "jpeg-6/jerror.c",
    "jpeg-6/jfdctflt.c",
    "jpeg-6/jidctflt.c",
    "jpeg-6/jmemmgr.c",
    "jpeg-6/jmemnobs.c",
    "jpeg-6/jutils.c",
    # botlib
    "botlib/be_aas_bspq3.c",
    "botlib/be_aas_cluster.c",
    "botlib/be_aas_debug.c",
    "botlib/be_aas_entity.c",
    "botlib/be_aas_file.c",
    "botlib/be_aas_main.c",
    "botlib/be_aas_move.c",
    "botlib/be_aas_optimize.c",
    "botlib/be_aas_reach.c",
    "botlib/be_aas_route.c",
    "botlib/be_aas_routealt.c",
    "botlib/be_aas_sample.c",
    "botlib/be_ai_char.c",
    "botlib/be_ai_chat.c",
    "botlib/be_ai_gen.c",
    "botlib/be_ai_goal.c",
    "botlib/be_ai_move.c",
    "botlib/be_ai_weap.c",
    "botlib/be_ai_weight.c",
    "botlib/be_ea.c",
    "botlib/be_interface.c",
    "botlib/l_crc.c",
    "botlib/l_libvar.c",
    "botlib/l_log.c",
    "botlib/l_memory.c",
    "botlib/l_precomp.c",
    "botlib/l_script.c",
    "botlib/l_struct.c",
]

WASM_SOURCES = [
    "wasm_status.c",
    "wasm_libc.c",
    "wasm_qgl.c",
    "wasm_snd.c",
    "wasm_in.c",
    "wasm_net.c",
    "wasm_sys.c",
]

QAGAME_SOURCES = [
    "game/ai_chat.c",
    "game/ai_cmd.c",
    "game/ai_dmnet.c",
    "game/ai_dmq3.c",
    "game/ai_main.c",
    "game/ai_team.c",
    "game/ai_vcmd.c",
    "game/bg_misc.c",
    "game/bg_pmove.c",
    "game/bg_slidemove.c",
    "game/g_active.c",
    "game/g_arenas.c",
    "game/g_bot.c",
    "game/g_client.c",
    "game/g_cmds.c",
    "game/g_combat.c",
    "game/g_items.c",
    "game/g_main.c",
    "game/g_mem.c",
    "game/g_misc.c",
    "game/g_missile.c",
    "game/g_mover.c",
    "game/g_session.c",
    "game/g_spawn.c",
    "game/g_svcmds.c",
    "game/g_syscalls.c",
    "game/g_target.c",
    "game/g_team.c",
    "game/g_trigger.c",
    "game/g_utils.c",
    "game/g_weapon.c",
    "game/q_math.c",
    "game/q_shared.c",
]

CGAME_SOURCES = [
    "cgame/cg_consolecmds.c",
    "cgame/cg_draw.c",
    "cgame/cg_drawtools.c",
    "cgame/cg_effects.c",
    "cgame/cg_ents.c",
    "cgame/cg_event.c",
    "cgame/cg_info.c",
    "cgame/cg_localents.c",
    "cgame/cg_main.c",
    "cgame/cg_marks.c",
    "cgame/cg_players.c",
    "cgame/cg_playerstate.c",
    "cgame/cg_predict.c",
    "cgame/cg_scoreboard.c",
    "cgame/cg_servercmds.c",
    "cgame/cg_snapshot.c",
    "cgame/cg_syscalls.c",
    "cgame/cg_view.c",
    "cgame/cg_weapons.c",
    "game/bg_misc.c",
    "game/bg_pmove.c",
    "game/bg_slidemove.c",
    "game/q_math.c",
    "game/q_shared.c",
]

UI_SOURCES = [
    "q3_ui/ui_addbots.c",
    "q3_ui/ui_atoms.c",
    "q3_ui/ui_cdkey.c",
    "q3_ui/ui_cinematics.c",
    "q3_ui/ui_confirm.c",
    "q3_ui/ui_connect.c",
    "q3_ui/ui_controls2.c",
    "q3_ui/ui_credits.c",
    "q3_ui/ui_demo2.c",
    "q3_ui/ui_display.c",
    "q3_ui/ui_gameinfo.c",
    "q3_ui/ui_ingame.c",
    "q3_ui/ui_loadconfig.c",
    "q3_ui/ui_main.c",
    "q3_ui/ui_menu.c",
    "q3_ui/ui_mfield.c",
    "q3_ui/ui_mods.c",
    "q3_ui/ui_network.c",
    "q3_ui/ui_options.c",
    "q3_ui/ui_playermodel.c",
    "q3_ui/ui_players.c",
    "q3_ui/ui_playersettings.c",
    "q3_ui/ui_preferences.c",
    "q3_ui/ui_qmenu.c",
    "q3_ui/ui_removebots.c",
    "q3_ui/ui_saveconfig.c",
    "q3_ui/ui_serverinfo.c",
    "q3_ui/ui_servers2.c",
    "q3_ui/ui_setup.c",
    "q3_ui/ui_sound.c",
    "q3_ui/ui_sparena.c",
    "q3_ui/ui_specifyserver.c",
    "q3_ui/ui_splevel.c",
    "q3_ui/ui_sppostgame.c",
    "q3_ui/ui_spskill.c",
    "q3_ui/ui_startserver.c",
    "q3_ui/ui_team.c",
    "q3_ui/ui_teamorders.c",
    "q3_ui/ui_video.c",
    "ui/ui_syscalls.c",
    "game/bg_misc.c",
    "game/q_math.c",
    "game/q_shared.c",
]


def compile_one(src_path, obj_path, extra_flags=None, dep_path=None):
    os.makedirs(os.path.dirname(obj_path), exist_ok=True)
    if os.path.exists(obj_path):
        obj_mtime = os.path.getmtime(obj_path)
        src_mtime = os.path.getmtime(src_path)
        dep_mtime = os.path.getmtime(dep_path) if (dep_path and os.path.exists(dep_path)) else 0
        if obj_mtime >= src_mtime and obj_mtime >= dep_mtime:
            return obj_path
    cmd = [CLANG] + COMMON_CFLAGS
    if extra_flags:
        cmd.extend(extra_flags)
    cmd.extend(["-c", src_path, "-o", obj_path])
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"Compile failed for {src_path}:\n{res.stderr}")
    return obj_path


def get_defined_globals(obj_files):
    syms = set()
    res = subprocess.run([LLVM_NM, "--defined-only", "-g"] + obj_files, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"llvm-nm failed:\n{res.stderr}")
    for line in res.stdout.splitlines():
        parts = line.strip().split()
        if len(parts) >= 3:
            sym = parts[-1]
            syms.add(sym)
    return sorted(syms)


def build_vm_module(name, prefix, rel_sources):
    raw_dir = os.path.join(BUILD_DIR, f"{name}_raw")
    pref_dir = os.path.join(BUILD_DIR, f"{name}_pref")
    os.makedirs(raw_dir, exist_ok=True)
    os.makedirs(pref_dir, exist_ok=True)

    # Pass 1: compile raw objects to discover all defined global symbols
    raw_objs = []
    with ThreadPoolExecutor(max_workers=8) as ex:
        futs = []
        for rel in rel_sources:
            src = os.path.join(Q3_CODE, rel)
            obj = os.path.join(raw_dir, rel.replace("/", "_") + ".o")
            futs.append(ex.submit(compile_one, src, obj))
        for f in as_completed(futs):
            raw_objs.append(f.result())

    syms = get_defined_globals(raw_objs)
    print(f"[{name}] Discovered {len(syms)} global symbols to namespace with '{prefix}_'")

    prefix_h = os.path.join(BUILD_DIR, f"{name}_prefix.h")
    new_content = f"/* Auto-generated symbol prefix header for {name} */\n" + "".join(
        f"#define {sym} {prefix}_{sym}\n" for sym in syms
    )
    old_content = ""
    if os.path.exists(prefix_h):
        with open(prefix_h, "r", encoding="utf-8") as f:
            old_content = f.read()
    if new_content != old_content:
        with open(prefix_h, "w", encoding="utf-8") as f:
            f.write(new_content)

    # Pass 2: compile with -include prefix_h
    pref_objs = []
    with ThreadPoolExecutor(max_workers=8) as ex:
        futs = []
        for rel in rel_sources:
            src = os.path.join(Q3_CODE, rel)
            obj = os.path.join(pref_dir, rel.replace("/", "_") + ".o")
            futs.append(ex.submit(compile_one, src, obj, ["-include", prefix_h], prefix_h))
        for f in as_completed(futs):
            pref_objs.append(f.result())

    return pref_objs


def main():
    os.makedirs(BUILD_DIR, exist_ok=True)
    os.makedirs(WEB_DIR, exist_ok=True)

    print("1. Building engine & wasm platform objects...")
    eng_objs = []
    with ThreadPoolExecutor(max_workers=8) as ex:
        futs = []
        for rel in ENGINE_SOURCES:
            src = os.path.join(Q3_CODE, rel)
            obj = os.path.join(BUILD_DIR, "engine", rel.replace("/", "_") + ".o")
            futs.append(ex.submit(compile_one, src, obj))
        for rel in WASM_SOURCES:
            src = os.path.join(WASM_SRC_DIR, rel)
            obj = os.path.join(BUILD_DIR, "wasm", rel + ".o")
            futs.append(ex.submit(compile_one, src, obj, ["-std=gnu99", f"-I{os.path.join(Q3_CODE, 'unix')}", f"-I{Q3_CODE}"]))
        for f in as_completed(futs):
            eng_objs.append(f.result())
    print(f"   Compiled {len(eng_objs)} engine/platform objects.")

    print("2. Building qagame, cgame, q3_ui VM modules...")
    qagame_objs = build_vm_module("qagame", "qagame", QAGAME_SOURCES)
    cgame_objs = build_vm_module("cgame", "cgame", CGAME_SOURCES)
    ui_objs = build_vm_module("ui", "ui", UI_SOURCES)

    print("3. Linking web/quake3.wasm...")
    wasm_out = os.path.join(WEB_DIR, "quake3.wasm")
    all_objs = eng_objs + qagame_objs + cgame_objs + ui_objs
    ld_cmd = [
        WASM_LD,
        "--no-entry",
        "--export-dynamic",
        "--export=__stack_pointer",
        "-z", "stack-size=8388608",
        "--initial-memory=134217728",
        "--max-memory=536870912",
        "-o", wasm_out,
    ] + all_objs
    res = subprocess.run(ld_cmd, capture_output=True, text=True)
    if res.returncode != 0:
        print("LINK ERROR:\n", res.stderr)
        sys.exit(1)

    size_kb = os.path.getsize(wasm_out) / 1024.0
    print(f"SUCCESS! Linked {wasm_out} ({size_kb:.1f} KB)")


if __name__ == "__main__":
    main()
