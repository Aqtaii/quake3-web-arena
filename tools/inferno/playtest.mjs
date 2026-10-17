// Own Node/Chrome harness: runs only in the cloud, with no npm dependencies.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const root=resolve(process.argv[2]||'.'), map=process.argv[3]||'inferno_wingman';
const output=resolve(process.argv[4]||'reports');mkdirSync(output,{recursive:true});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const base='http://127.0.0.1:18082',pending=new Map();
const profile=mkdtempSync(join(tmpdir(),'inferno-playtest-'));
let serverLog='',socket,call,chrome,room,watchdog,sequence=0;
const server=spawn(process.execPath,['server/server.mjs'],{cwd:root,env:{...process.env,PORT:'18082',MAX_ROOMS:'1'},stdio:['ignore','pipe','pipe']});
server.stdout.on('data',b=>serverLog+=b);server.stderr.on('data',b=>serverLog+=b);
const report={map,passed:false,clients:[],errors:[]};
try {
    let healthy=false;
    for(let i=0;i<150;i++){try{if((await fetch(base+'/healthz')).ok){healthy=true;break;}}catch{}await delay(100);}
    assert(healthy,'Server failed to start');
    const response=await fetch(base+'/api/rooms',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({name:'Inferno cloud playtest',map})});
    room=await response.json();assert.equal(response.status,201,JSON.stringify(room));
    chrome=spawn(process.env.CHROME_BIN||'google-chrome',[
        '--headless=new','--no-sandbox','--disable-dev-shm-usage',
        '--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader',
        '--disable-background-timer-throttling','--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows','--autoplay-policy=no-user-gesture-required',
        '--no-first-run','--no-default-browser-check','--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'
    ],{stdio:['ignore','ignore','pipe']});
    let chromeLog='';chrome.stderr.on('data',b=>{chromeLog=(chromeLog+b).slice(-20000);});
    const active=join(profile,'DevToolsActivePort');
    for(let i=0;i<200&&!existsSync(active);i++){assert(chrome.exitCode===null,chromeLog);await delay(100);}
    assert(existsSync(active),'Chrome debugging endpoint failed');
    const [port,path]=readFileSync(active,'utf8').trim().split('\n');
    socket=new WebSocket('ws://127.0.0.1:'+port+path);
    await new Promise((ok,no)=>{socket.addEventListener('open',ok,{once:true});socket.addEventListener('error',no,{once:true});});
    socket.addEventListener('message',event=>{
        const message=JSON.parse(event.data),item=pending.get(message.id);
        if(item){pending.delete(message.id);message.error?item.reject(Error(JSON.stringify(message.error))):item.resolve(message.result);}
        else if(message.method==='Runtime.exceptionThrown')report.errors.push(message.params.exceptionDetails);
    });
    call=(method,params={},sessionId)=>new Promise((resolveCall,reject)=>{
        const id=++sequence;pending.set(id,{resolve:resolveCall,reject});
        socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));
    });
    watchdog=setTimeout(()=>{for(const item of pending.values())item.reject(Error('Playtest timeout'));},8*60*1000);
    const evaluate=async(session,expression)=>{
        const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},session);
        if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));
        return result.result?.value;
    };
    const sessions=[];
    for(let i=0;i<2;i++){
        const target=await call('Target.createTarget',{url:'about:blank'});
        const attached=await call('Target.attachToTarget',{targetId:target.targetId,flatten:true}),session=attached.sessionId;
        sessions.push(session);await call('Runtime.enable',{},session);await call('Page.enable',{},session);
        await call('Emulation.setDeviceMetricsOverride',{width:960,height:720,deviceScaleFactor:1,mobile:false},session);
        await call('Page.navigate',{url:base+'/?test=1&room='+room.id},session);
        let ready=false;
        for(let t=0;t<180;t++){if(await evaluate(session,'!!window.Q3Test')){ready=true;break;}await delay(1000);}
        assert(ready,'Client '+i+' failed to initialize');
        await evaluate(session,'document.getElementById("player-name").value="Cloud'+i+'";document.getElementById("btn-online").click();true');
        let state;
        for(let t=0;t<180;t++){state=await evaluate(session,'Q3Test.status()');if(state.active&&state.map===map)break;await delay(1000);}
        report.clients.push(state);assert(state.active&&state.map===map,'Client did not enter map: '+JSON.stringify(state));
        console.log('Client active',i,JSON.stringify(state));
    }
    await delay(5000);
    for(let i=0;i<sessions.length;i++){
        const session=sessions[i],status=await evaluate(session,'Q3Test.status()');
        const peers=await evaluate(session,'Q3Test.remotePlayers()');
        report.clients[i]={...status,remotePlayers:peers};
        assert(status.active&&status.map===map,'Client disconnected');
        assert(status.origin.every(Number.isFinite),'Invalid player position');
        assert(status.origin[2]>-100,'Player fell through source collision');
        // Quake intentionally omits players outside this viewpoint's PVS.
        // If needed, the follow test below verifies authoritative remote state.
        const shot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},session);
        writeFileSync(join(output,'inferno-client-'+i+'.png'),Buffer.from(shot.data,'base64'));
        writeFileSync(join(output,'client-'+i+'.log'),await evaluate(session,'Q3Test.log()'));
    }
    // Walking uses the genuine Quake input and server physics.
    const before=await evaluate(sessions[0],'Q3Test.status().origin');
    await evaluate(sessions[0],'Q3Test.key(119,true);true');await delay(750);
    await evaluate(sessions[0],'Q3Test.key(119,false);true');await delay(500);
    const after=await evaluate(sessions[0],'Q3Test.status().origin');
    report.walk={before,after,distance:Math.hypot(...after.map((v,i)=>v-before[i]))};
    assert(after[2]>-100,'Walking fell through source collision');
    assert(report.walk.distance>.5,'Forward movement failed; inspect spawn clearance');
    const other=report.clients[1].clientNum;
    if(report.clients[0].remotePlayers.some(p=>p.id===other)){
        report.replication={method:'visible snapshot entity',client:other};
    }else{
        // Original spectator follow moves the snapshot viewpoint to the other
        // player without cheats or changing visibility/collision rules.
        await evaluate(sessions[0],'Q3Test.command("team spectator");true');
        await delay(1500);
        await evaluate(sessions[0],'Q3Test.command("follow '+other+'");true');
        await delay(2000);
        const followed=await evaluate(sessions[0],'Q3Test.status()');
        const target=await evaluate(sessions[1],'Q3Test.status()');
        assert.equal(followed.clientNum,other,'Spectator did not receive followed player state');
        assert(Math.hypot(...followed.origin.map((v,i)=>v-target.origin[i]))<4,'Remote follow origin differs');
        report.replication={method:'original spectator follow across PVS',client:other,followed:followed.origin,target:target.origin};
    }
    const roomState=await(await fetch(base+'/api/rooms/'+room.id)).json();
    assert.equal(roomState.players,2,'Both genuine network clients must remain connected');
    assert.equal(report.errors.length,0,'Unhandled browser exceptions occurred');
    report.passed=true;
    console.log('PASS two real WASM clients joined original Inferno geometry, replicated and walked',JSON.stringify(report));
} catch(error) {
    report.failure=error.stack;console.error(error);
    process.exitCode=1;
} finally {
    writeFileSync(join(output,'runtime.json'),JSON.stringify(report,null,2));
    writeFileSync(join(output,'server.log'),serverLog);
    clearTimeout(watchdog);
    if(call&&socket?.readyState===WebSocket.OPEN)await Promise.race([call('Browser.close'),delay(2000)]).catch(()=>{});
    socket?.close();
    for(const child of [chrome,server].filter(Boolean)){
        if(child.exitCode===null)child.kill('SIGTERM');
        if(child.exitCode===null)await Promise.race([new Promise(r=>child.once('close',r)),delay(3000)]);
        if(child.exitCode===null)child.kill('SIGKILL');
    }
    if(profile.startsWith(join(tmpdir(),'inferno-playtest-')))try{rmSync(profile,{recursive:true,force:true,maxRetries:5});}catch{}
}
