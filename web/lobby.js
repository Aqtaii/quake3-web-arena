window.Q3Lobby=(()=>{
    let join,ready=false,currentRoom='';
    const knownRooms=new Map();
    const code=document.getElementById('room-code'),list=document.getElementById('room-list'),error=document.getElementById('lobby-error');
    let owners={};try{owners=JSON.parse(localStorage.getItem('q3-room-owners')||'{}')||{};}catch{}
    const initial=new URLSearchParams(location.search).get('room');if(initial)code.value=initial.toUpperCase();
    const trash='<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg>';
    function saveOwners(){try{localStorage.setItem('q3-room-owners',JSON.stringify(owners));}catch{}}
    function updateDelete(){const button=document.getElementById('btn-delete-room');button.hidden=!owners[currentRoom];}
    async function request(path,options){const response=await fetch(path,options),data=await response.json();if(!response.ok)throw Error(data.error||'Sunucuya ulaşılamadı.');return data;}
    async function removeRoom(id,name){
        if(!owners[id]||!confirm(`“${name||id}” odası silinsin mi? İçindeki oyuncuların bağlantısı kapanacak.`))return;
        try{
            await request('/api/rooms/'+id,{method:'DELETE',headers:{Authorization:'Bearer '+owners[id]}});
            delete owners[id];saveOwners();updateDelete();error.textContent='';
            if(currentRoom===id){document.getElementById('btn-offline').click();currentRoom='';code.value='';const url=new URL(location.href);url.searchParams.delete('room');history.replaceState(null,'',url);updateDelete();}
            await refresh();
        }catch(e){error.textContent=e.message;document.getElementById('network-status').textContent=e.message;}
    }
    async function refresh(){
        try{
            const data=await request('/api/rooms');list.replaceChildren();knownRooms.clear();
            for(const room of data.rooms){
                knownRooms.set(room.id,room);
                const row=document.createElement('div');row.className='room-entry';
                const button=document.createElement('button');button.type='button';button.className='room-join';
                const modeBadge=room.mode==='lava'?' · 🌋 LAV':'';
                button.textContent=`${room.name} · ${room.map}${modeBadge} · ${room.players}/${room.maxPlayers}`;
                button.disabled=room.players>=room.maxPlayers;
                button.addEventListener('click',()=>{code.value=room.id;join(room.id);});
                row.append(button);
                if(owners[room.id]){const remove=document.createElement('button');remove.type='button';remove.className='room-delete';remove.title='Odayı sil';remove.setAttribute('aria-label',room.name+' odasını sil');remove.innerHTML=trash;remove.onclick=()=>removeRoom(room.id,room.name);row.append(remove);}
                list.append(row);
            }
            if(!data.rooms.length){const p=document.createElement('p');p.textContent='Henüz sunucu yok. İlk sunucuyu oluştur.';list.append(p);}
            document.getElementById('btn-create').disabled=data.rooms.length>=data.maxRooms;
            document.getElementById('room-capacity').textContent=data.rooms.length>=data.maxRooms?'Sunucu sınırına ulaşıldı. Açık bir sunucuya katılabilir veya kendi odanı silebilirsin.':'';
            updateDelete();
        }catch(e){error.textContent='Sunucu listesi alınamadı. Online sunucunun çalıştığından emin ol.';}
    }
    return {
        init(callback){if(ready)return;ready=true;join=callback;refresh();setInterval(()=>{if(!document.body.classList.contains('online'))refresh();},5000);
            document.getElementById('btn-create').onclick=async()=>{const button=document.getElementById('btn-create');button.disabled=true;error.textContent='';try{const mode=document.getElementById('lobby-game-mode')?.value||'normal';const room=await request('/api/rooms',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:document.getElementById('room-name').value,map:document.getElementById('room-map').value,mode})});knownRooms.set(room.id,room);owners[room.id]=room.ownerToken;saveOwners();code.value=room.id;await join(room.id);refresh();}catch(e){error.textContent=e.message;button.disabled=false;}};
            document.getElementById('btn-delete-room').onclick=()=>removeRoom(currentRoom,currentRoom);
            document.getElementById('btn-copy-link').onclick=async()=>{try{await navigator.clipboard.writeText(location.href);document.getElementById('network-status').textContent='Davet bağlantısı kopyalandı';}catch{document.getElementById('network-status').textContent='Davet için adres çubuğundaki bağlantıyı paylaş';}};
        },
        show(visible){document.getElementById('lobby').hidden=!visible;document.getElementById('status-overlay').classList.toggle('ready',visible);},
        error(message){error.textContent=message;},
        selected(){return code.value.trim().toUpperCase();},
        joined(id){currentRoom=id;const url=new URL(location.href);url.searchParams.set('room',id);history.replaceState(null,'',url);document.getElementById('room-label').textContent=id;updateDelete();},
        getRoom(id){return knownRooms.get(id);},
    };
})();
