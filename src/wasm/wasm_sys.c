#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

#include "../game/q_shared.h"
#include "../qcommon/qcommon.h"
#include "../renderer/tr_public.h"
#include "../client/client.h"
extern void Wasm_ServerStatus(float *data);

#define WASM_IMPORT(name) __attribute__((import_module("env"), import_name(#name)))
#define WASM_EXPORT(name) __attribute__((export_name(#name), visibility("default")))

WASM_IMPORT(js_time_ms)        int  js_time_ms(void);
WASM_IMPORT(js_console_print)  void js_console_print(const char *str, int len);
WASM_IMPORT(js_exit)           void js_exit(int code);
WASM_IMPORT(js_vfs_list_files) int  js_vfs_list_files(const char *directory, const char *extension, char *out_buf, int max_len);

/* Statically linked VM entry points (prefixed during compilation) */
extern void qagame_dllEntry(int (QDECL *syscallptr)(int, ...));
extern int  qagame_vmMain(int command, int arg0, int arg1, int arg2, int arg3, int arg4, int arg5, int arg6, int arg7, int arg8, int arg9, int arg10, int arg11);

extern void cgame_dllEntry(int (QDECL *syscallptr)(int, ...));
extern int  cgame_vmMain(int command, int arg0, int arg1, int arg2, int arg3, int arg4, int arg5, int arg6, int arg7, int arg8, int arg9, int arg10, int arg11);

extern void ui_dllEntry(int (QDECL *syscallptr)(int, ...));
extern int  ui_vmMain(int command, int arg0, int arg1, int arg2, int arg3, int arg4, int arg5, int arg6, int arg7, int arg8, int arg9, int arg10, int arg11);

extern void IN_Init(void);
extern void IN_Frame(void);
extern void IN_Shutdown(void);
extern void IN_Restart(void);
extern void Sys_SendKeyEvents(void);

static char cdPath[MAX_OSPATH] = "";
static char installPath[MAX_OSPATH] = ".";
static char homePath[MAX_OSPATH] = ".";

unsigned sys_frame_time = 0;
qboolean stdin_active = qfalse;

/* =========================================================================
 * Memory & Vector Helpers
 * ========================================================================= */
void Com_Memcpy(void *dest, const void *src, const size_t count) {
    memcpy(dest, src, count);
}

void Com_Memset(void *dest, const int val, const size_t count) {
    memset(dest, val, count);
}

long fastftol(float f) {
    return (long)f;
}

void Sys_SnapVector(float *v) {
    v[0] = rint(v[0]);
    v[1] = rint(v[1]);
    v[2] = rint(v[2]);
}

/* =========================================================================
 * Timing & System Info
 * ========================================================================= */
static int sys_timeBase = 0;
int curtime = 0;

int Sys_Milliseconds(void) {
    int now = js_time_ms();
    if (!sys_timeBase) {
        sys_timeBase = now;
        return 1;
    }
    curtime = now - sys_timeBase;
    if (curtime < 1) curtime = 1;
    return curtime;
}

qboolean Sys_LowPhysicalMemory(void) {
    return qfalse;
}

int Sys_GetProcessorId(void) {
    return CPUID_GENERIC;
}

unsigned int Sys_ProcessorCount(void) {
    return 1;
}

int Sys_MonkeyShouldBeSpanked(void) {
    return 0;
}

void Sys_BeginProfiling(void) {}
void Sys_EndProfiling(void) {}

void Sys_ShowConsole(int visLevel, qboolean quitOnClose) {
    (void)visLevel;
    (void)quitOnClose;
}

char *Sys_GetCurrentUser(void) {
    return "player";
}

qboolean Sys_CheckCD(void) {
    return qtrue;
}

char *Sys_GetClipboardData(void) {
    return NULL;
}

void Sys_Print(const char *msg) {
    if (msg) {
        js_console_print(msg, (int)strlen(msg));
    }
}

void Sys_Error(const char *error, ...) {
    va_list argptr;
    char string[1024];

    va_start(argptr, error);
    vsnprintf(string, sizeof(string), error, argptr);
    va_end(argptr);

    fprintf(stderr, "Sys_Error: %s\n", string);
    js_exit(1);
    __builtin_unreachable();
}

