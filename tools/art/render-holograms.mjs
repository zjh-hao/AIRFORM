import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {setTimeout as wait} from 'node:timers/promises';
import {dependency} from '../../web/dependencies.js';

const output=process.argv[2];
const study=process.argv.includes('--study');
if(!output)throw Error('Pass a directory for the transparent source frames');
const root=fileURLToPath(new URL('../../web/',import.meta.url));
const {createServer}=await import(pathToFileURL(dependency('vite')).href);
const vite=await createServer({root,configLoader:'runner',server:{host:'127.0.0.1',port:0},logLevel:'error'});
await vite.listen();
const base= 'http://127.0.0.1:'+vite.httpServer.address().port;
const profile=await mkdtemp(join(tmpdir(),'kineglow-models-'));
const edge=spawn(process.env.KINEGLOW_BROWSER??'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ['--headless=new','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--disable-background-networking',base],{windowsHide:true,stdio:'ignore'});
let socket;
try {
  let port;
  for(let i=0;i<120&&!port;i++){try{port=parseInt(await readFile(join(profile,'DevToolsActivePort'),'utf8'));}catch{await wait(100);}}
  const pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();
  socket=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  const pending=new Map();let id=0;
  socket.onmessage=e=>{const msg=JSON.parse(e.data);pending.get(msg.id)?.(msg);pending.delete(msg.id);};
  const evalJs=async expression=>{
    const seq=++id;
    const result=new Promise(resolve=>pending.set(seq,resolve));
    socket.send(JSON.stringify({id:seq,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));
    const msg=await result;
    if(msg.error||msg.result.exceptionDetails)throw Error(JSON.stringify(msg.error||msg.result.exceptionDetails));
    return msg.result.result.value;
  };
  for(let i=0;i<100 && !(await evalJs('location.origin')===base);i++)await wait(100);
  const studioURL='/@fs/'+fileURLToPath(new URL('./hologram-models.js',import.meta.url)).replaceAll('\\','/');
  await evalJs("import("+JSON.stringify(studioURL)+").then(m=>{window.studio=m.createModelStudio(384);})");
  const models=fileURLToPath(new URL('../../assets/holograms/',import.meta.url)).replaceAll('\\','/');
  const chosen=process.argv.slice(3).filter(arg=>arg!=='--study');
  const keys=chosen.length?chosen:['webb','rover','watch','helmet','camera'];
  for(const key of keys){
    const url='/@fs/'+models+key+'.glb';
    await evalJs('studio.select('+JSON.stringify(key)+','+JSON.stringify(url)+')');
    const dir=join(output,key);await mkdir(dir,{recursive:true});
    const count=study?8:64;
    for(let f=0;f<count;f++){
      const png=await evalJs('studio.frame('+f+'/'+count+','+study+')');
      await writeFile(join(dir,String(f).padStart(2,'0')+'.png'),Buffer.from(png,'base64'));
    }
    console.log(key+' rendered');
  }
} finally {socket?.close();edge.kill();await vite.close();}
