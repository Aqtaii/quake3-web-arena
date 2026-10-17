import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readGameData } from './game-data.mjs';
const packageCache=new Map();

// The same original-source WASM runs in dedicated mode; no replacement physics.
export async function createEngine(root, send, map = 'q3dm1') {
    const files = new Map(), handles = new Map(), queue = [];
    let nextFd = 3, exports, memory, lastPeer = 0;
    const manifest = readGameData(root);
    if (!manifest.maps.includes(map)) throw Error('Unsupported map');
    for (const name of manifest.serverPackages) {
        if (!/^(?:pak[0-9]+|inferno-(?:map|textures-[0-9]{2}))\.pk3$/.test(name)) throw Error('Invalid package');
        const path=join(root,'baseq3',name);
        if(!packageCache.has(path))packageCache.set(path,readFileSync(path));
        files.set('baseq3/' + name, packageCache.get(path));
    }
    const bytes = (ptr, len) => new Uint8Array(memory.buffer, ptr, len);
    const str = ptr => { const b = new Uint8Array(memory.buffer); let end = ptr; while (b[end]) end++; return new TextDecoder().decode(b.subarray(ptr, end)); };
    const norm = p => p.replaceAll('\\', '/').replace(/^(\.\/|\/)+/, '').toLowerCase();
    const env = {
        js_time_ms: () => Math.floor(performance.now()), js_time_sec: () => Math.floor(Date.now()/1000),
        js_console_print: (p,n) => process.stdout.write(new TextDecoder().decode(bytes(p,n))),
        js_abort_frame: () => { throw Object.assign(Error('Q3 frame abort'), { frameAbort: true }); },
        js_exit: code => { throw Error('Q3 exited: ' + code); },
        js_net_receive: (p,n) => { const packet = queue.shift(); if (!packet) return 0; lastPeer=packet.peer; if(packet.data.length>n) return 0; bytes(p,packet.data.length).set(packet.data); return packet.data.length; },
        js_net_peer: () => lastPeer,
        js_net_send: (p,n,peer) => send(peer, Buffer.from(bytes(p,n))),
        js_vfs_open: (p,m) => { const key=norm(str(p)), mode=str(m), writable=/[wa]/.test(mode); if(!files.has(key)&&!writable) return -1; if(mode.includes('w')||!files.has(key)) files.set(key,new Uint8Array()); const fd=nextFd++; handles.set(fd,{key,pos:mode.includes('a')?files.get(key).length:0,writable}); return fd; },
        js_vfs_close: fd => { handles.delete(fd); return 0; },
        js_vfs_read: (fd,p,n) => { const f=handles.get(fd); if(!f) return -1; const data=files.get(f.key), count=Math.min(n,Math.max(0,data.length-f.pos)); bytes(p,count).set(data.subarray(f.pos,f.pos+count)); f.pos+=count; return count; },
        js_vfs_write: (fd,p,n) => { const f=handles.get(fd); if(!f?.writable) return -1; let data=files.get(f.key); if(f.pos+n>data.length) { const expanded=new Uint8Array(f.pos+n); expanded.set(data); files.set(f.key,data=expanded); } data.set(bytes(p,n),f.pos); f.pos+=n; return n; },
        js_vfs_seek: (fd,n,w) => { const f=handles.get(fd); if(!f||w<0||w>2) return -1; const pos=(w===0?0:w===1?f.pos:files.get(f.key).length)+n; if(pos<0) return -1; f.pos=pos; return 0; },
        js_vfs_tell: fd => handles.get(fd)?.pos ?? -1,
        js_vfs_eof: fd => { const f=handles.get(fd); return !f||f.pos>=files.get(f.key).length?1:0; },
        js_vfs_remove: p => files.delete(norm(str(p)))?0:-1,
        js_vfs_list_files: (d,e,p,n) => { const dir=norm(str(d)), ext=str(e).toLowerCase(), prefix=dir?dir+'/':''; let used=0,count=0; for(const key of [...files.keys()].sort()) { if(!key.startsWith(prefix)) continue; const rest=key.slice(prefix.length); if(rest.includes('/')||(ext&&!rest.endsWith(ext.startsWith('.')?ext:'.'+ext))) continue; const encoded=new TextEncoder().encode(rest+'\n'); if(used+encoded.length>=n) break; bytes(p+used,encoded.length).set(encoded); used+=encoded.length; count++; } if(n>0) bytes(p+used,1)[0]=0; return count; },
    };
    for (const name of ['sin','cos','tan','asin','acos','atan','atan2','pow','exp','log']) env['js_'+name]=Math[name];
    const module = await WebAssembly.compile(readFileSync(join(root,'quake3.wasm')));
    for(const entry of WebAssembly.Module.imports(module)) {
        if(!env[entry.name]) {
            if(!/^js_(gl_|audio_|q3_)/.test(entry.name)) throw Error('Unknown import: '+entry.name);
            env[entry.name]=() => {};
        }
    }
    exports=(await WebAssembly.instantiate(module,{env})).exports; memory=exports.memory;
    function command(text, init=false) { const data=new TextEncoder().encode(text+'\0'), p=exports.wasm_q3_alloc(data.length); bytes(p,data.length).set(data); try { (init?exports.wasm_q3_init:exports.wasm_q3_console_command)(p); } finally { exports.wasm_q3_free(p); } }
    command('+set dedicated 1 +set sv_pure 0 +set vm_game 0 +set vm_cgame 0 +set vm_ui 0 +set sv_maxclients 8 +set sv_hostname WebArena +set g_gametype 0 +set rconPassword "" +set sv_floodProtect 1 +set sv_timeout 20 +set sv_zombietime 2 +set sv_allowDownload 0 +map '+map,true);
    return {
        packet(peer,data) { if(queue.length<1024 && data.length<=16384) queue.push({peer,data}); },
        disconnect(peer) { for(let i=queue.length-1;i>=0;i--)if(queue[i].peer===peer)queue.splice(i,1);exports.wasm_q3_drop_peer(peer); },
        frame() { const sp=exports.__stack_pointer.value; try { exports.wasm_q3_frame(); } catch(e) { if(!e.frameAbort) throw e; exports.__stack_pointer.value=sp; } },
        status() { return Array.from(new Float32Array(memory.buffer,exports.wasm_q3_status(),16)); },
        command,
    };
}