void Sys_Warn(char *warning, ...) {
    va_list argptr;
    char string[1024];

    va_start(argptr, warning);
    vsnprintf(string, sizeof(string), warning, argptr);
    va_end(argptr);

    fprintf(stderr, "Warning: %s", string);
}

void Sys_Quit(void) {
    CL_Shutdown();
    js_exit(0);
    __builtin_unreachable();
}

void Sys_In_Restart_f(void) {
    IN_Shutdown();
    IN_Init();
}

void Sys_Init(void) {
    Cmd_AddCommand("in_restart", Sys_In_Restart_f);
    Cvar_Set("arch", "wasm32 webgl");
    Cvar_Set("username", Sys_GetCurrentUser());
    IN_Init();
}

/* =========================================================================
 * Filesystem & Directory Paths
 * ========================================================================= */
void Sys_Mkdir(const char *path) {
    (void)path;
}

char *Sys_Cwd(void) {
    return ".";
}

void Sys_SetDefaultCDPath(const char *path) {
    Q_strncpyz(cdPath, path, sizeof(cdPath));
}

char *Sys_DefaultCDPath(void) {
    return cdPath;
}

void Sys_SetDefaultInstallPath(const char *path) {
    Q_strncpyz(installPath, path, sizeof(installPath));
}

char *Sys_DefaultInstallPath(void) {
    if (*installPath) return installPath;
    return Sys_Cwd();
}

void Sys_SetDefaultHomePath(const char *path) {
    Q_strncpyz(homePath, path, sizeof(homePath));
}

char *Sys_DefaultHomePath(void) {
    return homePath;
}

int Sys_FileTime(char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) return -1;
    fclose(f);
    return 1;
}

#define MAX_FOUND_FILES 0x1000

char **Sys_ListFiles(const char *directory, const char *extension, char *filter, int *numfiles, qboolean wantsubs) {
    static char raw_buf[65536];
    char *list[MAX_FOUND_FILES];
    char **listCopy;
    int nfiles = 0;
    int i;

    (void)wantsubs;
    if (numfiles) *numfiles = 0;

    const char *ext = extension ? extension : "";
    if (filter) ext = "";

    int count = js_vfs_list_files(directory ? directory : ".", ext, raw_buf, (int)sizeof(raw_buf));
    if (count <= 0) {
        return NULL;
    }

    char *p = raw_buf;
    while (*p && nfiles < MAX_FOUND_FILES - 1) {
        char *line = p;
        while (*p && *p != '\n') p++;
        if (*p == '\n') *p++ = '\0';
        if (!*line) continue;

        if (filter && !Com_FilterPath(filter, line, qfalse)) {
            continue;
        }
        list[nfiles++] = CopyString(line);
    }

    list[nfiles] = NULL;
    if (numfiles) *numfiles = nfiles;
    if (!nfiles) return NULL;

    listCopy = (char **)Z_Malloc((nfiles + 1) * sizeof(*listCopy));
    for (i = 0; i < nfiles; i++) {
        listCopy[i] = list[i];
    }
    listCopy[i] = NULL;
    return listCopy;
}

void Sys_FreeFileList(char **list) {
    int i;
    if (!list) return;
    for (i = 0; list[i]; i++) {
        Z_Free(list[i]);
    }
    Z_Free(list);
}

/* =========================================================================
 * Streamed File I/O
 * ========================================================================= */
void Sys_InitStreamThread(void) {}
void Sys_ShutdownStreamThread(void) {}
void Sys_BeginStreamedFile(fileHandle_t f, int readAhead) {
    (void)f; (void)readAhead;
}
void Sys_EndStreamedFile(fileHandle_t f) {
    (void)f;
}
int Sys_StreamedRead(void *buffer, int size, int count, fileHandle_t f) {
    return FS_Read(buffer, size * count, f);
}
void Sys_StreamSeek(fileHandle_t f, int offset, int origin) {
    FS_Seek(f, offset, origin);
}

/* =========================================================================
 * VM / Native DLL Loader (Statically Linked qagame, cgame, ui)
 * ========================================================================= */
