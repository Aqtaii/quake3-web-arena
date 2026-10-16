window.Q3Lobby=(()=>{
    let join,ready=false;
    const code=document.getElementById('room-code'),list=document.getElementById('room-list'),error=document.getElementById('lobby-error');
    const initial=new URLSearchParams(location.search).get('room');if(initial)code.value=initial.toUpperCase();
    async function request(path,options){const response=await fetch(path,options),data=await response.json();if(!response.ok)throw Error(data.error||'Sunucuya ulaşılamadı.');return data;}
    async function refresh(){
        try{const data=await request('/api/rooms');list.replaceChildren();for(const room of data.rooms){const button=document.createElement('button');button.type='button';button.textContent=`${room.name} · ${room.map} · ${room.players}/${room.maxPlayers}`;button.disabled=room.players>=room.maxPlayers;button.addEventListener('click',()=>{code.value=room.id;join(room.id);});list.append(button);}if(!data.rooms.length){const p=document.createElement('p');p.textContent='Henüz sunucu yok. İlk sunucuyu oluştur.';list.append(p);}document.getElementById('btn-create').disabled=data.rooms.length>=data.maxRooms;document.getElementById('room-capacity').textContent=data.rooms.length>=data.maxRooms?'Sunucu sınırına ulaşıldı. Açık sunuculardan birine katılabilirsin.':'';}
        catch(e){error.textContent='Sunucu listesi alınamadı. Online sunucunun çalıştığından emin ol.';}
    }
    return {
        init(callback){if(ready)return;ready=true;join=callback;refresh();setInterval(()=>{if(!document.body.classList.contains('online'))refresh();},5000);
            document.getElementById('btn-create').onclick=async()=>{const button=document.getElementById('btn-create');button.disabled=true;error.textContent='';try{const room=await request('/api/rooms',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:document.getElementById('room-name').value,map:document.getElementById('room-map').value})});code.value=room.id;await join(room.id);refresh();}catch(e){error.textContent=e.message;button.disabled=false;}};
            document.getElementById('btn-copy-link').onclick=async()=>{try{await navigator.clipboard.writeText(location.href);document.getElementById('network-status').textContent='Davet bağlantısı kopyalandı';}catch{document.getElementById('network-status').textContent='Davet için adres çubuğundaki bağlantıyı paylaş';}};
        },
        show(visible){document.getElementById('lobby').hidden=!visible;document.getElementById('status-overlay').classList.toggle('ready',visible);},
        error(message){error.textContent=message;},
        selected(){return code.value.trim().toUpperCase();},
        joined(id){const url=new URL(location.href);url.searchParams.set('room',id);history.replaceState(null,'',url);document.getElementById('room-label').textContent=id;},
    };
})();

