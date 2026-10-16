/**
 * Quake III Arena — 3D Character Showroom (WebGL)
 * Renders MD3 player models (Steve, Alex, Sarge, Visor, Major, Grunt)
 * with 360-degree smooth showroom rotation, lighting, and drag-to-spin interaction.
 */

(() => {
    'use strict';

    let gl = null;
    let canvas = null;
    let program = null;
    let pedestalProgram = null;
    let vfsMap = null;
    let zipIndices = new Map();
    const modelCache = new Map();
    const textureCache = new Map();

    let currentModelId = 'steve';
    let targetRotation = 0;
    let currentRotation = 0;
    let isDragging = false;
    let lastPointerX = 0;
    let autoRotateSpeed = 0.45; // rad/sec
    let lastFrameTime = performance.now();
    let isVisible = true;
    let activeModelData = null;
    let loadingModelId = null;

    // Pedestal geometry
    let pedestalVbo = null;
    let pedestalNumVerts = 0;

    // Shaders
    const VS_SOURCE = `#version 100
    precision mediump float;
    attribute vec3 aPosition;
    attribute vec3 aNormal;
    attribute vec2 aTexCoord;

    uniform mat4 uMVP;
    uniform mat4 uModel;

    varying vec2 vTexCoord;
    varying vec3 vNormal;
    varying vec3 vWorldPos;

    void main() {
        vTexCoord = aTexCoord;
        vNormal = mat3(uModel[0].xyz, uModel[1].xyz, uModel[2].xyz) * aNormal;
        vec4 world = uModel * vec4(aPosition, 1.0);
        vWorldPos = world.xyz;
        gl_Position = uMVP * vec4(aPosition, 1.0);
    }
    `;

    const FS_SOURCE = `#version 100
    precision mediump float;
    varying vec2 vTexCoord;
    varying vec3 vNormal;
    varying vec3 vWorldPos;

    uniform sampler2D uSampler;
    uniform vec3 uLightDir;
    uniform vec3 uEyePos;
    uniform float uAlpha;

    void main() {
        vec4 texColor = texture2D(uSampler, vTexCoord);
        if (texColor.a < 0.1) discard;

        vec3 norm = normalize(vNormal);
        vec3 light = normalize(uLightDir);
        vec3 view = normalize(uEyePos - vWorldPos);

        // Ambient + Diffuse (warm key light)
        float diff = max(dot(norm, light), 0.0);
        float ambient = 0.42;

        // Subtle fill light from opposite side
        vec3 fillLight = normalize(vec3(-uLightDir.x, 0.2, -uLightDir.z));
        float fillDiff = max(dot(norm, fillLight), 0.0) * 0.25;

        // Rim light for hero champion silhouette
        float rim = pow(1.0 - max(dot(norm, view), 0.0), 3.0) * 0.35;

        vec3 lit = texColor.rgb * (ambient + diff * 0.65 + fillDiff) + vec3(rim * 0.9, rim * 0.5, rim * 0.3);
        gl_FragColor = vec4(lit, texColor.a * uAlpha);
    }
    `;

    const PEDESTAL_VS = `#version 100
    precision mediump float;
    attribute vec3 aPosition;
    attribute vec4 aColor;
    uniform mat4 uMVP;
    varying vec4 vColor;
    void main() {
        vColor = aColor;
        gl_Position = uMVP * vec4(aPosition, 1.0);
    }
    `;

    const PEDESTAL_FS = `#version 100
    precision mediump float;
    varying vec4 vColor;
    void main() {
        gl_FragColor = vColor;
    }
    `;

    // -------------------------------------------------------------------------
    // Math Utilities (4x4 Matrix)
    // -------------------------------------------------------------------------
    function mat4Create() {
        return new Float32Array([
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0, 0, 0, 1
        ]);
    }

    function mat4Perspective(out, fovy, aspect, near, far) {
        const f = 1.0 / Math.tan(fovy / 2);
        const nf = 1 / (near - far);
        out[0] = f / aspect; out[1] = 0; out[2] = 0; out[3] = 0;
        out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0;
        out[8] = 0; out[9] = 0; out[10] = (far + near) * nf; out[11] = -1;
        out[12] = 0; out[13] = 0; out[14] = (2 * far * near) * nf; out[15] = 0;
        return out;
    }

    function mat4LookAt(out, eye, center, up) {
        let x0, x1, x2, y0, y1, y2, z0, z1, z2, len;
        const eyex = eye[0], eyey = eye[1], eyez = eye[2];
        const upx = up[0], upy = up[1], upz = up[2];
        const centerx = center[0], centery = center[1], centerz = center[2];

        z0 = eyex - centerx; z1 = eyey - centery; z2 = eyez - centerz;
        len = Math.hypot(z0, z1, z2);
        if (len === 0) { z2 = 1; } else { z0 /= len; z1 /= len; z2 /= len; }

        x0 = upy * z2 - upz * z1; x1 = upz * z0 - upx * z2; x2 = upx * z1 - upy * z0;
        len = Math.hypot(x0, x1, x2);
        if (len === 0) { x0 = 0; x1 = 0; x2 = 0; } else { x0 /= len; x1 /= len; x2 /= len; }

        y0 = z1 * x2 - z2 * x1; y1 = z2 * x0 - z0 * x2; y2 = z0 * x1 - z1 * x0;
        len = Math.hypot(y0, y1, y2);
        if (len > 0) { y0 /= len; y1 /= len; y2 /= len; }

        out[0] = x0; out[1] = y0; out[2] = z0; out[3] = 0;
        out[4] = x1; out[5] = y1; out[6] = z1; out[7] = 0;
        out[8] = x2; out[9] = y2; out[10] = z2; out[11] = 0;
        out[12] = -(x0 * eyex + x1 * eyey + x2 * eyez);
        out[13] = -(y0 * eyex + y1 * eyey + y2 * eyez);
        out[14] = -(z0 * eyex + z1 * eyey + z2 * eyez);
        out[15] = 1;
        return out;
    }

    function mat4Multiply(out, a, b) {
        const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
        const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
        const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
        const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

        let b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
        out[0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
        out[1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
        out[2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
        out[3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

        b0 = b[4]; b1 = b[5]; b2 = b[6]; b3 = b[7];
        out[4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
        out[5] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
        out[6] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
        out[7] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

        b0 = b[8]; b1 = b[9]; b2 = b[10]; b3 = b[11];
        out[8] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
        out[9] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
        out[10] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
        out[11] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

        b0 = b[12]; b1 = b[13]; b2 = b[14]; b3 = b[15];
        out[12] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
        out[13] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
        out[14] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
        out[15] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
        return out;
    }

    function mat4FromYRotation(out, rad) {
        const s = Math.sin(rad), c = Math.cos(rad);
        out[0] = c;  out[1] = 0; out[2] = -s; out[3] = 0;
        out[4] = 0;  out[5] = 1; out[6] = 0;  out[7] = 0;
        out[8] = s;  out[9] = 0; out[10] = c; out[11] = 0;
        out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
        return out;
    }

    // -------------------------------------------------------------------------
    // ZIP / PK3 Central Directory Indexer & Extractor
    // -------------------------------------------------------------------------
    function indexZipBuffer(bytes) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let end = -1;
        for (let o = bytes.length - 22; o >= Math.max(0, bytes.length - 65557); o--) {
            if (view.getUint32(o, true) === 0x06054b50) {
                end = o;
                break;
            }
        }
        if (end < 0) return new Map();
        const count = view.getUint16(end + 10, true);
        let cur = view.getUint32(end + 16, true);
        const dec = new TextDecoder('utf-8');
        const map = new Map();

        for (let i = 0; i < count; i++) {
            if (cur + 46 > end || view.getUint32(cur, true) !== 0x02014b50) break;
            const method = view.getUint16(cur + 10, true);
            const compressedSize = view.getUint32(cur + 20, true);
            const length = view.getUint32(cur + 24, true);
            const nameLength = view.getUint16(cur + 28, true);
            const extraLength = view.getUint16(cur + 30, true);
            const commentLength = view.getUint16(cur + 32, true);
            const local = view.getUint32(cur + 42, true);
            const name = dec.decode(bytes.subarray(cur + 46, cur + 46 + nameLength)).replace(/\\/g, '/').toLowerCase();
            map.set(name, { bytes, length, compressedSize, method, local });
            cur += 46 + nameLength + extraLength + commentLength;
        }
        return map;
    }

    async function extractFromZip(entry) {
        if (!entry) return null;
        const view = new DataView(entry.bytes.buffer, entry.bytes.byteOffset, entry.bytes.byteLength);
        const nlen = view.getUint16(entry.local + 26, true);
        const elen = view.getUint16(entry.local + 28, true);
        const raw = entry.bytes.subarray(entry.local + 30 + nlen + elen, entry.local + 30 + nlen + elen + entry.compressedSize);
        if (entry.method === 0) return raw;
        const ds = new DecompressionStream('deflate-raw');
        const r = new Response(new Response(raw).body.pipeThrough(ds));
        return new Uint8Array(await r.arrayBuffer());
    }

    async function getVfsFile(path) {
        const norm = path.toLowerCase().replace(/\\/g, '/');
        // Check zip entries in loaded pk3 packages
        for (const [pkgName, index] of zipIndices) {
            const entry = index.get(norm);
            if (entry) return await extractFromZip(entry);
        }
        // Direct vfsFiles lookup
        if (vfsMap && vfsMap.has(norm)) return vfsMap.get(norm);
        return null;
    }

    // -------------------------------------------------------------------------
    // MD3 Parser (Surfaces & Tags)
    // -------------------------------------------------------------------------
    function parseMD3Surfaces(bytes, frameIndex) {
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const numSurfaces = dv.getInt32(84, true);
        let curOfs = dv.getInt32(100, true);
        const surfaces = [];

        for (let s = 0; s < numSurfaces; s++) {
            const sName = new TextDecoder().decode(bytes.subarray(curOfs + 4, curOfs + 68)).replace(/\0[\s\S]*$/, '');
            const numFrames = dv.getInt32(curOfs + 72, true);
            const numVerts = dv.getInt32(curOfs + 80, true);
            const numTriangles = dv.getInt32(curOfs + 84, true);
            const ofsTriangles = curOfs + dv.getInt32(curOfs + 88, true);
            const ofsSt = curOfs + dv.getInt32(curOfs + 96, true);
            const ofsXyzNormals = curOfs + dv.getInt32(curOfs + 100, true);
            const ofsEnd = curOfs + dv.getInt32(curOfs + 104, true);

            const safeFrame = Math.max(0, Math.min(frameIndex || 0, numFrames - 1));

            // UVs
            const uvs = new Float32Array(numVerts * 2);
            for (let i = 0; i < numVerts; i++) {
                uvs[i * 2] = dv.getFloat32(ofsSt + i * 8, true);
                uvs[i * 2 + 1] = dv.getFloat32(ofsSt + i * 8 + 4, true);
            }

            // Triangles
            const indices = new Uint16Array(numTriangles * 3);
            for (let i = 0; i < numTriangles * 3; i++) {
                indices[i] = dv.getInt32(ofsTriangles + i * 4, true);
            }

            // Vertices (Quake 3 coordinates: X forward, Y left, Z up)
            const verts = new Float32Array(numVerts * 3);
            const baseVertOfs = ofsXyzNormals + safeFrame * numVerts * 8;
            for (let i = 0; i < numVerts; i++) {
                const vo = baseVertOfs + i * 8;
                verts[i * 3]     = dv.getInt16(vo, true) * (1.0 / 64.0);
                verts[i * 3 + 1] = dv.getInt16(vo + 2, true) * (1.0 / 64.0);
                verts[i * 3 + 2] = dv.getInt16(vo + 4, true) * (1.0 / 64.0);
            }

            surfaces.push({
                name: sName,
                numVerts,
                numTriangles,
                indices,
                uvs,
                verts
            });

            curOfs = ofsEnd;
        }
        return surfaces;
    }

    function parseMD3Tags(bytes, frameIndex) {
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const numTags = dv.getInt32(80, true);
        const numFrames = dv.getInt32(76, true);
        const ofsTags = dv.getInt32(96, true);
        const safeFrame = Math.max(0, Math.min(frameIndex || 0, numFrames - 1));
        const tags = new Map();

        for (let i = 0; i < numTags; i++) {
            const o = ofsTags + (safeFrame * numTags + i) * 112;
            const name = new TextDecoder().decode(bytes.subarray(o, o + 64)).replace(/\0[\s\S]*$/, '');
            const origin = [
                dv.getFloat32(o + 64, true),
                dv.getFloat32(o + 68, true),
                dv.getFloat32(o + 72, true)
            ];
            const axis = [
                [dv.getFloat32(o + 76, true), dv.getFloat32(o + 80, true), dv.getFloat32(o + 84, true)],
                [dv.getFloat32(o + 88, true), dv.getFloat32(o + 92, true), dv.getFloat32(o + 96, true)],
                [dv.getFloat32(o + 100, true), dv.getFloat32(o + 104, true), dv.getFloat32(o + 108, true)]
            ];
            tags.set(name, { origin, axis });
        }
        return tags;
    }

    function transformVertexByTag(v, origin, axis) {
        const x = v[0], y = v[1], z = v[2];
        return [
            origin[0] + axis[0][0] * x + axis[1][0] * y + axis[2][0] * z,
            origin[1] + axis[0][1] * x + axis[1][1] * y + axis[2][1] * z,
            origin[2] + axis[0][2] * x + axis[1][2] * y + axis[2][2] * z
        ];
    }

    // -------------------------------------------------------------------------
    // Texture Decoders (TGA, JPG, PNG)
    // -------------------------------------------------------------------------
    function decodeTGA(bytes) {
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const type = dv.getUint8(2);
        const w = dv.getUint16(12, true);
        const h = dv.getUint16(14, true);
        const bpp = dv.getUint8(16);
        const flip = !(dv.getUint8(17) & 0x20); // origin bottom-left by default
        const out = new Uint8ClampedArray(w * h * 4);
        let offset = 18 + dv.getUint8(0);
        const bytesPerPixel = Math.floor(bpp / 8);

        if (type === 2) { // Uncompressed true-color
            for (let i = 0; i < w * h; i++) {
                const b = bytes[offset++];
                const g = bytes[offset++];
                const r = bytes[offset++];
                const a = bytesPerPixel === 4 ? bytes[offset++] : 255;
                const idx = i * 4;
                out[idx] = r; out[idx + 1] = g; out[idx + 2] = b; out[idx + 3] = a;
            }
        } else if (type === 10) { // RLE true-color
            let pixelCount = 0;
            while (pixelCount < w * h && offset < bytes.length) {
                const chunk = bytes[offset++];
                const count = (chunk & 0x7f) + 1;
                if (chunk & 0x80) { // RLE packet
                    const b = bytes[offset++];
                    const g = bytes[offset++];
                    const r = bytes[offset++];
                    const a = bytesPerPixel === 4 ? bytes[offset++] : 255;
                    for (let k = 0; k < count; k++) {
                        const idx = (pixelCount++) * 4;
                        out[idx] = r; out[idx + 1] = g; out[idx + 2] = b; out[idx + 3] = a;
                    }
                } else { // Raw packet
                    for (let k = 0; k < count; k++) {
                        const b = bytes[offset++];
                        const g = bytes[offset++];
                        const r = bytes[offset++];
                        const a = bytesPerPixel === 4 ? bytes[offset++] : 255;
                        const idx = (pixelCount++) * 4;
                        out[idx] = r; out[idx + 1] = g; out[idx + 2] = b; out[idx + 3] = a;
                    }
                }
            }
        }

        if (flip) {
            // Flip Y rows so top-left is standard for WebGL
            const rowBytes = w * 4;
            const tempRow = new Uint8ClampedArray(rowBytes);
            for (let y = 0; y < Math.floor(h / 2); y++) {
                const topIdx = y * rowBytes;
                const botIdx = (h - 1 - y) * rowBytes;
                tempRow.set(out.subarray(topIdx, topIdx + rowBytes));
                out.set(out.subarray(botIdx, botIdx + rowBytes), topIdx);
                out.set(tempRow, botIdx);
            }
        }
        return { w, h, out };
    }

    async function loadTexture(texPath) {
        if (!gl) return null;
        const norm = texPath.toLowerCase().replace(/\\/g, '/');
        if (textureCache.has(norm)) return textureCache.get(norm);

        // Try exact path, then alternative extensions (.jpg, .tga, .png)
        const extensions = [norm];
        const base = norm.replace(/\.[a-z0-9]+$/, '');
        extensions.push(`${base}.tga`, `${base}.jpg`, `${base}.png`);

        let bytes = null;
        let chosenPath = norm;
        for (const candidate of extensions) {
            bytes = await getVfsFile(candidate);
            if (bytes && bytes.length > 0) {
                chosenPath = candidate;
                break;
            }
        }

        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);

        // Default 1x1 fallback texture while loading
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([180, 180, 180, 255]));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);

        if (!bytes) {
            textureCache.set(norm, tex);
            return tex;
        }

        try {
            if (chosenPath.endsWith('.tga')) {
                const tga = decodeTGA(bytes);
                gl.bindTexture(gl.TEXTURE_2D, tex);
                gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, tga.w, tga.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, tga.out);
            } else {
                // JPG or PNG
                const blob = new Blob([bytes], { type: chosenPath.endsWith('.png') ? 'image/png' : 'image/jpeg' });
                const bmp = await createImageBitmap(blob);
                gl.bindTexture(gl.TEXTURE_2D, tex);
                gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
            }
            gl.generateMipmap(gl.TEXTURE_2D);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        } catch (err) {
            console.warn('[Showroom] Texture decode fallback:', chosenPath, err);
        }

        textureCache.set(norm, tex);
        return tex;
    }

    // -------------------------------------------------------------------------
    // Skin Parsing
    // -------------------------------------------------------------------------
    async function parseSkinFile(skinPath) {
        const bytes = await getVfsFile(skinPath);
        const map = new Map();
        if (!bytes) return map;
        const text = new TextDecoder('utf-8').decode(bytes);
        const lines = text.split(/\r?\n/);
        for (const line of lines) {
            const parts = line.split(',');
            if (parts.length >= 2) {
                const surfaceName = parts[0].trim();
                const texPath = parts[1].trim();
                if (surfaceName && texPath) map.set(surfaceName.toLowerCase(), texPath);
            }
        }
        return map;
    }

    // -------------------------------------------------------------------------
    // Full Character Assembly & Mesh Preparation
    // -------------------------------------------------------------------------
    async function loadCharacterModel(modelKey) {
        if (modelCache.has(modelKey)) return modelCache.get(modelKey);

        const isAlex = modelKey === 'steve/alex';
        const modelDir = modelKey.startsWith('steve') ? 'steve' : modelKey;
        const skinName = isAlex ? 'alex' : 'default';

        // Extract MD3 files for lower, upper, head
        const lowerBytes = await getVfsFile(`models/players/${modelDir}/lower.md3`);
        const upperBytes = await getVfsFile(`models/players/${modelDir}/upper.md3`);
        const headBytes  = await getVfsFile(`models/players/${modelDir}/head.md3`);

        if (!lowerBytes || !upperBytes || !headBytes) {
            console.warn('[Showroom] Missing MD3 parts for', modelKey);
            return null;
        }

        // Parse skins
        const lowerSkin = await parseSkinFile(`models/players/${modelDir}/lower_${skinName}.skin`);
        const upperSkin = await parseSkinFile(`models/players/${modelDir}/upper_${skinName}.skin`);
        const headSkin  = await parseSkinFile(`models/players/${modelDir}/head_${skinName}.skin`);

        // Surfaces & Tags
        const lowerSurfaces = parseMD3Surfaces(lowerBytes, 0);
        const upperSurfaces = parseMD3Surfaces(upperBytes, 0);
        const headSurfaces  = parseMD3Surfaces(headBytes, 0);

        const lowerTags = parseMD3Tags(lowerBytes, 0);
        const upperTags = parseMD3Tags(upperBytes, 0);

        const tagTorso = lowerTags.get('tag_torso') || { origin: [0, 0, 0], axis: [[1,0,0],[0,1,0],[0,0,1]] };
        const tagHead  = upperTags.get('tag_head')  || { origin: [0, 0, 0], axis: [[1,0,0],[0,1,0],[0,0,1]] };

        // Collect all meshes and transform into single character coordinate space
        // Quake 3: X forward, Y left, Z up.
        // WebGL Camera Space: webgl_x = -quake_y, webgl_y = quake_z, webgl_z = quake_x
        const assembledParts = [];
        let minZ = Infinity, maxZ = -Infinity;
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;

        function processSurfaces(surfaces, skinMap, transformFn, partType) {
            for (const s of surfaces) {
                const sNameLower = s.name.toLowerCase();
                let texPath = skinMap.get(sNameLower);
                if (!texPath) {
                    // Default fallback textures
                    if (modelDir === 'steve') {
                        texPath = isAlex ? 'models/players/steve/alex.tga' : 'models/players/steve/default.tga';
                    } else {
                        texPath = `models/players/${modelDir}/${modelDir}.jpg`;
                    }
                }

                const transformedVerts = new Float32Array(s.numVerts * 3);
                for (let i = 0; i < s.numVerts; i++) {
                    const rawQuake = [s.verts[i * 3], s.verts[i * 3 + 1], s.verts[i * 3 + 2]];
                    const placedQuake = transformFn ? transformFn(rawQuake) : rawQuake;

                    // WebGL coordinates
                    const wx = -placedQuake[1];
                    const wy = placedQuake[2];
                    const wz = placedQuake[0];

                    transformedVerts[i * 3]     = wx;
                    transformedVerts[i * 3 + 1] = wy;
                    transformedVerts[i * 3 + 2] = wz;

                    minX = Math.min(minX, wx); maxX = Math.max(maxX, wx);
                    minY = Math.min(minY, wy); maxY = Math.max(maxY, wy);
                    minZ = Math.min(minZ, wz); maxZ = Math.max(maxZ, wz);
                }

                // Compute smooth per-vertex normals
                const normals = new Float32Array(s.numVerts * 3);
                for (let i = 0; i < s.numTriangles; i++) {
                    const i0 = s.indices[i * 3];
                    const i1 = s.indices[i * 3 + 1];
                    const i2 = s.indices[i * 3 + 2];

                    const p0 = [transformedVerts[i0 * 3], transformedVerts[i0 * 3 + 1], transformedVerts[i0 * 3 + 2]];
                    const p1 = [transformedVerts[i1 * 3], transformedVerts[i1 * 3 + 1], transformedVerts[i1 * 3 + 2]];
                    const p2 = [transformedVerts[i2 * 3], transformedVerts[i2 * 3 + 1], transformedVerts[i2 * 3 + 2]];

                    const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
                    const bx = p2[0] - p0[0], by = p2[1] - p0[1], bz = p2[2] - p0[2];

                    const fnx = ay * bz - az * by;
                    const fny = az * bx - ax * bz;
                    const fnz = ax * by - ay * bx;

                    normals[i0 * 3] += fnx; normals[i0 * 3 + 1] += fny; normals[i0 * 3 + 2] += fnz;
                    normals[i1 * 3] += fnx; normals[i1 * 3 + 1] += fny; normals[i1 * 3 + 2] += fnz;
                    normals[i2 * 3] += fnx; normals[i2 * 3 + 1] += fny; normals[i2 * 3 + 2] += fnz;
                }
                for (let i = 0; i < s.numVerts; i++) {
                    const nx = normals[i * 3], ny = normals[i * 3 + 1], nz = normals[i * 3 + 2];
                    const len = Math.hypot(nx, ny, nz);
                    if (len > 0.0001) {
                        normals[i * 3] /= len; normals[i * 3 + 1] /= len; normals[i * 3 + 2] /= len;
                    } else {
                        normals[i * 3 + 1] = 1;
                    }
                }

                assembledParts.push({
                    name: s.name,
                    texPath,
                    numIndices: s.indices.length,
                    verts: transformedVerts,
                    normals,
                    uvs: s.uvs,
                    indices: s.indices
                });
            }
        }

        // Lower body (at base)
        processSurfaces(lowerSurfaces, lowerSkin, null, 'lower');

        // Upper body (attached to lower tag_torso)
        processSurfaces(upperSurfaces, upperSkin, (v) => transformVertexByTag(v, tagTorso.origin, tagTorso.axis), 'upper');

        // Head (attached to lower tag_torso + upper tag_head)
        processSurfaces(headSurfaces, headSkin, (v) => {
            const vOnUpper = transformVertexByTag(v, tagHead.origin, tagHead.axis);
            return transformVertexByTag(vOnUpper, tagTorso.origin, tagTorso.axis);
        }, 'head');

        // Center the character around origin (0, 0, 0)
        const centerY = (minY + maxY) / 2;
        const height = maxY - minY;
        const centerZ = (minZ + maxZ) / 2;
        const centerX = (minX + maxX) / 2;

        for (const part of assembledParts) {
            for (let i = 0; i < part.verts.length; i += 3) {
                part.verts[i]     -= centerX;
                part.verts[i + 1] -= centerY;
                part.verts[i + 2] -= centerZ;
            }

            // Create WebGL Buffers
            const vboPos = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, vboPos);
            gl.bufferData(gl.ARRAY_BUFFER, part.verts, gl.STATIC_DRAW);

            const vboNorm = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, vboNorm);
            gl.bufferData(gl.ARRAY_BUFFER, part.normals, gl.STATIC_DRAW);

            const vboUv = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, vboUv);
            gl.bufferData(gl.ARRAY_BUFFER, part.uvs, gl.STATIC_DRAW);

            const ibo = gl.createBuffer();
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, part.indices, gl.STATIC_DRAW);

            part.glData = { vboPos, vboNorm, vboUv, ibo };
            loadTexture(part.texPath).then(tex => { part.glTexture = tex; });
        }

        const modelData = {
            id: modelKey,
            parts: assembledParts,
            height,
            pedestalY: -height / 2
        };

        modelCache.set(modelKey, modelData);
        return modelData;
    }

    // -------------------------------------------------------------------------
    // Showroom Pedestal Geometry
    // -------------------------------------------------------------------------
    function initPedestal(yPos) {
        if (!gl) return;
        const segments = 48;
        const radius = 22.0;
        const verts = [];

        // Center disc vertices [x, y, z, r, g, b, a]
        for (let i = 0; i < segments; i++) {
            const a0 = (i / segments) * Math.PI * 2;
            const a1 = ((i + 1) / segments) * Math.PI * 2;

            // Center vertex
            verts.push(0, yPos, 0,  0.08, 0.09, 0.12, 0.95);
            // Outer vertex 0
            verts.push(Math.cos(a0) * radius, yPos, Math.sin(a0) * radius,  0.14, 0.16, 0.22, 0.95);
            // Outer vertex 1
            verts.push(Math.cos(a1) * radius, yPos, Math.sin(a1) * radius,  0.14, 0.16, 0.22, 0.95);
        }

        // Glowing outer ring border
        const ringRadius = radius * 1.04;
        for (let i = 0; i < segments; i++) {
            const a0 = (i / segments) * Math.PI * 2;
            const a1 = ((i + 1) / segments) * Math.PI * 2;

            verts.push(Math.cos(a0) * radius, yPos + 0.1, Math.sin(a0) * radius,  0.85, 0.2, 0.15, 1.0);
            verts.push(Math.cos(a0) * ringRadius, yPos + 0.1, Math.sin(a0) * ringRadius,  0.95, 0.35, 0.25, 0.1);
            verts.push(Math.cos(a1) * ringRadius, yPos + 0.1, Math.sin(a1) * ringRadius,  0.95, 0.35, 0.25, 0.1);

            verts.push(Math.cos(a0) * radius, yPos + 0.1, Math.sin(a0) * radius,  0.85, 0.2, 0.15, 1.0);
            verts.push(Math.cos(a1) * ringRadius, yPos + 0.1, Math.sin(a1) * ringRadius,  0.95, 0.35, 0.25, 0.1);
            verts.push(Math.cos(a1) * radius, yPos + 0.1, Math.sin(a1) * radius,  0.85, 0.2, 0.15, 1.0);
        }

        pedestalNumVerts = Math.floor(verts.length / 7);
        if (!pedestalVbo) pedestalVbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, pedestalVbo);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
    }

    // -------------------------------------------------------------------------
    // WebGL Shader Compilation
    // -------------------------------------------------------------------------
    function createShader(glCtx, type, source) {
        const shader = glCtx.createShader(type);
        glCtx.shaderSource(shader, source);
        glCtx.compileShader(shader);
        if (!glCtx.getShaderParameter(shader, glCtx.COMPILE_STATUS)) {
            console.error(glCtx.getShaderInfoLog(shader));
            glCtx.deleteShader(shader);
            return null;
        }
        return shader;
    }

    function createProgram(glCtx, vsSource, fsSource) {
        const vs = createShader(glCtx, glCtx.VERTEX_SHADER, vsSource);
        const fs = createShader(glCtx, glCtx.FRAGMENT_SHADER, fsSource);
        const prog = glCtx.createProgram();
        glCtx.attachShader(prog, vs);
        glCtx.attachShader(prog, fs);
        glCtx.linkProgram(prog);
        if (!glCtx.getProgramParameter(prog, glCtx.LINK_STATUS)) {
            console.error(glCtx.getProgramInfoLog(prog));
            return null;
        }
        return prog;
    }

    // -------------------------------------------------------------------------
    // Render Loop
    // -------------------------------------------------------------------------
    function renderFrame() {
        if (!isVisible || !gl || !program) {
            requestAnimationFrame(renderFrame);
            return;
        }

        const now = performance.now();
        const dt = Math.min(0.1, (now - lastFrameTime) / 1000.0);
        lastFrameTime = now;

        // Auto rotation + drag inertia
        if (!isDragging) {
            targetRotation += autoRotateSpeed * dt;
        }
        currentRotation += (targetRotation - currentRotation) * 0.12;

        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0.06, 0.07, 0.09, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        if (activeModelData) {
            const aspect = canvas.width / canvas.height;
            const pMatrix = mat4Perspective(mat4Create(), (40 * Math.PI) / 180, aspect, 1.0, 500.0);
            const cameraDist = Math.max(70, activeModelData.height * 1.45);
            const vMatrix = mat4LookAt(mat4Create(), [0, 8, cameraDist], [0, 0, 0], [0, 1, 0]);

            // Model Matrix: Rotate around Y axis
            const mMatrix = mat4FromYRotation(mat4Create(), currentRotation);
            const mvp = mat4Create();
            mat4Multiply(mvp, vMatrix, mMatrix);
            mat4Multiply(mvp, pMatrix, mvp);

            // 1. Draw Pedestal
            if (pedestalVbo && pedestalProgram) {
                gl.useProgram(pedestalProgram);
                const uMVPLoc = gl.getUniformLocation(pedestalProgram, 'uMVP');
                const aPosLoc = gl.getAttribLocation(pedestalProgram, 'aPosition');
                const aColLoc = gl.getAttribLocation(pedestalProgram, 'aColor');

                gl.uniformMatrix4fv(uMVPLoc, false, mvp);
                gl.bindBuffer(gl.ARRAY_BUFFER, pedestalVbo);

                gl.enableVertexAttribArray(aPosLoc);
                gl.vertexAttribPointer(aPosLoc, 3, gl.FLOAT, false, 28, 0);

                gl.enableVertexAttribArray(aColLoc);
                gl.vertexAttribPointer(aColLoc, 4, gl.FLOAT, false, 28, 12);

                gl.disable(gl.CULL_FACE);
                gl.drawArrays(gl.TRIANGLES, 0, pedestalNumVerts);
                gl.disableVertexAttribArray(aPosLoc);
                gl.disableVertexAttribArray(aColLoc);
            }

            // 2. Draw Character Meshes
            gl.useProgram(program);
            const uMVP = gl.getUniformLocation(program, 'uMVP');
            const uModel = gl.getUniformLocation(program, 'uModel');
            const uLightDir = gl.getUniformLocation(program, 'uLightDir');
            const uEyePos = gl.getUniformLocation(program, 'uEyePos');
            const uAlpha = gl.getUniformLocation(program, 'uAlpha');
            const uSampler = gl.getUniformLocation(program, 'uSampler');

            const aPosition = gl.getAttribLocation(program, 'aPosition');
            const aNormal = gl.getAttribLocation(program, 'aNormal');
            const aTexCoord = gl.getAttribLocation(program, 'aTexCoord');

            gl.uniformMatrix4fv(uMVP, false, mvp);
            gl.uniformMatrix4fv(uModel, false, mMatrix);
            gl.uniform3f(uLightDir, 0.6, 0.8, 0.9);
            gl.uniform3f(uEyePos, 0, 8, cameraDist);
            gl.uniform1f(uAlpha, 1.0);
            gl.uniform1i(uSampler, 0);

            gl.enable(gl.DEPTH_TEST);
            gl.depthFunc(gl.LEQUAL);
            gl.disable(gl.CULL_FACE); // Preserve all model planes

            for (const part of activeModelData.parts) {
                if (!part.glData) continue;

                gl.bindBuffer(gl.ARRAY_BUFFER, part.glData.vboPos);
                gl.enableVertexAttribArray(aPosition);
                gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, 0, 0);

                gl.bindBuffer(gl.ARRAY_BUFFER, part.glData.vboNorm);
                gl.enableVertexAttribArray(aNormal);
                gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 0, 0);

                gl.bindBuffer(gl.ARRAY_BUFFER, part.glData.vboUv);
                gl.enableVertexAttribArray(aTexCoord);
                gl.vertexAttribPointer(aTexCoord, 2, gl.FLOAT, false, 0, 0);

                gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, part.glData.ibo);

                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, part.glTexture || null);

                gl.drawElements(gl.TRIANGLES, part.numIndices, gl.UNSIGNED_SHORT, 0);
            }

            gl.disableVertexAttribArray(aPosition);
            gl.disableVertexAttribArray(aNormal);
            gl.disableVertexAttribArray(aTexCoord);
        }

        requestAnimationFrame(renderFrame);
    }

    // -------------------------------------------------------------------------
    // User Interaction (Drag to Spin)
    // -------------------------------------------------------------------------
    function setupInteractions() {
        if (!canvas) return;

        canvas.addEventListener('pointerdown', (e) => {
            isDragging = true;
            lastPointerX = e.clientX;
            canvas.setPointerCapture(e.pointerId);
        });

        canvas.addEventListener('pointermove', (e) => {
            if (!isDragging) return;
            const dx = e.clientX - lastPointerX;
            lastPointerX = e.clientX;
            targetRotation -= dx * 0.015;
            currentRotation = targetRotation;
        });

        const stopDrag = (e) => {
            if (isDragging) {
                isDragging = false;
                try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
            }
        };

        canvas.addEventListener('pointerup', stopDrag);
        canvas.addEventListener('pointercancel', stopDrag);
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------
    async function setModel(modelId) {
        if (!modelId) modelId = 'steve';
        currentModelId = modelId;

        const titleEl = document.getElementById('showroom-model-title');
        const cleanNames = {
            'steve': 'Steve',
            'steve/alex': 'Alex',
            'sarge': 'Sarge',
            'visor': 'Visor',
            'major': 'Major',
            'grunt': 'Grunt'
        };
        if (titleEl) titleEl.textContent = cleanNames[modelId] || modelId;

        if (!gl) return;
        loadingModelId = modelId;
        const loaded = await loadCharacterModel(modelId);
        if (loadingModelId === modelId && loaded) {
            activeModelData = loaded;
            initPedestal(loaded.pedestalY);
        }
    }

    function init(vfsFiles) {
        if (vfsFiles) {
            vfsMap = vfsFiles;
            for (const [key, bytes] of vfsFiles.entries()) {
                if (key.endsWith('.pk3')) {
                    zipIndices.set(key, indexZipBuffer(bytes));
                }
            }
        }

        canvas = document.getElementById('showroom-canvas');
        if (!canvas) return;

        // Setup WebGL Context
        gl = canvas.getContext('webgl', { alpha: false, antialias: true, depth: true });
        if (!gl) {
            console.warn('[Showroom] WebGL not available for showroom.');
            return;
        }

        // Adjust for high-DPI displays
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        canvas.width = Math.round(canvas.clientWidth * dpr) || 300;
        canvas.height = Math.round(canvas.clientHeight * dpr) || 300;

        program = createProgram(gl, VS_SOURCE, FS_SOURCE);
        pedestalProgram = createProgram(gl, PEDESTAL_VS, PEDESTAL_FS);

        setupInteractions();
        setModel(currentModelId);
        requestAnimationFrame(renderFrame);
    }

    function setVisibility(visible) {
        isVisible = !!visible;
    }

    globalThis.Q3Showroom = Object.freeze({
        init,
        setModel,
        setVisibility
    });

    // Auto-init when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => init(null));
    } else {
        setTimeout(() => init(null), 10);
    }
})();
