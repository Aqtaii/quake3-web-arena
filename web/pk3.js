/* PK3 directory inspection only. Engine decompression remains in id's unzip.c. */
(() => {
    'use strict';
    function listEntries(buffer) {
        const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const fail = () => { throw new Error('Geçersiz veya desteklenmeyen PK3/ZIP dizini.'); };
        if (bytes.length < 22) fail();
        let end = -1;
        for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
            if (view.getUint32(offset, true) === 0x06054b50 &&
                offset + 22 + view.getUint16(offset + 20, true) === bytes.length) {
                end = offset;
                break;
            }
        }
        if (end < 0 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) fail();
        const count = view.getUint16(end + 10, true);
        const size = view.getUint32(end + 12, true);
        let cursor = view.getUint32(end + 16, true);
        if (count === 0xffff || size === 0xffffffff || cursor + size !== end ||
            view.getUint16(end + 8, true) !== count) fail();
        const entries = [];
        const decoder = new TextDecoder('utf-8');
        for (let index = 0; index < count; index++) {
            if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) fail();
            const flags = view.getUint16(cursor + 8, true);
            const method = view.getUint16(cursor + 10, true);
            const compressedSize = view.getUint32(cursor + 20, true);
            const length = view.getUint32(cursor + 24, true);
            const nameLength = view.getUint16(cursor + 28, true);
            const next = cursor + 46 + nameLength + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
            const local = view.getUint32(cursor + 42, true);
            if ((flags & 1) || ![0, 8].includes(method) || next > end ||
                local + 30 > cursor || view.getUint32(local, true) !== 0x04034b50) fail();
            const dataOffset = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
            if (dataOffset + compressedSize > cursor) fail();
            const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)).replace(/\\/g, '/').toLowerCase();
            entries.push({ name, length });
            cursor = next;
        }
        if (cursor !== end) fail();
        return entries;
    }

    function isGeneratedDemo(entries) {
        return entries.some(entry => entry.name === 'maps/q3wasm_fixture.bsp') ||
            (entries.some(entry => entry.name === 'maps/q3dm1.bsp' && entry.length === 20032) &&
             entries.some(entry => entry.name === 'botfiles/weapons.c' && entry.length === 16));
    }

    function mapNames(entries) {
        return [...new Set(entries.map(entry => /^maps\/([a-z0-9_-]+)\.bsp$/.exec(entry.name))
            .filter(Boolean).map(match => match[1]))].sort();
    }
    globalThis.Q3Pk3 = Object.freeze({ listEntries, mapNames, isGeneratedDemo });
})();
