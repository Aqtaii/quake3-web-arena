// Binary Q3 packets travel unchanged over a same-origin WebSocket.
window.Q3Network = (() => {
    let socket=null, queue=[], generation=0;
    const status=document.getElementById('network-status');
    const label=text=>{status.textContent=text;};
    return {
        receive(memory,ptr,max) {const data=queue.shift(); if(!data||data.length>max)return 0; new Uint8Array(memory.buffer,ptr,data.length).set(data);return data.length;},
        send(memory,ptr,length,peer) {if(peer===1&&socket?.readyState===WebSocket.OPEN&&socket.bufferedAmount<262144) socket.send(new Uint8Array(memory.buffer,ptr,length));},
        async connect(room) {
            if(!/^[A-F0-9]{6}$/.test(room))throw Error('Geçerli bir sunucu kodu gir.');
            this.close();const token=++generation;
            label('Sunucuya bağlanılıyor…');
            return new Promise((resolve,reject)=> {
                const ws=socket=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/play?room=${room}`);ws.binaryType='arraybuffer';
                const timeout=setTimeout(()=>{ws.close();reject(Error('Sunucu bağlantısı zaman aşımına uğradı.'));},15000);
                ws.onopen=()=> {clearTimeout(timeout);label('Ortak sunucuya bağlı · Maç yükleniyor');resolve();};
                ws.onmessage=event=> {if(token===generation&&event.data instanceof ArrayBuffer&&event.data.byteLength<=16384&&queue.length<512)queue.push(new Uint8Array(event.data));};
                ws.onerror=()=> {clearTimeout(timeout);reject(Error('Sunucuya bağlanılamadı. Sunucu kodunu kontrol edip tekrar dene.'));};
                ws.onclose=()=> {clearTimeout(timeout);if(token===generation){queue=[];document.body.classList.remove('online');label('Sunucu bağlantısı kapandı. Yeniden katılabilirsiniz.');window.dispatchEvent(new Event('q3-network-closed'));}reject(Error('Sunucu bağlantısı kapandı.'));};
            });
        },
        close() {generation++;if(socket)socket.close();socket=null;queue=[];document.body.classList.remove('online');label('Maça katılarak arkadaşlarınla oyna');},
        active() {return socket?.readyState===WebSocket.OPEN;},
        busy() {return socket?.readyState===WebSocket.CONNECTING||socket?.readyState===WebSocket.OPEN;},
        playing(active) {if(socket?.readyState===WebSocket.OPEN){document.body.classList.toggle('online',active);label(active?'Online · Ortak sunucu':'Maça bağlanılıyor…');}},
    };
})();
