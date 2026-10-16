import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { resolve, extname, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from './engine.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../web');
const rooms=new Map(); let nextPeer=2, creating=0;
const maxRooms=Math.min(4,Math.max(1,Number(process.env.MAX_ROOMS)||2));
const maps=['q3dm1','q3dm7','q3dm17','q3tourney2'];
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript','.wasm':'application/wasm','.json':'application/json'};
function frame(opcode,data=Buffer.alloc(0)) {
    const size=data.length, header=Buffer.alloc(size<126?2:4); header[0]=128|opcode;
    if(size<126) header[1]=size; else { header[1]=126; header.writeUInt16BE(size,2); }
    return Buffer.concat([header,data]);
}
async function makeRoom(name,map,mode='normal') {
    if(rooms.size+creating>=maxRooms)throw Error('Sunucu kapasitesi dolu. Mevcut bir maça katılın.');
    creating++;
    try {
    const room={id:randomBytes(3).toString('hex').toUpperCase(),ownerToken:randomBytes(32).toString('hex'),name,map,mode:mode==='lava'?'lava':'normal',peers:new Map(),emptySince:Date.now()};
    room.engine=await createEngine(root,(peer,data)=> {
    const socket=room.peers.get(peer);
    if(socket && !socket.destroyed) { if(socket.writableLength>1048576) socket.destroy(); else socket.write(frame(2,data)); }
    },map);
    room.engine.frame(); rooms.set(room.id,room); return room;
    } finally {creating--;}
}
function roomInfo(room){return {id:room.id,name:room.name,map:room.map,mode:room.mode||'normal',players:room.peers.size,maxPlayers:8};}
const server=http.createServer(async(req,res)=> {
    const json=(code,data)=> {res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
    if(req.url==='/healthz') {json(200,{ok:true,rooms:rooms.size});return;}
    if(req.url==='/api/rooms'&&req.method==='GET') {json(200,{rooms:[...rooms.values()].map(roomInfo),maps,maxRooms});return;}
    if(req.method==='GET'&&/^\/api\/rooms\/[A-F0-9]{6}$/.test(req.url)) {
        const roomId=req.url.split('/').pop();
        const room=rooms.get(roomId);
        if(!room){json(404,{error:'Oda bulunamadı.'});return;}
        json(200,roomInfo(room));return;
    }
    if(req.method==='DELETE'&&/^\/api\/rooms\/[A-F0-9]{6}$/.test(req.url)) {
        let origin;try{origin=new URL(req.headers.origin);}catch{json(403,{error:'Geçersiz istek kaynağı.'});return;}
        if(origin.host!==req.headers.host){json(403,{error:'Geçersiz istek kaynağı.'});return;}
        const room=rooms.get(req.url.split('/').pop());
        if(!room){json(404,{error:'Oda zaten kapatılmış.'});return;}
        const token=(req.headers.authorization||'').replace(/^Bearer /,'');
        if(!/^[a-f0-9]{64}$/.test(token)||!timingSafeEqual(Buffer.from(token,'hex'),Buffer.from(room.ownerToken,'hex'))){json(403,{error:'Bu odayı yalnızca oluşturan kişi silebilir.'});return;}
        rooms.delete(room.id);
        const close=Buffer.concat([Buffer.from([3,232]),Buffer.from('Room deleted')]);
        for(const socket of room.peers.values()){
            socket.end(frame(8,close));
            setTimeout(()=>socket.destroy(),500).unref();
        }
        json(200,{deleted:room.id});return;
    }
    if(req.url==='/api/rooms'&&req.method==='POST') {
        try {
            if(new URL(req.headers.origin).host!==req.headers.host)throw Error('Geçersiz istek kaynağı.');
            let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>1024)throw Error('İstek çok büyük.');}
            const data=JSON.parse(body), name=String(data.name||'Arkadaş Maçı').replace(/[\x00-\x1f\x7f]/g,'').trim().slice(0,40);
            if(!maps.includes(data.map))throw Error('Geçersiz harita.');
            const mode=data.mode==='lava'?'lava':'normal';
            const room=await makeRoom(name||'Arkadaş Maçı',data.map,mode);
            json(201,{...roomInfo(room),ownerToken:room.ownerToken});
        } catch(error){json(400,{error:error.message});} return;
    }
    if(!['GET','HEAD'].includes(req.method)) {res.writeHead(405);res.end();return;}
    let file;
    try { const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname); file=resolve(root,'.'+(pathname==='/'?'/index.html':pathname)); if(!file.startsWith(root+sep)||!statSync(file).isFile()) throw Error(); }
    catch {res.writeHead(404);res.end();return;}
    res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream','Content-Length':statSync(file).size,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});
    if(req.method==='HEAD') res.end(); else createReadStream(file).on('error',()=>res.destroy()).pipe(res);
});
server.on('upgrade',(req,socket,head)=> {
    const reject=()=> {socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');};
    let origin,url; try {origin=new URL(req.headers.origin);url=new URL(req.url,'http://localhost');} catch {reject();return;}
    const room=rooms.get(url.searchParams.get('room'));
    if(url.pathname!=='/play'||!room||origin.host!==req.headers.host||req.headers['sec-websocket-version']!=='13'||! /^[A-Za-z0-9+/]{22}==$/.test(req.headers['sec-websocket-key']||'')||room.peers.size>=8) {reject();return;}
    // IDs belong to sockets, never to user-supplied packet headers.
    const peer=nextPeer++; if(nextPeer>65535) nextPeer=2;
    if(room.peers.has(peer)) {reject();return;}
    const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
    room.peers.set(peer,socket); socket.setNoDelay(true);
    let pending=Buffer.alloc(0), budget=0, windowStart=Date.now(), alive=true;
    const heartbeat=setInterval(()=> {if(!alive) return socket.destroy(); alive=false; socket.write(frame(9));},30000);
    function receive(data) {
        pending=Buffer.concat([pending,data]);
        if(pending.length>65536) return socket.destroy();
        while(pending.length>=2) {
            const opcode=pending[0]&15;
            if(!(pending[0]&128)||(pending[0]&112)||!(pending[1]&128)) return socket.destroy();
            let length=pending[1]&127, offset=2;
            if(length===127) return socket.destroy();
            if(length===126) {if(pending.length<4)return; length=pending.readUInt16BE(2);offset=4;}
            if(length>16384||![2,8,9,10].includes(opcode)||(opcode>=8&&length>125)) return socket.destroy();
            if(pending.length<offset+4+length) return;
            const payload=Buffer.alloc(length); for(let i=0;i<length;i++) payload[i]=pending[offset+4+i]^pending[offset+(i%4)];
            pending=pending.subarray(offset+4+length);
            if(opcode===8) {socket.end(frame(8));return;}
            if(opcode===9) {socket.write(frame(10,payload));continue;}
            if(opcode===10) {alive=true;continue;}
            if(Date.now()-windowStart>=1000) {budget=0;windowStart=Date.now();}
            if(++budget>300) return socket.destroy();
            if(length) room.engine.packet(peer,payload);
        }
    }
    socket.on('data',receive); socket.on('error',()=>socket.destroy());
    socket.on('close',()=> {clearInterval(heartbeat);room.peers.delete(peer);room.engine.disconnect(peer);if(!room.peers.size)room.emptySince=Date.now();});
    if(head.length) receive(head);
});
const timer=setInterval(()=> {for(const room of rooms.values()) {try {room.engine.frame();if(!room.peers.size&&Date.now()-room.emptySince>300000)rooms.delete(room.id);} catch(e) {console.error(e);for(const socket of room.peers.values())socket.destroy();rooms.delete(room.id);}}},10);
server.listen(Number(process.env.PORT||8081),process.env.BIND_HOST||'127.0.0.1',()=>console.log('WebArena listening',server.address()));
function shutdown() {clearInterval(timer); for(const room of rooms.values())for(const socket of room.peers.values())socket.destroy();server.close(()=>process.exit(0));}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
