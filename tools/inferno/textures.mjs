// Convert original exported albedo images using the cloud runner's browser.
// No npm packages. Usage: node textures.mjs EXPORT_ROOT JOBS_JSON BASEQ3_ROOT
import http from 'node:http';
import {createReadStream, existsSync, readFileSync, mkdirSync, writeFileSync, mkdtempSync, rmSync} from 'node:fs';
import {resolve, sep, join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';

if(process.argv.length!==5)throw Error('Expected export root, jobs JSON and baseq3 root');
const [exportRoot,jobsFile,outputRoot]=process.argv.slice(2).map(p=>resolve(p));
const jobs=JSON.parse(readFileSync(jobsFile,'utf8'));
const pending=new Map(),completed=new Set();
function contained(root,name){
    const path=resolve(root,name);
    if(!path.startsWith(root+sep))throw Error('Asset path escapes root');
    return path;
}
const page=String.raw`<!doctype html><meta charset="utf-8"><script>
window.run=async()=>{
  const jobs=await (await fetch('/jobs')).json();
  for(let id=0;id<jobs.length;id++){
    const job=jobs[id];
    const canvas=new OffscreenCanvas(1,1),context=canvas.getContext('2d',{willReadFrequently:true});
    if(job.input){
      const blob=await (await fetch('/asset?path='+encodeURIComponent(job.input))).blob();
      const bitmap=await createImageBitmap(blob,{premultiplyAlpha:'none',colorSpaceConversion:'none'});
      canvas.width=bitmap.width;canvas.height=bitmap.height;
      context.drawImage(bitmap,0,0);bitmap.close();
    }else{context.fillStyle='#fff';context.fillRect(0,0,1,1);}
    const {width:w,height:h}=canvas;
    if(w>16384||h>16384)throw Error('Texture dimensions exceed limit');
    const pixels=context.getImageData(0,0,w,h).data;
    const bytes=new Uint8Array(18+w*h*4),view=new DataView(bytes.buffer);
    bytes[2]=2;view.setUint16(12,w,true);view.setUint16(14,h,true);bytes[16]=32;bytes[17]=40;
    const factor=job.factor||[1,1,1,1];
    const tables=factor.slice(0,3).map(f=>Uint8Array.from({length:256},(_,c)=>{
      const s=c/255,linear=s<=.04045?s/12.92:Math.pow((s+.055)/1.055,2.4);
      const value=Math.max(0,Math.min(1,linear*f));
      return Math.round(255*(value<=.0031308?value*12.92:1.055*Math.pow(value,1/2.4)-.055));
    }));
    for(let p=0;p<pixels.length;p+=4){
      bytes[18+p]=tables[2][pixels[p+2]];bytes[19+p]=tables[1][pixels[p+1]];
      bytes[20+p]=tables[0][pixels[p]];
      const alpha=pixels[p+3]*factor[3];
      bytes[21+p]=job.alphaMode==='MASK'?(alpha>=255*(job.alphaCutoff??.5)?255:0):
        job.alphaMode==='BLEND'?Math.round(alpha):255;
    }
    const response=await fetch('/output?id='+id,{method:'POST',body:bytes});
    if(!response.ok)throw Error(await response.text());
    canvas.width=1;canvas.height=1;
  }
  return {converted:jobs.length};
};
</script>`;
const server=http.createServer(async(req,res)=>{
    try{
        const url=new URL(req.url,'http://localhost');
        if(req.method==='GET'&&url.pathname==='/'){res.setHeader('Content-Type','text/html');res.end(page);return;}
        if(req.method==='GET'&&url.pathname==='/jobs'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(jobs));return;}
        if(req.method==='GET'&&url.pathname==='/asset'){
            const file=contained(exportRoot,url.searchParams.get('path'));
            if(!existsSync(file))throw Error('Missing source texture');
            createReadStream(file).on('error',()=>res.destroy()).pipe(res);return;
        }
        if(req.method==='POST'&&url.pathname==='/output'){
            const id=Number(url.searchParams.get('id'));
            if(!Number.isInteger(id)||!jobs[id]||completed.has(id))throw Error('Invalid conversion job');
            const chunks=[];let size=0;
            for await(const chunk of req){size+=chunk.length;if(size>256*1024*1024)throw Error('Texture too large');chunks.push(chunk);}
            const data=Buffer.concat(chunks);
            if(data.length<18||data[2]!==2||data[16]!==32)throw Error('Invalid TGA output');
            const expected=18+data.readUInt16LE(12)*data.readUInt16LE(14)*4;
            if(data.length!==expected)throw Error('Incomplete TGA output');
            const target=contained(outputRoot,jobs[id].output);
            mkdirSync(resolve(target,'..'),{recursive:true});writeFileSync(target,data);completed.add(id);
            if(completed.size%50===0||completed.size===jobs.length)console.log('Textures converted',completed.size,'/',jobs.length);
            res.end('ok');return;
        }
        res.writeHead(404);res.end();
    }catch(e){res.writeHead(400);res.end(e.message);}
});
await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
const chromeDir=mkdtempSync(join(tmpdir(),'inferno-chrome-'));
const chrome=spawn(process.env.CHROME_BIN||'google-chrome',[
    '--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu',
    '--no-first-run','--no-default-browser-check','--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0','--user-data-dir='+chromeDir,'about:blank',
],{stdio:['ignore','ignore','pipe']});
chrome.stderr.on('data',()=>{});
chrome.on('error',error=>{for(const item of pending.values())item.reject(error);});
let socket,sequence=0,watchdog,call;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
try{
    const active=join(chromeDir,'DevToolsActivePort');
    for(let i=0;i<300&&!existsSync(active);i++){if(chrome.exitCode!==null)throw Error('Chrome exited during startup');await delay(100);}
    if(!existsSync(active))throw Error('Chrome debugging endpoint did not start');
    const [port,path]=readFileSync(active,'utf8').trim().split('\n');
    socket=new WebSocket('ws://127.0.0.1:'+port+path);
    await new Promise((ok,no)=>{socket.addEventListener('open',ok,{once:true});socket.addEventListener('error',no,{once:true});});
    socket.addEventListener('message',event=>{const message=JSON.parse(event.data),item=pending.get(message.id);if(item){pending.delete(message.id);message.error?item.reject(Error(JSON.stringify(message.error))):item.resolve(message.result);}});
    call=(method,params={},sessionId)=>new Promise((resolveCall,reject)=>{
        const id=++sequence;pending.set(id,{resolve:resolveCall,reject});
        socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));
    });
    watchdog=setTimeout(()=>{for(const item of pending.values())item.reject(Error('Texture conversion timeout'));},15*60*1000);
    const target=await call('Target.createTarget',{url:'http://127.0.0.1:'+server.address().port});
    const attached=await call('Target.attachToTarget',{targetId:target.targetId,flatten:true});
    const session=attached.sessionId;
    for(let i=0;i<100;i++){
        const ready=await call('Runtime.evaluate',{expression:'typeof window.run==="function"',returnByValue:true},session);
        if(ready.result?.value)break;
        if(i===99)throw Error('Conversion page failed to load');
        await delay(100);
    }
    const result=await call('Runtime.evaluate',{expression:'window.run()',awaitPromise:true,returnByValue:true},session);
    if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));
    if(completed.size!==jobs.length)throw Error('Not every texture was converted');
    console.log(result.result.value);
}finally{
    clearTimeout(watchdog);
    if(call&&socket?.readyState===WebSocket.OPEN){
        await Promise.race([call('Browser.close'),delay(2000)]).catch(()=>{});
    }
    socket?.close();
    if(chrome.exitCode===null)chrome.kill('SIGTERM');
    if(chrome.exitCode===null)await Promise.race([new Promise(r=>chrome.once('close',r)),delay(5000)]);
    if(chrome.exitCode===null)chrome.kill('SIGKILL');
    server.closeAllConnections();server.close();
    // Only this process's fresh temporary profile is removed.
    if(chromeDir.startsWith(join(tmpdir(),'inferno-chrome-'))){
        try{rmSync(chromeDir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
        catch{console.log('Temporary browser profile will be removed with the ephemeral runner.');}
    }
}