void Sys_UnloadDll(void *dllHandle) {
    (void)dllHandle;
}

void * QDECL Sys_LoadDll(const char *name, char *fqpath,
                         int (QDECL **entryPoint)(int, ...),
                         int (QDECL *systemcalls)(int, ...)) {
    if (fqpath) *fqpath = 0;
    if (!name || !entryPoint || !systemcalls) return NULL;

    if (!Q_stricmp(name, "qagame")) {
        Com_Printf("Sys_LoadDll(qagame): binding statically linked WebAssembly module\n");
        *entryPoint = (int (QDECL *)(int, ...))(void *)qagame_vmMain;
        qagame_dllEntry(systemcalls);
        if (fqpath) Q_strncpyz(fqpath, "wasm://qagame", MAX_QPATH);
        return (void *)1;
    }
    if (!Q_stricmp(name, "cgame")) {
        Com_Printf("Sys_LoadDll(cgame): binding statically linked WebAssembly module\n");
        *entryPoint = (int (QDECL *)(int, ...))(void *)cgame_vmMain;
        cgame_dllEntry(systemcalls);
        if (fqpath) Q_strncpyz(fqpath, "wasm://cgame", MAX_QPATH);
        return (void *)2;
    }
    if (!Q_stricmp(name, "ui")) {
        Com_Printf("Sys_LoadDll(ui): binding statically linked WebAssembly module\n");
        *entryPoint = (int (QDECL *)(int, ...))(void *)ui_vmMain;
        ui_dllEntry(systemcalls);
        if (fqpath) Q_strncpyz(fqpath, "wasm://ui", MAX_QPATH);
        return (void *)3;
    }

    Com_Printf("Sys_LoadDll(%s): unknown module\n", name);
    return NULL;
}

/* =========================================================================
 * System Event Queue
 * ========================================================================= */
#define MAX_QUED_EVENTS  256
#define MASK_QUED_EVENTS (MAX_QUED_EVENTS - 1)

static sysEvent_t eventQue[MAX_QUED_EVENTS];
static int eventHead = 0;
static int eventTail = 0;
static byte sys_packetReceived[MAX_MSGLEN];

void Sys_QueEvent(int time, sysEventType_t type, int value, int value2, int ptrLength, void *ptr) {
    sysEvent_t *ev = &eventQue[eventHead & MASK_QUED_EVENTS];

    if (eventHead - eventTail >= MAX_QUED_EVENTS) {
        if (ev->evPtr) {
            Z_Free(ev->evPtr);
        }
        eventTail++;
    }

    eventHead++;

    if (time == 0) {
        time = Sys_Milliseconds();
    }

    ev->evTime = time;
    ev->evType = type;
    ev->evValue = value;
    ev->evValue2 = value2;
    ev->evPtrLength = ptrLength;
    ev->evPtr = ptr;
}

sysEvent_t Sys_GetEvent(void) {
    sysEvent_t ev;
    msg_t netmsg;
    netadr_t adr;

    if (eventHead > eventTail) {
        eventTail++;
        return eventQue[(eventTail - 1) & MASK_QUED_EVENTS];
    }

    Sys_SendKeyEvents();
    IN_Frame();

    MSG_Init(&netmsg, sys_packetReceived, sizeof(sys_packetReceived));
    if (Sys_GetPacket(&adr, &netmsg)) {
        netadr_t *buf;
        int len = (int)sizeof(netadr_t) + netmsg.cursize;
        buf = (netadr_t *)Z_Malloc(len);
        *buf = adr;
        memcpy(buf + 1, netmsg.data, netmsg.cursize);
        Sys_QueEvent(0, SE_PACKET, 0, 0, len, buf);
    }

    if (eventHead > eventTail) {
        eventTail++;
        return eventQue[(eventTail - 1) & MASK_QUED_EVENTS];
    }

    memset(&ev, 0, sizeof(ev));
    ev.evTime = Sys_Milliseconds();
    return ev;
}

/* =========================================================================
 * Exported WebAssembly Entry Points for Browser Host
 * ========================================================================= */
WASM_EXPORT(wasm_q3_alloc)
void *wasm_q3_alloc(int size) {
    return malloc((size_t)size);
}

