/**
 * Quake III Arena — Zero-Dependency WebAssembly & WebGL2 Browser Host
 * Connects id Software's Quake III Arena (quake3.wasm) directly to:
 *  - WebGL2 Programmable Pipeline (emulating QGL fixed-function + multitexture)
 *  - WebAudio DMA Ring Buffer Streamer (22050 Hz 16-bit Stereo)
 *  - In-Memory Virtual File System (VFS) with .pk3 mount + localStorage config sync
 *  - Keyboard & Pointer Lock Mouse Input Bridge
 */

(() => {
    'use strict';

    // =========================================================================
    // Quake 3 KeyCode Constants (from code/q3_ui/keycodes.h)
    // =========================================================================
    const K_TAB         = 9;
    const K_ENTER       = 13;
    const K_ESCAPE      = 27;
    const K_SPACE       = 32;
    const K_BACKSPACE   = 127;
    const K_CAPSLOCK    = 129;
    const K_PAUSE       = 131;
    const K_UPARROW     = 132;
    const K_DOWNARROW   = 133;
    const K_LEFTARROW   = 134;
    const K_RIGHTARROW  = 135;
    const K_ALT         = 136;
    const K_CTRL        = 137;
    const K_SHIFT       = 138;
    const K_INS         = 139;
    const K_DEL         = 140;
    const K_PGDN        = 141;
    const K_PGUP        = 142;
    const K_HOME        = 143;
    const K_END         = 144;
    const K_F1          = 145;
    const K_MOUSE1      = 178;
    const K_MOUSE2      = 179;
    const K_MOUSE3      = 180;
    const K_MOUSE4      = 181;
    const K_MOUSE5      = 182;
    const K_MWHEELDOWN  = 183;
    const K_MWHEELUP    = 184;

    // =========================================================================
    // DOM Elements & Telemetry State
    // =========================================================================
    const canvas = document.getElementById('q3-canvas');
    const statusOverlay = document.getElementById('status-overlay');
    const statusText = document.getElementById('status-text');
    const progressBar = document.getElementById('progress-bar');
    const consoleDrawer = document.getElementById('console-drawer');
    const consoleOutput = document.getElementById('console-output');
    const consoleForm = document.getElementById('console-form');
    const consoleInput = document.getElementById('console-input');

    const statFps = document.getElementById('stat-fps');
    const statDraws = document.getElementById('stat-draws');
    const statTex = document.getElementById('stat-tex');
    const statMem = document.getElementById('stat-mem');
    const statPak = document.getElementById('stat-pak');

    let wasmExports = null;
    let wasmMemory = null;
    let engineRunning = false;
    let giveAllWhenActive = false;
    let logText = '';
    const engineButtons = ['btn-start-map', 'btn-add-bot', 'btn-give-all', 'btn-pointer-lock'];
    function setEngineControls(enabled) {
        for (const id of engineButtons) { const button=document.getElementById(id); if(button)button.disabled=!enabled; }
        const select=document.getElementById('map-select');if(select)select.disabled=!enabled;
        document.getElementById('btn-online').disabled=!enabled;
    }
    setEngineControls(false);
    let bootTimeMs = performance.now();

    let frameCount = 0;
    let lastFpsTick = performance.now();
    let frameDrawCalls = 0;
    let shownDraws = 0;

    function setStatus(msg, pct) {
        if (statusText) statusText.textContent = msg;
        if (progressBar && typeof pct === 'number') {
            progressBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
        }
    }

    function stopEngine(message) {
        engineRunning = false;
        window.Q3Lava?.setEnabled(false);
        setEngineControls(false);
        giveAllWhenActive = false;
        dmaBufferPtr = 0;
        if (document.pointerLockElement === canvas) document.exitPointerLock();
        if (statFps) statFps.textContent = 'Durduruldu';
        statusOverlay?.classList.remove('hidden');
        setStatus(message, 0);
        appendConsoleLog(`\n[Sistem] ${message}\n`);
    }

    function appendConsoleLog(text) {
        // Strip Q3 color codes (^0..^9) for clean text log
        const clean = text.replace(/\^[0-9a-zA-Z]/g, '');
        logText=(logText+clean).slice(-48000);
        if(consoleOutput) {consoleOutput.textContent=logText;consoleOutput.scrollTop=consoleOutput.scrollHeight;}
    }

    // =========================================================================
    // Virtual File System (VFS)
    // =========================================================================
    const vfsFiles = new Map();
    const openFiles = new Map();
    let nextFd = 1;
    let configStorageKey = null;

    // Keep user-owned game data locally and rebuild the engine's search paths
    // through a clean boot. A renderer restart alone cannot discover new PK3s.
    function openPackageDatabase() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open('q3wasm-game-data', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('packages', { keyPath: 'name' });
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error('Oyun verisi deposu başka bir sekmede açık.'));
        });
    }

    async function readStoredPackages() {
        const db = await openPackageDatabase();
        try {
            return await new Promise((resolve, reject) => {
                const tx = db.transaction('packages', 'readonly');
                const request = tx.objectStore('packages').getAll();
                tx.oncomplete = () => resolve(request.result);
                tx.onabort = () => reject(tx.error || new Error('PK3 okuma işlemi iptal edildi.'));
                tx.onerror = () => reject(tx.error);
            });
        } finally { db.close(); }
    }

    async function storePackages(packages) {
        const db = await openPackageDatabase();
        try {
            await new Promise((resolve, reject) => {
                const tx = db.transaction('packages', 'readwrite');
                for (const entry of packages) tx.objectStore('packages').put(entry);
                tx.oncomplete = resolve;
                tx.onabort = () => reject(tx.error || new Error('PK3 kayıt işlemi iptal edildi.'));
                tx.onerror = () => reject(tx.error);
            });
        } finally { db.close(); }
    }

    async function clearStoredPackages() {
        const db = await openPackageDatabase();
        try {
            await new Promise((resolve, reject) => {
                const tx = db.transaction('packages', 'readwrite');
                tx.objectStore('packages').clear();
                tx.oncomplete = resolve;
                tx.onabort = () => reject(tx.error || new Error('PK3 sıfırlama işlemi iptal edildi.'));
                tx.onerror = () => reject(tx.error);
            });
        } finally { db.close(); }
    }

    function updatePackageStatus() {
        const names = [...vfsFiles.keys()].filter(name => /^baseq3\/[^/]+\.pk3$/i.test(name));
        if (statPak) statPak.textContent = `${names.length} PK3`;
    }

    function normPath(p) {
        if (!p) return '';
        return p
            .replace(/\\/g, '/')
            .replace(/^(\.\/|\/)+/, '')
            .replace(/\/+/g, '/')
            .replace(/\/$/, '');
    }

    function readCStr(ptr) {
        if (!ptr || !wasmMemory) return '';
        const u8 = new Uint8Array(wasmMemory.buffer);
        let end = ptr;
        while (end < u8.length && u8[end] !== 0) end++;
        return new TextDecoder('utf-8').decode(u8.subarray(ptr, end));
    }

    function writeCStrToWasm(str) {
        const bytes = new TextEncoder().encode(str + '\0');
        const ptr = wasmExports.wasm_q3_alloc(bytes.length);
        new Uint8Array(wasmMemory.buffer, ptr, bytes.length).set(bytes);
        return ptr;
    }

    // Restore configuration only after identifying the base data package.
    // Generated fixtures must never carry their r_vertexLight/model settings
    // into the original demo or retail game.

    function vfsListFiles(dirPtr, extPtr, outPtr, maxLen) {
        const dir = normPath(readCStr(dirPtr)).toLowerCase();
        let ext = readCStr(extPtr).toLowerCase();
        if (ext && ext !== '/' && !ext.startsWith('.')) {
            ext = '.' + ext;
        }
        const prefix = dir ? dir + '/' : '';
        const matches = [];
        const seen = new Set();

        for (const k of vfsFiles.keys()) {
            const kl = k.toLowerCase();
            if (kl.startsWith(prefix)) {
                const rest = k.slice(prefix.length);
                if (!rest.includes('/')) {
                    if (!ext || rest.toLowerCase().endsWith(ext)) {
                        const rl = rest.toLowerCase();
                        if (!seen.has(rl)) {
                            seen.add(rl);
                            matches.push(rest);
                        }
                    }
                }
            }
        }

        matches.sort();
        if (maxLen <= 0) return 0;
        const out = new Uint8Array(wasmMemory.buffer, outPtr, maxLen);
        const encoder = new TextEncoder();
        let used = 0;
        let count = 0;
        for (const name of matches) {
            const encoded = encoder.encode(name + '\n');
            if (used + encoded.length >= maxLen) break;
            out.set(encoded, used);
            used += encoded.length;
            count++;
        }
        out[used] = 0;
        return count;
    }

    function vfsOpen(pathPtr, modePtr) {
        const rawPath = normPath(readCStr(pathPtr));
        const mode = readCStr(modePtr);
        let key = null;
        for (const k of vfsFiles.keys()) {
            if (k.toLowerCase() === rawPath.toLowerCase()) {
                key = k;
                break;
            }
        }

        if (mode.includes('w') || mode.includes('a')) {
            if (!key) key = rawPath;
            if (!vfsFiles.has(key) || mode.includes('w')) {
                vfsFiles.set(key, new Uint8Array(0));
            }
            const fd = nextFd++;
            openFiles.set(fd, {
                key,
                pos: mode.includes('a') ? vfsFiles.get(key).length : 0,
                writable: true,
            });
            return fd;
        } else {
            if (!key) return -1;
            const fd = nextFd++;
            openFiles.set(fd, { key, pos: 0, writable: false });
            return fd;
        }
    }

    function vfsClose(fd) {
        const f = openFiles.get(fd);
        if (f && f.writable && f.key.toLowerCase().endsWith('q3config.cfg')) {
            try {
                const data = vfsFiles.get(f.key);
                if (data && configStorageKey) {
                    localStorage.setItem(configStorageKey, new TextDecoder().decode(data));
                }
            } catch (_) {}
        }
        openFiles.delete(fd);
        return 0;
    }

    function vfsRead(fd, dstPtr, len) {
        const f = openFiles.get(fd);
        if (!f) return -1;
        const data = vfsFiles.get(f.key);
        if (!data) return -1;
        const avail = Math.max(0, data.length - f.pos);
        const toRead = Math.min(len, avail);
        if (toRead > 0) {
            new Uint8Array(wasmMemory.buffer, dstPtr, toRead).set(data.subarray(f.pos, f.pos + toRead));
            f.pos += toRead;
        }
        return toRead;
    }

    function vfsWrite(fd, srcPtr, len) {
        const f = openFiles.get(fd);
        if (!f || !f.writable) return -1;
        const old = vfsFiles.get(f.key) || new Uint8Array(0);
        const endPos = f.pos + len;
        let next = old;
        if (endPos > old.length) {
            next = new Uint8Array(endPos);
            next.set(old);
            vfsFiles.set(f.key, next);
        }
        next.set(new Uint8Array(wasmMemory.buffer, srcPtr, len), f.pos);
        f.pos = endPos;
        return len;
    }

    function vfsSeek(fd, offset, whence) {
        const f = openFiles.get(fd);
        if (!f) return -1;
        const data = vfsFiles.get(f.key);
        const len = data ? data.length : 0;
        let newPos = f.pos;
        if (whence === 0) newPos = offset;
        else if (whence === 1) newPos = f.pos + offset;
        else if (whence === 2) newPos = len + offset;
        if (newPos < 0) return -1;
        f.pos = newPos;
        return 0;
    }

    function vfsTell(fd) {
        const f = openFiles.get(fd);
        return f ? f.pos : -1;
    }

    function vfsEof(fd) {
        const f = openFiles.get(fd);
        if (!f) return 1;
        const data = vfsFiles.get(f.key);
        return (!data || f.pos >= data.length) ? 1 : 0;
    }

    function vfsRemove(pathPtr) {
        const rawPath = normPath(readCStr(pathPtr));
        for (const k of vfsFiles.keys()) {
            if (k.toLowerCase() === rawPath.toLowerCase()) {
                vfsFiles.delete(k);
                return 0;
            }
        }
        return -1;
    }

    // =========================================================================
    // WebGL2 Renderer Bridge (implements js_gl_* imports from wasm_qgl.c)
    // =========================================================================
    const gl = canvas.getContext('webgl2', {
        alpha: false,
        depth: true,
        stencil: false,
        antialias: false,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: false,
        desynchronized: true,
    });

    if (!gl) {
        setStatus('HATA: Tarayıcınız WebGL2 desteklemiyor.', 0);
        throw new Error('WebGL2 not supported');
    }

    const vsSource = `#version 300 es
    precision highp float;
    precision highp int;

    layout(location = 0) in vec3 a_pos;
    layout(location = 1) in vec2 a_uv0;
    layout(location = 2) in vec2 a_uv1;
    layout(location = 3) in vec4 a_color;

    uniform mat4 u_mvp;
    uniform mat4 u_mv;
    uniform vec4 u_clip_plane;
    uniform int u_clip_enabled;

    out vec2 v_uv0;
    out vec2 v_uv1;
    out vec4 v_color;
    out float v_clip_dist;

    void main() {
        vec4 pos4 = vec4(a_pos, 1.0);
        gl_Position = u_mvp * pos4;
        v_uv0 = a_uv0;
        v_uv1 = a_uv1;
        v_color = a_color;
        if (u_clip_enabled != 0) {
            vec4 eyePos = u_mv * pos4;
            v_clip_dist = dot(eyePos, u_clip_plane);
        } else {
            v_clip_dist = 1.0;
        }
    }
    `;

    const fsSource = `#version 300 es
    precision highp float;
    precision highp int;

    in vec2 v_uv0;
    in vec2 v_uv1;
    in vec4 v_color;
    in float v_clip_dist;

    uniform sampler2D u_tex0;
    uniform sampler2D u_tex1;
    uniform int u_tex0_enabled;
    uniform int u_tex1_enabled;
    uniform int u_tex0_has_alpha;
    uniform int u_tex1_has_alpha;
    uniform int u_tex0_env;
    uniform int u_tex1_env;
    uniform int u_alpha_test;
    uniform int u_alpha_func;
    uniform float u_alpha_ref;
    uniform int u_clip_enabled;

    out vec4 fragColor;

    vec4 applyTexEnv(int envMode, vec4 prev, vec4 tex, bool hasAlpha) {
        if (!hasAlpha) tex.a = 1.0;
        // GL_REPLACE = 0x1E01 (7681), GL_MODULATE = 0x2100 (8448),
        // GL_DECAL = 0x2101 (8449), GL_BLEND = 0x0BE2 (3042), GL_ADD = 0x0104 (260)
        if (envMode == 7681) {
            return vec4(tex.rgb, hasAlpha ? tex.a : prev.a);
        } else if (envMode == 8449) {
            return vec4(mix(prev.rgb, tex.rgb, tex.a), prev.a);
        } else if (envMode == 260) {
            return vec4(min(prev.rgb + tex.rgb, vec3(1.0)), prev.a * tex.a);
        } else if (envMode == 3042) {
            // The engine never changes GL_TEXTURE_ENV_COLOR; its default is black.
            return vec4(prev.rgb * (1.0 - tex.rgb), prev.a * tex.a);
        }
        return prev * tex;
    }

    void main() {
        if (u_clip_enabled != 0 && v_clip_dist < 0.0) {
            discard;
        }

        vec4 color = v_color;
        if (u_tex0_enabled != 0) {
            vec4 t0 = texture(u_tex0, v_uv0);
            color = applyTexEnv(u_tex0_env, color, t0, u_tex0_has_alpha != 0);
        }
        if (u_tex1_enabled != 0) {
            vec4 t1 = texture(u_tex1, v_uv1);
            color = applyTexEnv(u_tex1_env, color, t1, u_tex1_has_alpha != 0);
        }

        if (u_alpha_test != 0) {
            // GL_NEVER=512, GL_LESS=513, GL_EQUAL=514, GL_LEQUAL=515,
            // GL_GREATER=516, GL_NOTEQUAL=517, GL_GEQUAL=518, GL_ALWAYS=519
            float a = color.a;
            if (u_alpha_func == 512) discard;
            else if (u_alpha_func == 513 && !(a < u_alpha_ref)) discard;
            else if (u_alpha_func == 514 && !(abs(a - u_alpha_ref) < 0.002)) discard;
            else if (u_alpha_func == 515 && !(a <= u_alpha_ref)) discard;
            else if (u_alpha_func == 516 && !(a > u_alpha_ref)) discard;
            else if (u_alpha_func == 517 && !(abs(a - u_alpha_ref) >= 0.002)) discard;
            else if (u_alpha_func == 518 && !(a >= u_alpha_ref)) discard;
        }

        fragColor = color;
    }
    `;

    function compileShader(type, src) {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
            const message = 'Shader derleme hatası: ' + gl.getShaderInfoLog(sh);
            setStatus(message, 0);
            appendConsoleLog(`\n[WebGL] ${message}\n`);
            gl.deleteShader(sh);
            throw new Error(message);
        }
        return sh;
    }

    const prog = gl.createProgram();
    gl.attachShader(prog, compileShader(gl.VERTEX_SHADER, vsSource));
    gl.attachShader(prog, compileShader(gl.FRAGMENT_SHADER, fsSource));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        const message = 'Shader bağlama hatası: ' + gl.getProgramInfoLog(prog);
        setStatus(message, 0);
        appendConsoleLog(`\n[WebGL] ${message}\n`);
        throw new Error(message);
    }
    gl.useProgram(prog);

    const locMvp          = gl.getUniformLocation(prog, 'u_mvp');
    const locMv           = gl.getUniformLocation(prog, 'u_mv');
    const locTex0         = gl.getUniformLocation(prog, 'u_tex0');
    const locTex1         = gl.getUniformLocation(prog, 'u_tex1');
    const locTex0Enabled  = gl.getUniformLocation(prog, 'u_tex0_enabled');
    const locTex1Enabled  = gl.getUniformLocation(prog, 'u_tex1_enabled');
    const locTex0HasAlpha = gl.getUniformLocation(prog, 'u_tex0_has_alpha');
    const locTex1HasAlpha = gl.getUniformLocation(prog, 'u_tex1_has_alpha');
    const locTex0Env      = gl.getUniformLocation(prog, 'u_tex0_env');
    const locTex1Env      = gl.getUniformLocation(prog, 'u_tex1_env');
    const locAlphaTest    = gl.getUniformLocation(prog, 'u_alpha_test');
    const locAlphaFunc    = gl.getUniformLocation(prog, 'u_alpha_func');
    const locAlphaRef     = gl.getUniformLocation(prog, 'u_alpha_ref');
    const locClipEnabled  = gl.getUniformLocation(prog, 'u_clip_enabled');
    const locClipPlane    = gl.getUniformLocation(prog, 'u_clip_plane');

    gl.uniform1i(locTex0, 0);
    gl.uniform1i(locTex1, 1);

    // Vertex Array Object + Dynamic Vertex/Index Buffers
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, 8192 * 32, gl.STREAM_DRAW);

    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, 32768 * 2, gl.STREAM_DRAW);

    // WasmVertex layout: x,y,z (12B), u0,v0 (8B), u1,v1 (8B), r,g,b,a (4B) = 32B
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 32, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 32, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 32, 20);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, true, 32, 28);

    // Fallback 1x1 white texture
    const fallbackTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, fallbackTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    // =========================================================================
    // 3D In-Game Molten Lava Engine (WebGL2 True 3D World Surface)
    // =========================================================================
    const vs3dLavaSource = `#version 300 es
    precision highp float;
    layout(location = 0) in vec2 a_pos;
    layout(location = 1) in vec2 a_uv;
    uniform mat4 u_mvp;
    uniform float u_lava_z;
    uniform float u_time;
    out vec2 v_uv;
    out vec3 v_world_pos;
    out float v_wave;

    void main() {
        float wave1 = sin(a_pos.x * 0.016 + u_time * 2.2) * 2.4;
        float wave2 = cos(a_pos.y * 0.022 - u_time * 1.7) * 2.0;
        float wave3 = sin((a_pos.x + a_pos.y) * 0.01 + u_time * 1.3) * 1.6;
        float totalWave = wave1 + wave2 + wave3;

        vec3 worldPos = vec3(a_pos.x, a_pos.y, u_lava_z + totalWave);
        v_world_pos = worldPos;
        v_wave = totalWave;
        v_uv = a_uv;
        gl_Position = u_mvp * vec4(worldPos, 1.0);
    }
    `;

    const fs3dLavaSource = `#version 300 es
    precision highp float;
    precision highp int;
    in vec2 v_uv;
    in vec3 v_world_pos;
    in float v_wave;
    uniform float u_time;
    uniform sampler2D u_lava_tex;
    uniform int u_has_tex;
    out vec4 fragColor;

    void main() {
        float t = u_time * 0.55;
        vec2 uv = v_uv * 0.35;
        
        // Dynamic procedural turbulence
        float n1 = sin(uv.x * 6.0 + t * 1.3) * cos(uv.y * 6.0 - t * 1.1);
        float n2 = sin(uv.x * 12.0 - t * 1.7 + n1 * 2.0) * cos(uv.y * 12.0 + t * 1.4);
        float turb = n1 * 0.6 + n2 * 0.4;
        
        vec3 crust = vec3(0.12, 0.02, 0.01);
        vec3 magma = vec3(0.96, 0.28, 0.02);
        vec3 glow  = vec3(1.0, 0.94, 0.38);
        
        float crack = smoothstep(-0.25, 0.45, turb);
        float hot = smoothstep(0.35, 0.8, turb);
        
        vec3 color = mix(crust, magma, crack);
        color = mix(color, glow, hot);
        
        if (u_has_tex != 0) {
            vec2 scrollUv1 = v_uv * 0.4 + vec2(t * 0.04, t * 0.025);
            vec2 scrollUv2 = v_uv * 0.4 + vec2(-t * 0.03, t * 0.05);
            vec4 tex1 = texture(u_lava_tex, scrollUv1);
            vec4 tex2 = texture(u_lava_tex, scrollUv2);
            vec3 blendedTex = (tex1.rgb + tex2.rgb) * 0.65;
            color = mix(blendedTex, color, 0.42);
            color += glow * (hot * 0.35);
        }
        
        // Wave crest glow highlight
        float crest = smoothstep(1.5, 4.0, v_wave) * 0.35;
        color += vec3(1.0, 0.7, 0.2) * crest;
        
        fragColor = vec4(color, 0.96);
    }
    `;

    let prog3dLava = null;
    let loc3dMvp = null, loc3dLavaZ = null, loc3dTime = null, loc3dTex = null, loc3dHasTex = null;
    let vao3dLava = null, vbo3dLava = null, ibo3dLava = null;
    let numLavaIndices = 0;
    let lava3dTexture = null;
    let hasLavaTexLoaded = false;
    let lastWorld3dMvp = new Float32Array(16);
    let hasWorld3dMvp = false;
    let had3dWorldThisFrame = false;

    function init3dLavaPipeline() {
        try {
            prog3dLava = gl.createProgram();
            gl.attachShader(prog3dLava, compileShader(gl.VERTEX_SHADER, vs3dLavaSource));
            gl.attachShader(prog3dLava, compileShader(gl.FRAGMENT_SHADER, fs3dLavaSource));
            gl.linkProgram(prog3dLava);
            if (!gl.getProgramParameter(prog3dLava, gl.LINK_STATUS)) {
                console.error('3D Lava program link failed:', gl.getProgramInfoLog(prog3dLava));
                return;
            }
            loc3dMvp = gl.getUniformLocation(prog3dLava, 'u_mvp');
            loc3dLavaZ = gl.getUniformLocation(prog3dLava, 'u_lava_z');
            loc3dTime = gl.getUniformLocation(prog3dLava, 'u_time');
            loc3dTex = gl.getUniformLocation(prog3dLava, 'u_lava_tex');
            loc3dHasTex = gl.getUniformLocation(prog3dLava, 'u_has_tex');

            vao3dLava = gl.createVertexArray();
            gl.bindVertexArray(vao3dLava);

            const GRID_SIZE = 96;
            const WORLD_HALF = 8192.0;
            const verts = new Float32Array((GRID_SIZE + 1) * (GRID_SIZE + 1) * 4);
            const indices = new Uint16Array(GRID_SIZE * GRID_SIZE * 6);

            let vIdx = 0;
            for (let j = 0; j <= GRID_SIZE; j++) {
                const y = -WORLD_HALF + (j / GRID_SIZE) * (WORLD_HALF * 2.0);
                const v = y / 256.0;
                for (let i = 0; i <= GRID_SIZE; i++) {
                    const x = -WORLD_HALF + (i / GRID_SIZE) * (WORLD_HALF * 2.0);
                    const u = x / 256.0;
                    verts[vIdx++] = x;
                    verts[vIdx++] = y;
                    verts[vIdx++] = u;
                    verts[vIdx++] = v;
                }
            }

            let iIdx = 0;
            for (let j = 0; j < GRID_SIZE; j++) {
                for (let i = 0; i < GRID_SIZE; i++) {
                    const r1 = j * (GRID_SIZE + 1) + i;
                    const r2 = (j + 1) * (GRID_SIZE + 1) + i;
                    indices[iIdx++] = r1;
                    indices[iIdx++] = r2;
                    indices[iIdx++] = r1 + 1;
                    indices[iIdx++] = r1 + 1;
                    indices[iIdx++] = r2;
                    indices[iIdx++] = r2 + 1;
                }
            }
            numLavaIndices = indices.length;

            vbo3dLava = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, vbo3dLava);
            gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);

            ibo3dLava = gl.createBuffer();
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo3dLava);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

            gl.enableVertexAttribArray(0);
            gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0); // a_pos (x, y)
            gl.enableVertexAttribArray(1);
            gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8); // a_uv (u, v)

            gl.bindVertexArray(vao); // Restore Quake 3 VAO

            // Procedural fallback magma texture
            lava3dTexture = gl.createTexture();
            const fb = new Uint8Array(64 * 64 * 4);
            for (let p = 0; p < 64 * 64; p++) {
                const px = p % 64, py = Math.floor(p / 64);
                const n = Math.sin(px * 0.2) * Math.cos(py * 0.2);
                fb[p * 4] = Math.floor(220 + n * 35);
                fb[p * 4 + 1] = Math.floor(65 + n * 35);
                fb[p * 4 + 2] = 10;
                fb[p * 4 + 3] = 255;
            }
            gl.bindTexture(gl.TEXTURE_2D, lava3dTexture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 64, 64, 0, gl.RGBA, gl.UNSIGNED_BYTE, fb);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
        } catch (e) {
            console.error('Failed to init 3D lava pipeline:', e);
        }
    }

    async function loadLavaTextureFromPak0(pak0Bytes) {
        if (!pak0Bytes || hasLavaTexLoaded || !gl || !lava3dTexture) return;
        try {
            const view = new DataView(pak0Bytes.buffer, pak0Bytes.byteOffset, pak0Bytes.byteLength);
            let end = -1;
            for (let o = pak0Bytes.length - 22; o >= Math.max(0, pak0Bytes.length - 65557); o--) {
                if (view.getUint32(o, true) === 0x06054b50) { end = o; break; }
            }
            if (end < 0) return;
            const count = view.getUint16(end + 10, true);
            let cur = view.getUint32(end + 16, true);
            const dec = new TextDecoder('utf-8');
            for (let i = 0; i < count; i++) {
                const nameLen = view.getUint16(cur + 28, true);
                const extraLen = view.getUint16(cur + 30, true);
                const commentLen = view.getUint16(cur + 32, true);
                const compSize = view.getUint32(cur + 20, true);
                const method = view.getUint16(cur + 10, true);
                const local = view.getUint32(cur + 42, true);
                const name = dec.decode(pak0Bytes.subarray(cur + 46, cur + 46 + nameLen)).toLowerCase();
                if (name === 'textures/liquids/lavahell.jpg') {
                    const nlen = view.getUint16(local + 26, true);
                    const elen = view.getUint16(local + 28, true);
                    const raw = pak0Bytes.subarray(local + 30 + nlen + elen, local + 30 + nlen + elen + compSize);
                    let jpegBytes = raw;
                    if (method === 8) {
                        const ds = new DecompressionStream('deflate-raw');
                        const resp = new Response(new Response(raw).body.pipeThrough(ds));
                        jpegBytes = new Uint8Array(await resp.arrayBuffer());
                    }
                    const blob = new Blob([jpegBytes], { type: 'image/jpeg' });
                    const img = await createImageBitmap(blob);
                    gl.bindTexture(gl.TEXTURE_2D, lava3dTexture);
                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
                    gl.generateMipmap(gl.TEXTURE_2D);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
                    hasLavaTexLoaded = true;
                    break;
                }
                cur += 46 + nameLen + extraLen + commentLen;
            }
        } catch (err) {
            console.warn('Lava texture load notice:', err);
        }
    }

    function render3dLava(mvpPtr) {
        if (!window.Q3Lava?.isEnabled() || !window.Q3Lava?.hasStarted() || !prog3dLava || !vao3dLava) return;
        const lavaZ = window.Q3Lava.getCurrentZ();
        if (lavaZ < -900) return;

        ensureMemoryViews();
        let targetMvp = null;
        if (mvpPtr && f32Mem) {
            targetMvp = f32Mem.subarray(mvpPtr >> 2, (mvpPtr >> 2) + 16);
            lastWorld3dMvp.set(targetMvp);
            hasWorld3dMvp = true;
        } else if (wasmExports?.wasm_q3_world_mvp && f32Mem) {
            const ptr = wasmExports.wasm_q3_world_mvp();
            if (ptr) {
                targetMvp = f32Mem.subarray(ptr >> 2, (ptr >> 2) + 16);
                lastWorld3dMvp.set(targetMvp);
                hasWorld3dMvp = true;
            }
        }
        if (!targetMvp && hasWorld3dMvp) {
            targetMvp = lastWorld3dMvp;
        }
        if (!targetMvp) return;

        // Lazy load pak0 texture if not loaded yet
        if (!hasLavaTexLoaded && vfsFiles && vfsFiles.has('baseq3/pak0.pk3')) {
            try { loadLavaTextureFromPak0(vfsFiles.get('baseq3/pak0.pk3')); } catch (_) {}
        }

        gl.useProgram(prog3dLava);
        gl.bindVertexArray(vao3dLava);

        gl.uniformMatrix4fv(loc3dMvp, false, targetMvp);
        gl.uniform1f(loc3dLavaZ, lavaZ);
        gl.uniform1f(loc3dTime, performance.now() * 0.001);
        gl.uniform1i(loc3dHasTex, hasLavaTexLoaded ? 1 : 0);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, lava3dTexture);
        gl.uniform1i(loc3dTex, 0);

        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.depthMask(true);
        gl.depthRange(0.0, 1.0);
        gl.disable(gl.CULL_FACE);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        gl.drawElements(gl.TRIANGLES, numLavaIndices, gl.UNSIGNED_SHORT, 0);

        // Invalidate GL state cache so Quake 3 restores its expected pipeline states
        stDepthTest = -1;
        stDepthFunc = -1;
        stDepthMask = -1;
        stDepthNear = -1;
        stDepthFar = -1;
        stBlend = -1;
        stSrc = -1;
        stDst = -1;
        stCull = -1;
        stCullFace = -1;

        // Restore Quake 3 state
        gl.useProgram(prog);
        gl.bindVertexArray(vao);
        boundTex0 = null;
        boundTex1 = null;
        unifTex0Enabled = -1;
        unifTex1Enabled = -1;
        unifTex0HasAlpha = -1;
        unifTex1HasAlpha = -1;
        unifTex0Env = -1;
        unifTex1Env = -1;
        unifAlphaTest = -1;
        unifClipEnabled = -1;
    }
    init3dLavaPipeline();

    const glTextures = new Map();
    const textureHasAlpha = new Map();

    function getOrCreateTexture(texId) {
        let tex = glTextures.get(texId);
        if (!tex) {
            tex = gl.createTexture();
            glTextures.set(texId, tex);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
        }
        return tex;
    }

    function jsGlInit(wPtr, hPtr) {
        const i32 = new Int32Array(wasmMemory.buffer);
        i32[wPtr >> 2] = canvas.width;
        i32[hPtr >> 2] = canvas.height;
        gl.viewport(0, 0, canvas.width, canvas.height);
    }

    function jsGlViewport(x, y, w, h) {
        gl.viewport(x, y, w, h);
    }

    function jsGlScissor(enabled, x, y, w, h) {
        if (enabled) {
            gl.enable(gl.SCISSOR_TEST);
            gl.scissor(x, y, w, h);
        } else {
            gl.disable(gl.SCISSOR_TEST);
        }
    }

    function jsGlClear(mask, r, g, b, a, depth, stencil) {
        if (mask & 0x0100) {
            had3dWorldThisFrame = false;
        }
        gl.clearColor(r, g, b, a);
        gl.clearDepth(depth);
        gl.clearStencil(stencil);
        let bits = 0;
        if (mask & 0x4000) bits |= gl.COLOR_BUFFER_BIT;
        if (mask & 0x0100) bits |= gl.DEPTH_BUFFER_BIT;
        if (mask & 0x0400) bits |= gl.STENCIL_BUFFER_BIT;
        if (bits) gl.clear(bits);
    }

    let stBlend = -1, stSrc = -1, stDst = -1;
    let stDepthTest = -1, stDepthFunc = -1, stDepthMask = -1;
    let stCull = -1, stCullFace = -1;
    let stPolyOffset = -1, stPolyFactor = -1, stPolyUnits = -1;
    let stColorMask = -1;
    let stDepthNear = -1, stDepthFar = -1;

    function jsGlState(
        blendEnabled, srcFactor, dstFactor,
        depthTest, depthFunc, depthMask,
        cullEnabled, cullFace,
        polyOffsetEnabled, polyFactor, polyUnits,
        colorMaskR, colorMaskG, colorMaskB, colorMaskA,
        depthNear, depthFar
    ) {
        if (blendEnabled !== stBlend || srcFactor !== stSrc || dstFactor !== stDst) {
            stBlend = blendEnabled; stSrc = srcFactor; stDst = dstFactor;
            if (blendEnabled) {
                gl.enable(gl.BLEND);
                gl.blendFunc(srcFactor, dstFactor);
            } else {
                gl.disable(gl.BLEND);
            }
        }

        if (depthTest !== stDepthTest || depthFunc !== stDepthFunc) {
            stDepthTest = depthTest; stDepthFunc = depthFunc;
            if (depthTest) {
                gl.enable(gl.DEPTH_TEST);
                gl.depthFunc(depthFunc);
            } else {
                gl.disable(gl.DEPTH_TEST);
            }
        }
        if (depthMask !== stDepthMask) {
            stDepthMask = depthMask;
            gl.depthMask(!!depthMask);
        }
        if (depthNear !== stDepthNear || depthFar !== stDepthFar) {
            stDepthNear = depthNear; stDepthFar = depthFar;
            gl.depthRange(depthNear, depthFar);
        }

        if (cullEnabled !== stCull || cullFace !== stCullFace) {
            stCull = cullEnabled; stCullFace = cullFace;
            if (cullEnabled) {
                gl.enable(gl.CULL_FACE);
                gl.cullFace(cullFace);
            } else {
                gl.disable(gl.CULL_FACE);
            }
        }

        if (polyOffsetEnabled !== stPolyOffset || polyFactor !== stPolyFactor || polyUnits !== stPolyUnits) {
            stPolyOffset = polyOffsetEnabled; stPolyFactor = polyFactor; stPolyUnits = polyUnits;
            if (polyOffsetEnabled) {
                gl.enable(gl.POLYGON_OFFSET_FILL);
                gl.polygonOffset(polyFactor, polyUnits);
            } else {
                gl.disable(gl.POLYGON_OFFSET_FILL);
            }
        }

        const cMask = (colorMaskR ? 1 : 0) | (colorMaskG ? 2 : 0) | (colorMaskB ? 4 : 0) | (colorMaskA ? 8 : 0);
        if (cMask !== stColorMask) {
            stColorMask = cMask;
            gl.colorMask(!!colorMaskR, !!colorMaskG, !!colorMaskB, !!colorMaskA);
        }
    }

    function jsGlTexImage2D(texId, level, internalFormat, width, height, pixelsPtr) {
        if (texId <= 0 || width <= 0 || height <= 0) return;
        const tex = getOrCreateTexture(texId);
        // Desktop GL's RGB storage ignores the supplied RGBA alpha channel.
        if (level === 0) textureHasAlpha.set(texId, ![3, 0x1907, 0x804F, 0x8050, 0x8051].includes(internalFormat));
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        const byteLen = width * height * 4;
        const pixels = pixelsPtr ? new Uint8Array(wasmMemory.buffer, pixelsPtr, byteLen) : null;
        gl.texImage2D(gl.TEXTURE_2D, level, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    }

    function jsGlTexSubImage2D(texId, level, xoff, yoff, width, height, pixelsPtr) {
        if (texId <= 0 || width <= 0 || height <= 0 || !pixelsPtr) return;
        const tex = getOrCreateTexture(texId);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        const pixels = new Uint8Array(wasmMemory.buffer, pixelsPtr, width * height * 4);
        gl.texSubImage2D(gl.TEXTURE_2D, level, xoff, yoff, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    }

    function jsGlTexParameter(texId, pname, param) {
        if (texId <= 0) return;
        const tex = getOrCreateTexture(texId);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        if (pname === 0x2800 || pname === 0x2801 || pname === 0x2802 || pname === 0x2803) {
            // Map desktop GL_CLAMP (0x2900) to WebGL2 GL_CLAMP_TO_EDGE (0x812F)
            const mappedParam = (param === 0x2900) ? 0x812F : param;
            gl.texParameteri(gl.TEXTURE_2D, pname, mappedParam);
        }
    }

    function jsGlDeleteTexture(texId) {
        const tex = glTextures.get(texId);
        if (tex) {
            gl.deleteTexture(tex);
            glTextures.delete(texId);
            textureHasAlpha.delete(texId);
        }
    }

    let lastMemBuf = null;
    let u8Mem = null;
    let u16Mem = null;
    let f32Mem = null;

    function ensureMemoryViews() {
        if (!wasmMemory) return;
        if (wasmMemory.buffer !== lastMemBuf) {
            lastMemBuf = wasmMemory.buffer;
            u8Mem = new Uint8Array(lastMemBuf);
            u16Mem = new Uint16Array(lastMemBuf);
            f32Mem = new Float32Array(lastMemBuf);
        }
    }

    let unifTex0Enabled = -1, unifTex1Enabled = -1;
    let unifTex0HasAlpha = -1, unifTex1HasAlpha = -1;
    let unifTex0Env = -1, unifTex1Env = -1;
    let unifAlphaTest = -1, unifAlphaFunc = -1, unifAlphaRef = -1;
    let unifClipEnabled = -1;
    let boundTex0 = null, boundTex1 = null;

    function jsGlDraw(
        mode,
        vertsPtr, numVerts,
        indicesPtr, numIndices,
        mvpPtr, mvPtr,
        tex0Id, tex1Id,
        tex0Enabled, tex1Enabled,
        tex0Env, tex1Env,
        alphaTestEnabled, alphaFunc, alphaRef,
        clipPlaneEnabled, clipPlanePtr
    ) {
        if (numVerts <= 0 || numIndices <= 0) return;
        ensureMemoryViews();

        gl.uniformMatrix4fv(locMvp, false, f32Mem, mvpPtr >> 2, 16);
        gl.uniformMatrix4fv(locMv, false, f32Mem, mvPtr >> 2, 16);

        if (tex0Enabled !== unifTex0Enabled) {
            unifTex0Enabled = tex0Enabled;
            gl.uniform1i(locTex0Enabled, tex0Enabled);
        }
        if (tex1Enabled !== unifTex1Enabled) {
            unifTex1Enabled = tex1Enabled;
            gl.uniform1i(locTex1Enabled, tex1Enabled);
        }

        const hasAlpha0 = textureHasAlpha.get(tex0Id) === false ? 0 : 1;
        if (hasAlpha0 !== unifTex0HasAlpha) {
            unifTex0HasAlpha = hasAlpha0;
            gl.uniform1i(locTex0HasAlpha, hasAlpha0);
        }

        const hasAlpha1 = textureHasAlpha.get(tex1Id) === false ? 0 : 1;
        if (hasAlpha1 !== unifTex1HasAlpha) {
            unifTex1HasAlpha = hasAlpha1;
            gl.uniform1i(locTex1HasAlpha, hasAlpha1);
        }

        if (tex0Env !== unifTex0Env) {
            unifTex0Env = tex0Env;
            gl.uniform1i(locTex0Env, tex0Env);
        }
        if (tex1Env !== unifTex1Env) {
            unifTex1Env = tex1Env;
            gl.uniform1i(locTex1Env, tex1Env);
        }

        if (alphaTestEnabled !== unifAlphaTest) {
            unifAlphaTest = alphaTestEnabled;
            gl.uniform1i(locAlphaTest, alphaTestEnabled);
        }
        if (alphaFunc !== unifAlphaFunc) {
            unifAlphaFunc = alphaFunc;
            gl.uniform1i(locAlphaFunc, alphaFunc);
        }
        if (alphaRef !== unifAlphaRef) {
            unifAlphaRef = alphaRef;
            gl.uniform1f(locAlphaRef, alphaRef);
        }

        if (clipPlaneEnabled !== unifClipEnabled) {
            unifClipEnabled = clipPlaneEnabled;
            gl.uniform1i(locClipEnabled, clipPlaneEnabled);
        }
        if (clipPlaneEnabled && clipPlanePtr) {
            gl.uniform4fv(locClipPlane, f32Mem, clipPlanePtr >> 2, 4);
        }

        const targetTex0 = (tex0Enabled && glTextures.get(tex0Id)) || fallbackTex;
        if (targetTex0 !== boundTex0) {
            boundTex0 = targetTex0;
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, targetTex0);
        }

        const targetTex1 = (tex1Enabled && glTextures.get(tex1Id)) || fallbackTex;
        if (targetTex1 !== boundTex1) {
            boundTex1 = targetTex1;
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, targetTex1);
        }

        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, u8Mem, vertsPtr, numVerts * 32);

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
        gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, u16Mem, indicesPtr >> 1, numIndices);

        gl.drawElements(mode, numIndices, gl.UNSIGNED_SHORT, 0);
        frameDrawCalls++;
    }

    function jsGlEndFrame() {
        shownDraws = frameDrawCalls;
        frameDrawCalls = 0;
    }

    // =========================================================================
    // WebAudio DMA Streamer (22050 Hz 16-bit Stereo Ring Buffer)
    // =========================================================================
    let audioCtx = null;
    let scriptNode = null;
    let dmaSpeed = 22050;
    let dmaChannels = 2;
    let dmaSamples = 16384; // mono samples (8192 stereo frames)
    let dmaBufferPtr = 0;
    let dmaStartTime = 0;
    let audioSampleCursor = 0.0;
    let audioFramesPlayed = 0;
    let audioPeakMax = 0;

    function ensureAudioUnlocked() {
        if (!audioCtx && dmaBufferPtr) {
            try {
                const AudioContextClass = window.AudioContext || window.webkitAudioContext;
                audioCtx = new AudioContextClass();
                const stereoFrames = dmaSamples >> 1;
                const ratio = dmaSpeed / audioCtx.sampleRate;

                scriptNode = audioCtx.createScriptProcessor(4096, 0, 2);
                scriptNode.onaudioprocess = (ev) => {
                    const outL = ev.outputBuffer.getChannelData(0);
                    const outR = ev.outputBuffer.getChannelData(1);
                    if (!wasmMemory || !dmaBufferPtr) {
                        outL.fill(0);
                        outR.fill(0);
                        return;
                    }
                    const pcm16 = new Int16Array(wasmMemory.buffer, dmaBufferPtr, dmaSamples);
                    const len = outL.length;
                    for (let i = 0; i < len; i++) {
                        const f0 = Math.floor(audioSampleCursor);
                        const frac = audioSampleCursor - f0;
                        const idx0 = (f0 & (stereoFrames - 1)) * 2;
                        const idx1 = ((f0 + 1) & (stereoFrames - 1)) * 2;

                        // Linear interpolation between consecutive samples (eliminates aliasing crackle and buzzing)
                        const s0L = pcm16[idx0],     s0R = pcm16[idx0 + 1];
                        const s1L = pcm16[idx1],     s1R = pcm16[idx1 + 1];
                        let valL = (s0L + (s1L - s0L) * frac) / 32768.0;
                        let valR = (s0R + (s1R - s0R) * frac) / 32768.0;

                        // Soft limiter to prevent digital clipping
                        if (valL > 1.0) valL = 1.0; else if (valL < -1.0) valL = -1.0;
                        if (valR > 1.0) valR = 1.0; else if (valR < -1.0) valR = -1.0;

                        outL[i] = valL;
                        outR[i] = valR;
                        audioPeakMax = Math.max(audioPeakMax, Math.abs(valL), Math.abs(valR));

                        audioSampleCursor += ratio;
                        if (audioSampleCursor >= stereoFrames) {
                            audioSampleCursor -= stereoFrames;
                        }
                    }
                    audioFramesPlayed += len;
                };
                scriptNode.connect(audioCtx.destination);
            } catch (_) {}
        }
        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume().catch(() => {});
        }
    }

    function jsAudioInit(speed, channels, samplebits, samples, bufferPtr) {
        dmaSpeed = speed || 22050;
        dmaChannels = channels || 2;
        dmaSamples = samples || 16384;
        dmaBufferPtr = bufferPtr;
        dmaStartTime = performance.now();
        audioSampleCursor = 0.0;
    }

    function jsAudioGetDmaPos() {
        if (!dmaBufferPtr) return 0;
        if (audioCtx && audioCtx.state === 'running') {
            return (Math.floor(audioSampleCursor) * dmaChannels) & (dmaSamples - 1);
        }
        const elapsedSec = (performance.now() - dmaStartTime) / 1000.0;
        const stereoFrame = Math.floor(elapsedSec * dmaSpeed);
        return (stereoFrame * dmaChannels) & (dmaSamples - 1);
    }

    function jsAudioSubmit() {}

    function jsAudioShutdown() {
        dmaBufferPtr = 0;
    }

    // =========================================================================
    // Keyboard & Mouse Input Mapping
    // =========================================================================
    function nowQ3Time() {
        return Math.max(1, Math.floor(performance.now() - bootTimeMs));
    }

    function mapDomKeyToQ3(e) {
        switch (e.code) {
            case 'Tab':          return K_TAB;
            case 'Enter':
            case 'NumpadEnter':  return K_ENTER;
            case 'Escape':       return K_ESCAPE;
            case 'Space':        return K_SPACE;
            case 'Backspace':    return K_BACKSPACE;
            case 'CapsLock':     return K_CAPSLOCK;
            case 'Pause':        return K_PAUSE;
            case 'ArrowUp':      return K_UPARROW;
            case 'ArrowDown':    return K_DOWNARROW;
            case 'ArrowLeft':    return K_LEFTARROW;
            case 'ArrowRight':   return K_RIGHTARROW;
            case 'AltLeft':
            case 'AltRight':     return K_ALT;
            case 'ControlLeft':
            case 'ControlRight': return K_CTRL;
            case 'ShiftLeft':
            case 'ShiftRight':   return K_SHIFT;
            case 'Insert':       return K_INS;
            case 'Delete':       return K_DEL;
            case 'PageDown':     return K_PGDN;
            case 'PageUp':       return K_PGUP;
            case 'Home':         return K_HOME;
            case 'End':          return K_END;
            case 'Backquote':    return 96; // '`' console toggle
            default: break;
        }
        if (e.code && e.code.startsWith('F')) {
            const fn = parseInt(e.code.slice(1), 10);
            if (fn >= 1 && fn <= 12) return K_F1 + (fn - 1);
        }
        // Bind movement to physical keys, independently of layout and Shift.
        if (/^Key[A-Z]$/.test(e.code)) return e.code.charCodeAt(3) + 32;
        if (/^Digit[0-9]$/.test(e.code)) return e.code.charCodeAt(5);
        if (e.key && e.key.length === 1) {
            const ch = e.key.toLowerCase().charCodeAt(0);
            if (ch >= 32 && ch <= 126) return ch;
        }
        return 0;
    }

    let updateTouchVisibility = () => {};

    function setupInputHandlers() {
        const heldInputs = new Map();
        const mouseButtons = [K_MOUSE1, K_MOUSE3, K_MOUSE2, K_MOUSE4, K_MOUSE5];
        const ownsKeyboard = () => document.activeElement === canvas || document.pointerLockElement === canvas;

        function pressInput(id, key) {
            if (!key || !engineRunning || heldInputs.has(id)) return;
            const alreadyDown = [...heldInputs.values()].includes(key);
            heldInputs.set(id, key);
            if (!alreadyDown) wasmExports.wasm_q3_key_event(key, 1, nowQ3Time());
        }

        function releaseInput(id) {
            const key = heldInputs.get(id);
            if (key === undefined) return;
            heldInputs.delete(id);
            if (engineRunning && ![...heldInputs.values()].includes(key)) {
                wasmExports.wasm_q3_key_event(key, 0, nowQ3Time());
            }
        }

        function releaseAllInputs() {
            for (const id of [...heldInputs.keys()]) releaseInput(id);
            lastClientX = lastClientY = null;
            resetTouchControls();
        }

        window.addEventListener('blur', releaseAllInputs);
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) releaseAllInputs();
        });
        document.addEventListener('pointerlockchange', releaseAllInputs);
        canvas.addEventListener('blur', releaseAllInputs);

        window.addEventListener('keydown', (e) => {
            if (!ownsKeyboard() || !engineRunning || e.isComposing) return;
            ensureAudioUnlocked();

            const q3Key = mapDomKeyToQ3(e);
            const t = nowQ3Time();
            if (q3Key && wasmExports) {
                e.preventDefault();
                pressInput(e.code || e.key, q3Key);
            }
            if (e.key === 'Backspace' && wasmExports) {
                wasmExports.wasm_q3_char_event(8, t);
            } else if (e.key && e.key.length === 1 && !e.ctrlKey && !e.altKey && e.code !== 'Backquote' && wasmExports) {
                const code = e.key.charCodeAt(0);
                if (code >= 32 && code <= 126) {
                    wasmExports.wasm_q3_char_event(code, t);
                }
            }
        });

        window.addEventListener('keyup', (e) => {
            const id = e.code || e.key;
            if (heldInputs.has(id)) e.preventDefault();
            releaseInput(id);
        });

        let lastClientX = null;
        let lastClientY = null;

        canvas.addEventListener('mousemove', (e) => {
            if (!wasmExports || document.pointerLockElement !== canvas) return;
            let dx = e.movementX;
            let dy = e.movementY;
            if (document.pointerLockElement !== canvas) {
                if (lastClientX !== null && lastClientY !== null) {
                    dx = e.clientX - lastClientX;
                    dy = e.clientY - lastClientY;
                } else {
                    dx = 0;
                    dy = 0;
                }
                lastClientX = e.clientX;
                lastClientY = e.clientY;
            }
            if (dx !== 0 || dy !== 0) {
                wasmExports.wasm_q3_mouse_event(dx | 0, dy | 0, nowQ3Time());
            }
        });

        canvas.addEventListener('mousedown', (e) => {
            ensureAudioUnlocked();
            canvas.focus();
            if (!engineRunning || !wasmExports.wasm_q3_client_active()) return;
            if(document.pointerLockElement!==canvas) {if(e.button===0)lockGamePointer();return;}
            pressInput(`mouse:${e.button}`, mouseButtons[e.button]);
        });

        window.addEventListener('mouseup', (e) => {
            releaseInput(`mouse:${e.button}`);
        });

        canvas.addEventListener('contextmenu', (e) => e.preventDefault());

        canvas.addEventListener('wheel', (e) => {
            if (!engineRunning || e.deltaY === 0) return;
            e.preventDefault();
            const wheelKey = e.deltaY < 0 ? K_MWHEELUP : K_MWHEELDOWN;
            const t = nowQ3Time();
            wasmExports.wasm_q3_key_event(wheelKey, 1, t);
            wasmExports.wasm_q3_key_event(wheelKey, 0, t);
        }, { passive: false });

        // ---------------------------------------------------------------------
        // Touch Controls (Mobile & Tablet)
        // ---------------------------------------------------------------------
        const touchControlsEl = document.getElementById('touch-controls');
        const touchToggleBtn = document.getElementById('btn-touch-toggle');
        const touchZoneMove = document.getElementById('touch-zone-move');
        const touchZoneLook = document.getElementById('touch-zone-look');
        const touchStickBase = document.getElementById('touch-stick-base');
        const touchStickThumb = document.getElementById('touch-stick-thumb');

        const btnFire = document.getElementById('touch-btn-fire');
        const btnJump = document.getElementById('touch-btn-jump');
        const btnCrouch = document.getElementById('touch-btn-crouch');
        const btnWeapon = document.getElementById('touch-btn-weapon');
        const btnEsc = document.getElementById('touch-btn-esc');
        const btnTab = document.getElementById('touch-btn-tab');

        const isTouchDevice = ('ontouchstart' in window) ||
            (navigator.maxTouchPoints > 0) ||
            (navigator.msMaxTouchPoints > 0) ||
            (window.matchMedia && (window.matchMedia('(pointer: coarse)').matches || window.matchMedia('(any-pointer: coarse)').matches)) ||
            /iPad|iPhone|iPod|Android|Mobile/i.test(navigator.userAgent) ||
            (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        const storedTouchPref = localStorage.getItem('q3_touch_controls');
        let touchEnabled = storedTouchPref !== null ? storedTouchPref === '1' : isTouchDevice;

        function updateTouchState() {
            if (!touchControlsEl) return;
            touchControlsEl.hidden = !touchEnabled;
            if (touchToggleBtn) {
                touchToggleBtn.classList.toggle('active', touchEnabled);
                const title = touchEnabled ? 'Dokunmatik kontrolleri gizle' : 'Dokunmatik kontrolleri göster';
                touchToggleBtn.title = title;
                touchToggleBtn.setAttribute('aria-label', title);
            }
        }
        updateTouchVisibility = updateTouchState;
        updateTouchState();

        touchToggleBtn?.addEventListener('click', (e) => {
            e.preventDefault();
            touchEnabled = !touchEnabled;
            try { localStorage.setItem('q3_touch_controls', touchEnabled ? '1' : '0'); } catch (_) {}
            updateTouchState();
            if (!touchEnabled) resetTouchControls();
        });

        let moveTouchId = null;
        let moveStartX = 0;
        let moveStartY = 0;
        const maxStickRadius = 45;
        const stickDeadZone = 12;

        let lookTouchId = null;
        let lookLastX = 0;
        let lookLastY = 0;

        let fireTouchId = null;
        let fireLastX = 0;
        let fireLastY = 0;

        function resetTouchControls() {
            if (touchStickThumb) touchStickThumb.style.transform = 'translate(0px, 0px)';
            if (touchStickBase) {
                touchStickBase.style.left = '30px';
                touchStickBase.style.bottom = '30px';
                touchStickBase.style.top = 'auto';
                touchStickBase.style.opacity = '0.75';
            }
            releaseInput('touch:W');
            releaseInput('touch:S');
            releaseInput('touch:A');
            releaseInput('touch:D');
            releaseInput('touch:jump');
            releaseInput('touch:crouch');
            releaseInput('touch:fire');
            releaseInput('touch:tab');
            btnFire?.classList.remove('active');
            btnJump?.classList.remove('active');
            btnCrouch?.classList.remove('active');
            btnWeapon?.classList.remove('active');
            btnEsc?.classList.remove('active');
            btnTab?.classList.remove('active');
            moveTouchId = null;
            lookTouchId = null;
            fireTouchId = null;
        }

        // --- Move Zone (Virtual Analog Stick) ---
        if (touchZoneMove) {
            touchZoneMove.addEventListener('touchstart', (e) => {
                e.preventDefault();
                ensureAudioUnlocked();
                if (moveTouchId !== null) return;
                const touch = e.changedTouches[0];
                moveTouchId = touch.identifier;
                const rect = touchZoneMove.getBoundingClientRect();
                moveStartX = touch.clientX - rect.left;
                moveStartY = touch.clientY - rect.top;
                if (touchStickBase) {
                    touchStickBase.style.left = `${moveStartX - 60}px`;
                    touchStickBase.style.top = `${moveStartY - 60}px`;
                    touchStickBase.style.bottom = 'auto';
                    touchStickBase.style.opacity = '1';
                }
                if (touchStickThumb) {
                    touchStickThumb.style.transform = 'translate(0px, 0px)';
                }
            }, { passive: false });

            window.addEventListener('touchmove', (e) => {
                if (moveTouchId === null) return;
                let touch = null;
                for (let i = 0; i < e.changedTouches.length; i++) {
                    if (e.changedTouches[i].identifier === moveTouchId) {
                        touch = e.changedTouches[i];
                        break;
                    }
                }
                if (!touch) return;
                e.preventDefault();
                const rect = touchZoneMove.getBoundingClientRect();
                const curX = touch.clientX - rect.left;
                const curY = touch.clientY - rect.top;
                const dx = curX - moveStartX;
                const dy = curY - moveStartY;
                const dist = Math.hypot(dx, dy);

                let thumbX = dx;
                let thumbY = dy;
                if (dist > maxStickRadius) {
                    thumbX = (dx / dist) * maxStickRadius;
                    thumbY = (dy / dist) * maxStickRadius;
                }
                if (touchStickThumb) {
                    touchStickThumb.style.transform = `translate(${thumbX}px, ${thumbY}px)`;
                }

                // Map to WASD
                if (dy < -stickDeadZone) pressInput('touch:W', 119); else releaseInput('touch:W');
                if (dy > stickDeadZone) pressInput('touch:S', 115); else releaseInput('touch:S');
                if (dx < -stickDeadZone) pressInput('touch:A', 97); else releaseInput('touch:A');
                if (dx > stickDeadZone) pressInput('touch:D', 100); else releaseInput('touch:D');
            }, { passive: false });

            const onMoveEnd = (e) => {
                if (moveTouchId === null) return;
                let found = false;
                for (let i = 0; i < e.changedTouches.length; i++) {
                    if (e.changedTouches[i].identifier === moveTouchId) {
                        found = true;
                        break;
                    }
                }
                if (!found) return;
                if (touchStickThumb) touchStickThumb.style.transform = 'translate(0px, 0px)';
                if (touchStickBase) {
                    touchStickBase.style.left = '30px';
                    touchStickBase.style.bottom = '30px';
                    touchStickBase.style.top = 'auto';
                    touchStickBase.style.opacity = '0.75';
                }
                releaseInput('touch:W');
                releaseInput('touch:S');
                releaseInput('touch:A');
                releaseInput('touch:D');
                moveTouchId = null;
            };

            window.addEventListener('touchend', onMoveEnd);
            window.addEventListener('touchcancel', onMoveEnd);
        }

        // --- Look Zone (Camera Swipe) ---
        if (touchZoneLook) {
            touchZoneLook.addEventListener('touchstart', (e) => {
                e.preventDefault();
                ensureAudioUnlocked();
                if (lookTouchId !== null) return;
                const touch = e.changedTouches[0];
                lookTouchId = touch.identifier;
                lookLastX = touch.clientX;
                lookLastY = touch.clientY;
            }, { passive: false });

            window.addEventListener('touchmove', (e) => {
                if (lookTouchId === null) return;
                let touch = null;
                for (let i = 0; i < e.changedTouches.length; i++) {
                    if (e.changedTouches[i].identifier === lookTouchId) {
                        touch = e.changedTouches[i];
                        break;
                    }
                }
                if (!touch) return;
                e.preventDefault();
                const dx = touch.clientX - lookLastX;
                const dy = touch.clientY - lookLastY;
                lookLastX = touch.clientX;
                lookLastY = touch.clientY;
                if ((dx !== 0 || dy !== 0) && wasmExports && engineRunning) {
                    wasmExports.wasm_q3_mouse_event(Math.round(dx * 2.2), Math.round(dy * 2.2), nowQ3Time());
                }
            }, { passive: false });

            const onLookEnd = (e) => {
                if (lookTouchId === null) return;
                for (let i = 0; i < e.changedTouches.length; i++) {
                    if (e.changedTouches[i].identifier === lookTouchId) {
                        lookTouchId = null;
                        break;
                    }
                }
            };

            window.addEventListener('touchend', onLookEnd);
            window.addEventListener('touchcancel', onLookEnd);
        }

        // --- Fire Button (Primary attack + look swipe) ---
        if (btnFire) {
            btnFire.addEventListener('touchstart', (e) => {
                e.preventDefault();
                ensureAudioUnlocked();
                const touch = e.changedTouches[0];
                fireTouchId = touch.identifier;
                fireLastX = touch.clientX;
                fireLastY = touch.clientY;
                btnFire.classList.add('active');
                pressInput('touch:fire', K_MOUSE1);
            }, { passive: false });

            window.addEventListener('touchmove', (e) => {
                if (fireTouchId === null) return;
                let touch = null;
                for (let i = 0; i < e.changedTouches.length; i++) {
                    if (e.changedTouches[i].identifier === fireTouchId) {
                        touch = e.changedTouches[i];
                        break;
                    }
                }
                if (!touch) return;
                e.preventDefault();
                const dx = touch.clientX - fireLastX;
                const dy = touch.clientY - fireLastY;
                fireLastX = touch.clientX;
                fireLastY = touch.clientY;
                if ((dx !== 0 || dy !== 0) && wasmExports && engineRunning) {
                    wasmExports.wasm_q3_mouse_event(Math.round(dx * 2.2), Math.round(dy * 2.2), nowQ3Time());
                }
            }, { passive: false });

            const onFireEnd = (e) => {
                if (fireTouchId === null) return;
                for (let i = 0; i < e.changedTouches.length; i++) {
                    if (e.changedTouches[i].identifier === fireTouchId) {
                        btnFire.classList.remove('active');
                        releaseInput('touch:fire');
                        fireTouchId = null;
                        break;
                    }
                }
            };

            window.addEventListener('touchend', onFireEnd);
            window.addEventListener('touchcancel', onFireEnd);

            btnFire.addEventListener('mousedown', (e) => {
                e.preventDefault();
                ensureAudioUnlocked();
                btnFire.classList.add('active');
                pressInput('touch:fire', K_MOUSE1);
            });
            btnFire.addEventListener('mouseup', () => {
                btnFire.classList.remove('active');
                releaseInput('touch:fire');
            });
            btnFire.addEventListener('mouseleave', () => {
                btnFire.classList.remove('active');
                releaseInput('touch:fire');
            });
        }

        // --- Action Buttons ---
        function bindTouchButton(btn, key, pulseOnly) {
            if (!btn) return;
            const inputId = `touch:${key}`;
            btn.addEventListener('touchstart', (e) => {
                e.preventDefault();
                ensureAudioUnlocked();
                btn.classList.add('active');
                if (pulseOnly) {
                    if (wasmExports && engineRunning) {
                        const t = nowQ3Time();
                        wasmExports.wasm_q3_key_event(key, 1, t);
                        wasmExports.wasm_q3_key_event(key, 0, t);
                    }
                } else {
                    pressInput(inputId, key);
                }
            }, { passive: false });

            const onEnd = () => {
                btn.classList.remove('active');
                if (!pulseOnly) releaseInput(inputId);
            };

            btn.addEventListener('touchend', onEnd);
            btn.addEventListener('touchcancel', onEnd);

            btn.addEventListener('mousedown', (e) => {
                e.preventDefault();
                ensureAudioUnlocked();
                btn.classList.add('active');
                if (pulseOnly) {
                    if (wasmExports && engineRunning) {
                        const t = nowQ3Time();
                        wasmExports.wasm_q3_key_event(key, 1, t);
                        wasmExports.wasm_q3_key_event(key, 0, t);
                    }
                } else {
                    pressInput(inputId, key);
                }
            });
            btn.addEventListener('mouseup', onEnd);
            btn.addEventListener('mouseleave', onEnd);
        }

        bindTouchButton(btnJump, K_SPACE, false);
        bindTouchButton(btnCrouch, K_CTRL, false);
        bindTouchButton(btnWeapon, K_MWHEELUP, true);
        bindTouchButton(btnEsc, K_ESCAPE, true);
        bindTouchButton(btnTab, K_TAB, false);
    }

    // =========================================================================
    // Public Helper Commands & UI Bindings
    // =========================================================================
    function sendConsoleCommand(cmd) {
        if (!engineRunning || !cmd) return;
        ensureAudioUnlocked();
        const ptr = writeCStrToWasm(cmd + '\n');
        wasmExports.wasm_q3_console_command(ptr);
        wasmExports.wasm_q3_free(ptr);
    }

    function lockGamePointer() {
        canvas.focus();
        try {
            const request = canvas.requestPointerLock?.();
            request?.catch(err => {appendConsoleLog(`[Fare kilidi] ${err.message}\n`);document.getElementById('pointer-hint').textContent='Fare kilitlenemedi. Tekrar tıkla veya normal tarayıcıda aç.';});
        } catch (err) {
            appendConsoleLog(`[Fare kilidi] ${err.message}\n`);
        }
    }

    let packageImportRunning = false;
    async function mountUserPk3Files(fileList) {
        if (!fileList?.length || packageImportRunning) return;
        const files = Array.from(fileList);
        packageImportRunning = true;
        try {
            const packages = [];
            for (const file of files) {
                const name = file.name.toLowerCase();
                if (!/^[^/\\:\x00-\x1f]+\.pk3$/.test(name)) {
                    throw new Error(`Geçersiz PK3 dosya adı: ${file.name}`);
                }
                const data = await file.arrayBuffer();
                const entries = Q3Pk3.listEntries(data);
                if (Q3Pk3.isGeneratedDemo(entries)) throw new Error(`${file.name}: üretilmiş deneme paketi özgün oyun verisi olarak kullanılmayacak.`);
                packages.push({ name, data });
            }
            appendConsoleLog('\n[VFS] PK3 dosyaları bu tarayıcıya kaydediliyor...\n');
            await storePackages(packages);
            // Complete any pending initialization before replacing the page.
            await bootPromise;
            location.reload();
        } catch (err) {
            appendConsoleLog(`\n[PK3 HATASI] ${err.message}\n`);
            consoleDrawer?.classList.add('open');
        } finally {
            packageImportRunning = false;
            if (pk3Input) pk3Input.value = '';
        }
    }

    document.getElementById('btn-fullscreen')?.addEventListener('click', () => {
        const wrap = document.getElementById('viewport-wrap') || canvas;
        if (!document.fullscreenElement) {
            wrap.requestFullscreen?.().catch(error=>appendConsoleLog(`[Tam ekran] ${error.message}\n`));
        } else {
            document.exitFullscreen?.();
        }
    });
    document.addEventListener('fullscreenchange',()=> {
        const button=document.getElementById('btn-fullscreen');
        const label=document.fullscreenElement?'Tam ekrandan çık':'Tam ekran';button.setAttribute('aria-label',label);button.title=label;
    });
    document.addEventListener('pointerlockchange',()=> {
        document.getElementById('pointer-hint').textContent=document.pointerLockElement===canvas?'Esc ile fareyi bırak':'Oynamak için oyun alanına tıkla · Esc ile fareyi bırak';
    });

    // =========================================================================
    // WebAssembly Instantiation & Main Frame Loop
    // =========================================================================
    const env = {
        js_net_receive: (ptr,max) => Q3Network.receive(wasmMemory,ptr,max),
        js_net_peer: () => 1,
        js_net_send: (ptr,len,peer) => Q3Network.send(wasmMemory,ptr,len,peer),
        js_time_ms: () => nowQ3Time(),
        js_time_sec: () => Math.floor(Date.now() / 1000),
        js_console_print: (ptr, len) => {
            const bytes = new Uint8Array(wasmMemory.buffer, ptr, len);
            const text = new TextDecoder('utf-8').decode(bytes);
            appendConsoleLog(text);
        },
        js_abort_frame: (code) => {
            const err = new Error('Q3_ABORT_FRAME');
            err.isAbortFrame = true;
            err.code = code;
            throw err;
        },
        js_exit: (code) => {
            stopEngine(`Quake III Arena sonlandırıldı (kod: ${code}).`);
            const err = new Error('Q3_EXIT');
            err.isEngineExit = true;
            throw err;
        },
        js_vfs_list_files: vfsListFiles,
        js_vfs_open: vfsOpen,
        js_vfs_close: vfsClose,
        js_vfs_read: vfsRead,
        js_vfs_write: vfsWrite,
        js_vfs_seek: vfsSeek,
        js_vfs_tell: vfsTell,
        js_vfs_eof: vfsEof,
        js_vfs_remove: vfsRemove,

        js_sin: Math.sin,
        js_cos: Math.cos,
        js_tan: Math.tan,
        js_asin: Math.asin,
        js_acos: Math.acos,
        js_atan: Math.atan,
        js_atan2: Math.atan2,
        js_pow: Math.pow,
        js_exp: Math.exp,
        js_log: Math.log,

        js_gl_init: jsGlInit,
        js_gl_viewport: jsGlViewport,
        js_gl_scissor: jsGlScissor,
        js_gl_clear: jsGlClear,
        js_gl_state: jsGlState,
        js_gl_tex_image_2d: jsGlTexImage2D,
        js_gl_tex_sub_image_2d: jsGlTexSubImage2D,
        js_gl_tex_parameter: jsGlTexParameter,
        js_gl_delete_texture: jsGlDeleteTexture,
        js_gl_draw: jsGlDraw,
        js_gl_end_frame: jsGlEndFrame,
        js_gl_render_3d_lava: (mvpPtr) => render3dLava(mvpPtr),
        js_q3_render_3d_lava: (mvpPtr) => render3dLava(mvpPtr),
        js_gl_get_error: () => gl.getError(),
        js_gl_stencil_func: (func, ref, mask) => gl.stencilFunc(func, ref, mask),
        js_gl_stencil_mask: (mask) => gl.stencilMask(mask),
        js_gl_stencil_op: (fail, zfail, zpass) => gl.stencilOp(fail, zfail, zpass),
        js_gl_stencil_test: (enabled) => enabled ? gl.enable(gl.STENCIL_TEST) : gl.disable(gl.STENCIL_TEST),
        js_gl_read_pixels: (x, y, width, height, format, type, ptr) => {
            if (type !== gl.UNSIGNED_BYTE || (format !== gl.RGB && format !== gl.RGBA)) {
                throw new Error('Desteklenmeyen glReadPixels biçimi');
            }
            // WebGL guarantees RGBA/UNSIGNED_BYTE readback. Convert to the
            // original engine's tightly packed RGB screenshot buffer if needed.
            const rgba = new Uint8Array(width * height * 4);
            gl.readPixels(x, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
            const channels = format === gl.RGB ? 3 : 4;
            const out = new Uint8Array(wasmMemory.buffer, ptr, width * height * channels);
            if (channels === 4) out.set(rgba);
            else for (let pixel = 0; pixel < width * height; pixel++) {
                out.set(rgba.subarray(pixel * 4, pixel * 4 + 3), pixel * 3);
            }
        },

        js_audio_init: jsAudioInit,
        js_audio_get_dma_pos: jsAudioGetDmaPos,
        js_audio_submit: jsAudioSubmit,
        js_audio_shutdown: jsAudioShutdown,
    };

    function runFrame() {
        if (!engineRunning) return;

        const savedSp = wasmExports.__stack_pointer.value;
        try {
            wasmExports.wasm_q3_frame();
            if (giveAllWhenActive && wasmExports.wasm_q3_client_active()) {
                giveAllWhenActive = false;
                sendConsoleCommand('give all');
            }
        } catch (err) {
            if (err && err.isEngineExit) {
                return;
            } else if (err && err.isAbortFrame) {
                wasmExports.__stack_pointer.value = savedSp;
            } else {
                console.error(err);
                stopEngine(`Motor hatası: ${err.message}`);
                return;
            }
        }

        if (window.Q3Lava?.isEnabled()) {
            const active = !!(wasmExports && wasmExports.wasm_q3_client_active && wasmExports.wasm_q3_client_active());
            if (active) {
                const data = new Float32Array(wasmMemory.buffer, wasmExports.wasm_q3_status(), 16);
                const status = {
                    active: true,
                    map: readCStr(wasmExports.wasm_q3_mapname()),
                    origin: [data[1], data[2], data[3]],
                    velocity: [data[4], data[5], data[6]],
                    health: data[12],
                    weapon: data[13],
                    clientNum: data[15]
                };
                window.Q3Lava.update(status, sendConsoleCommand);
            } else {
                window.Q3Lava.update(null, sendConsoleCommand);
            }
        }

        frameCount++;
        const now = performance.now();
        if (now - lastFpsTick >= 500) {
            const active=!!wasmExports.wasm_q3_client_active();
            Q3Network.playing(active);
            statusOverlay.classList.toggle('hidden',active);
            Q3Lobby.show(!active&&!Q3Network.busy());
            updateTouchVisibility(active);
            if(!active)setStatus(Q3Network.active()?'Maça bağlanılıyor…':'Hazır · Maça Katıl düğmesine bas',100);
            const fps = Math.round((frameCount * 1000) / (now - lastFpsTick));
            frameCount = 0;
            lastFpsTick = now;
            if (statFps) statFps.textContent = `${fps} FPS`;
            if (statDraws) statDraws.textContent = `${shownDraws} Draw`;
            if (statTex) statTex.textContent = `${glTextures.size} Doku`;
            if (statMem && wasmMemory) {
                statMem.textContent = `${Math.round(wasmMemory.buffer.byteLength / (1024 * 1024))} MB`;
            }
        }

        requestAnimationFrame(runFrame);
    }

    async function bootQuake3() {
        try {
            setStatus('Yerel oyun verileri okunuyor...', 10);
            // Online clients use exactly the packages advertised by this server.
            // Previously uploaded local packages must not override match media.
            let storedPackages = [];
            for (const entry of storedPackages) {
                if (Q3Pk3.isGeneratedDemo(Q3Pk3.listEntries(entry.data))) continue;
                vfsFiles.set(`baseq3/${entry.name}`, new Uint8Array(entry.data));
            }
            const resetPackagesButton = document.getElementById('btn-reset-pk3');
            if (resetPackagesButton) resetPackagesButton.hidden = storedPackages.length === 0;
            const dataStatus = document.getElementById('game-data-status');
            const manifestResponse = await fetch('game-data.json');
            if (!manifestResponse.ok) throw new Error('game-data.json okunamadı.');
            const manifest = await manifestResponse.json();
            if (!Array.isArray(manifest.packages)) throw new Error('Geçersiz oyun verisi listesi.');
            for (const name of manifest.packages) {
                if (!/^pak[0-9]+\.pk3$/.test(name)) throw new Error('Geçersiz oyun paketi adı.');
                const path = `baseq3/${name}`;
                if (vfsFiles.has(path)) continue;
                setStatus(`${name} yükleniyor...`, 20);
                const response = await fetch(path);
                if (!response.ok) throw new Error(`${name} yüklenemedi (${response.status}).`);
                const bytes = new Uint8Array(await response.arrayBuffer());
                if (Q3Pk3.isGeneratedDemo(Q3Pk3.listEntries(bytes))) throw new Error('Üretilmiş deneme paketi oyun verisi listesine eklenemez.');
                vfsFiles.set(path, bytes);
            }
            updatePackageStatus();
            try { window.Q3Showroom?.init(vfsFiles); } catch (_) {}
            if (!vfsFiles.has('baseq3/pak0.pk3')) {
                const message = 'Orijinal Quake III Arena verileri bulunamadı. Oyun Verilerini Yükle düğmesinden baseq3 içindeki pak0.pk3 ve güncelleme paketlerini seç.';
                if (dataStatus) dataStatus.textContent = message;
                setStatus('Orijinal oyun verileri bekleniyor.', 0);
                appendConsoleLog(`[Veri] ${message}\nÜretilmiş harita ve geçici modeller yüklenmedi.\n`);
                return;
            }
            const pak0Bytes = vfsFiles.get('baseq3/pak0.pk3');
            try { loadLavaTextureFromPak0(pak0Bytes); } catch (_) {}
            const digest = await crypto.subtle.digest('SHA-256', pak0Bytes);
            configStorageKey = 'q3wasm_config_' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
            try {
                const savedConfig = localStorage.getItem(configStorageKey);
                if (savedConfig) vfsFiles.set('baseq3/q3config.cfg', new TextEncoder().encode(savedConfig));
            } catch (_) {}
            const directory = [...vfsFiles.entries()].filter(([name]) => name.endsWith('.pk3'))
                .flatMap(([, bytes]) => Q3Pk3.listEntries(bytes));
            const maps = Q3Pk3.mapNames(directory);
            if (!maps.length) throw new Error('Yüklenen paketlerde BSP haritası bulunamadı.');
            const mapSelect = document.getElementById('map-select');
            if(mapSelect) {mapSelect.replaceChildren(...maps.map(name => new Option(name, name)));
            if (maps.includes('q3dm1')) mapSelect.value = 'q3dm1';}
            if (dataStatus) dataStatus.textContent = manifest.edition === 'demo'
                ? `Quake III Arena Demo · ${maps.length} özgün harita · Orijinal model, doku ve sesler`
                : `${maps.length} harita, yüklenen PK3 dosyalarından okundu.`;

            setStatus('quake3.wasm derleniyor ve bağlanıyor...', 60);
            const wasmResp = await fetch('quake3.wasm');
            if (!wasmResp.ok) throw new Error(`quake3.wasm yüklenemedi (${wasmResp.status})`);
            const wasmBuf = await wasmResp.arrayBuffer();

            const { instance } = await WebAssembly.instantiate(wasmBuf, { env });
            wasmExports = instance.exports;
            wasmMemory = wasmExports.memory;

            setStatus('Quake III Arena motoru başlatılıyor (Com_Init)...', 90);
            const isTouchOrMobile = ('ontouchstart' in window) ||
                (navigator.maxTouchPoints > 0) ||
                (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
                /iPad|iPhone|iPod|Android|Mobile/i.test(navigator.userAgent) ||
                (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

            const targetWidth = isTouchOrMobile ? 960 : canvas.width;
            const targetHeight = isTouchOrMobile ? 720 : canvas.height;
            canvas.width = targetWidth;
            canvas.height = targetHeight;

            const savedModel = localStorage.getItem('q3_player_model') || 'steve';
            const modelHeader = document.getElementById('player-model');
            const modelLobby = document.getElementById('lobby-player-model');
            if (modelHeader) modelHeader.value = savedModel;
            if (modelLobby) modelLobby.value = savedModel;
            try { window.Q3Showroom?.setModel(savedModel); } catch (_) {}

            const onModelSelect = (e) => {
                const val = e.target.value;
                try { localStorage.setItem('q3_player_model', val); } catch (_) {}
                if (modelHeader) modelHeader.value = val;
                if (modelLobby) modelLobby.value = val;
                try { window.Q3Showroom?.setModel(val); } catch (_) {}
                if (engineRunning) {
                    sendConsoleCommand(`model "${val}"`);
                    sendConsoleCommand(`headmodel "${val}"`);
                }
            };
            modelHeader?.addEventListener('change', onModelSelect);
            modelLobby?.addEventListener('change', onModelSelect);

            const cmdline =
                '+set sv_pure 0 +set vm_game 0 +set vm_cgame 0 +set vm_ui 0 ' +
                `+set r_mode -1 +set r_customwidth ${targetWidth} +set r_customheight ${targetHeight} ` +
                '+set r_fullscreen 0 +set in_mouse 1 +set bot_enable 1 ' +
                '+set com_maxfps 125 +set r_finish 0 +set r_swapInterval 0 ' +
                '+set s_mixahead 0.22 +set s_mixPreStep 0.08 +set r_dynamiclight 0 ' +
                `+set model "${savedModel}" +set headmodel "${savedModel}"`;
            setupInputHandlers();
            const cmdPtr = writeCStrToWasm(cmdline);
            wasmExports.wasm_q3_init(cmdPtr);
            wasmExports.wasm_q3_free(cmdPtr);

            setStatus('Hazır · Maça Katıl düğmesine bas', 100);
            document.getElementById('network-status').textContent='Maça katılarak arkadaşlarınla oyna';

            engineRunning = true;
            setEngineControls(true);
            document.getElementById('btn-online').disabled=false;
            Q3Lobby.init(joinRoom);
            Q3Lobby.show(true);
            consoleDrawer?.classList.remove('open');
            if (new URLSearchParams(location.search).get('test') === '1') {
                window.Q3Test = Object.freeze({
                    remotePlayers: () => {
                        const data=new Float32Array(wasmMemory.buffer,wasmExports.wasm_q3_remote_players(),33);
                        return Array.from({length:data[0]},(_,i)=>({id:data[1+i*4],origin:Array.from(data.slice(2+i*4,5+i*4))}));
                    },
                    command: sendConsoleCommand,
                    unlockAudio: ensureAudioUnlocked,
                    key: (key, down) => wasmExports.wasm_q3_key_event(key, down ? 1 : 0, nowQ3Time()),
                    status: () => {
                        const data = new Float32Array(wasmMemory.buffer, wasmExports.wasm_q3_status(), 16);
                        return { active: !!data[0], map: readCStr(wasmExports.wasm_q3_mapname()), origin: Array.from(data.slice(1, 4)), bots: data[7],
                            botOrigin: Array.from(data.slice(8, 11)), serverTime: data[11], health: data[12],
                            weapon: data[13], botWeapon: data[14], draws: shownDraws, textures: glTextures.size,
                            clientNum: data[15],
                            audioState: audioCtx?.state || 'not-created', audioFramesPlayed, audioPeakMax };
                    },
                    log: () => logText,
                });
            }
            requestAnimationFrame(runFrame);
        } catch (err) {
            if (err && err.isEngineExit) return;
            console.error(err);
            stopEngine(`Başlatma hatası: ${err.message}`);
        }
    }

    async function joinRoom(room) {
        if(!engineRunning) return;
        const button=document.getElementById('btn-online');button.disabled=true;
        try {
            sendConsoleCommand('disconnect');
            Q3Lobby.error('');Q3Lobby.show(false);
            try { window.Q3Showroom?.setVisibility(false); } catch (_) {}
            let roomData = window.Q3Lobby?.getRoom?.(room);
            if (!roomData) {
                try {
                    const r = await fetch('/api/rooms/' + room);
                    if (r.ok) roomData = await r.json();
                } catch (_) {}
            }
            const isLava = roomData?.mode === 'lava';
            window.Q3Lava?.setEnabled(isLava);
            await Q3Network.connect(room);
            Q3Lobby.joined(room);
            const name=document.getElementById('player-name').value.replace(/[^a-zA-Z0-9 _-]/g,'').trim().slice(0,24)||'Oyuncu';
            const selModel = document.getElementById('lobby-player-model')?.value || document.getElementById('player-model')?.value || 'steve';
            sendConsoleCommand(`name "${name}"`);
            sendConsoleCommand(`model "${selModel}"`);
            sendConsoleCommand(`headmodel "${selModel}"`);
            sendConsoleCommand('connect 10.0.0.1:27960');
            ensureAudioUnlocked();canvas.focus();
        } catch(error) {appendConsoleLog(`[Online] ${error.message}\n`);Q3Lobby.show(true);try { window.Q3Showroom?.setVisibility(true); } catch (_) {}Q3Lobby.error(error.message);consoleDrawer?.classList.add('open');}
        finally {button.disabled=false;}
    }
    document.getElementById('btn-online').addEventListener('click',()=>joinRoom(Q3Lobby.selected()));
    function leaveMatch() {window.Q3Lava?.setEnabled(false);Q3Network.close();sendConsoleCommand('disconnect');if(document.pointerLockElement===canvas)document.exitPointerLock();document.getElementById('pointer-hint').textContent='Oynamak için oyun alanına tıkla · Esc ile fareyi bırak';updateTouchVisibility(false);try { window.Q3Showroom?.setVisibility(true); } catch (_) {}}
    document.getElementById('btn-offline').addEventListener('click',leaveMatch);
    window.addEventListener('q3-network-closed',()=>{window.Q3Lava?.setEnabled(false);sendConsoleCommand('disconnect');if(document.pointerLockElement===canvas)document.exitPointerLock();try { window.Q3Showroom?.setVisibility(true); } catch (_) {}});
    const bootPromise = bootQuake3();
})();