WASM_EXPORT(wasm_q3_free)
void wasm_q3_free(void *ptr) {
    free(ptr);
}

WASM_EXPORT(wasm_q3_init)
void wasm_q3_init(const char *cmdline) {
    static char cmdline_buf[1024];
    memset(eventQue, 0, sizeof(eventQue));
    memset(sys_packetReceived, 0, sizeof(sys_packetReceived));

    if (cmdline && *cmdline) {
        Q_strncpyz(cmdline_buf, cmdline, sizeof(cmdline_buf));
    } else {
        Q_strncpyz(cmdline_buf, "+set sv_pure 0 +set vm_game 0 +set vm_cgame 0 +set vm_ui 0 +set r_mode -1 +set r_fullscreen 0 +set in_mouse 1", sizeof(cmdline_buf));
    }

    Com_Init(cmdline_buf);
    NET_Init();
}

WASM_EXPORT(wasm_q3_frame)
void wasm_q3_frame(void) {
    Com_Frame();
}

WASM_EXPORT(wasm_q3_client_active)
int wasm_q3_client_active(void) {
    return cls.state == CA_ACTIVE;
}

WASM_EXPORT(wasm_q3_mapname)
const char *wasm_q3_mapname(void) {
    return Info_ValueForKey(cl.gameState.stringData + cl.gameState.stringOffsets[CS_SERVERINFO], "mapname");
}

/* Read-only integration-test snapshot; no replacement game logic. */
WASM_EXPORT(wasm_q3_status)
const float *wasm_q3_status(void) {
    static float data[16];
    int i;
    memset(data, 0, sizeof(data));
    data[0] = cls.state == CA_ACTIVE;
    for (i = 0; i < 3; i++) {
        data[1 + i] = cl.snap.ps.origin[i];
        data[4 + i] = cl.snap.ps.velocity[i];
    }
    data[12] = cl.snap.ps.stats[STAT_HEALTH];
    data[13] = cl.snap.ps.weapon;
    data[15] = cl.snap.ps.clientNum;
    Wasm_ServerStatus(data);
    return data;
}

/* Snapshot entity positions for verifying real remote player replication. */
WASM_EXPORT(wasm_q3_remote_players)
const float *wasm_q3_remote_players(void) {
    static float data[33];
    int i, count = 0;
    memset(data, 0, sizeof(data));
    for (i = 0; i < cl.snap.numEntities && count < 8; i++) {
        entityState_t *entity = &cl.parseEntities[(cl.snap.parseEntitiesNum + i) & (MAX_PARSE_ENTITIES - 1)];
        if (entity->eType != ET_PLAYER) continue;
        data[1 + count * 4] = entity->number;
        memcpy(data + 2 + count * 4, entity->pos.trBase, sizeof(vec3_t));
        count++;
    }
    data[0] = count;
    return data;
}

WASM_EXPORT(wasm_q3_key_event)
void wasm_q3_key_event(int key, int down, int time) {
    /* Browser event timestamps use js_time_ms's clock; engine timestamps
       start at sys_timeBase. Keep key-duration calculations in one domain. */
    if (time) time = time > sys_timeBase ? time - sys_timeBase : 1;
    Sys_QueEvent(time, SE_KEY, key, down ? qtrue : qfalse, 0, NULL);
}

WASM_EXPORT(wasm_q3_char_event)
void wasm_q3_char_event(int ch, int time) {
    if (time) time = time > sys_timeBase ? time - sys_timeBase : 1;
    Sys_QueEvent(time, SE_CHAR, ch, 0, 0, NULL);
}

WASM_EXPORT(wasm_q3_mouse_event)
void wasm_q3_mouse_event(int dx, int dy, int time) {
    if (time) time = time > sys_timeBase ? time - sys_timeBase : 1;
    Sys_QueEvent(time, SE_MOUSE, dx, dy, 0, NULL);
}

WASM_EXPORT(wasm_q3_console_command)
void wasm_q3_console_command(const char *cmd) {
    if (cmd && *cmd) {
        Cbuf_AddText(cmd);
        Cbuf_AddText("\n");
    }
}
