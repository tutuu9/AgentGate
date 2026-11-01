import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { createConnection, createServer, type Server } from 'node:net';
import { release, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { assertLinuxSandboxBoundaryUsed } from '../../src/adapters/linux-network-filter.ts';
import { execute } from '../../src/adapters/process.ts';
import {
  CODEX_VERSION,
  createSandboxSession,
  executeSandbox,
  isolatedEnvironment,
} from '../../src/adapters/sandbox.ts';
import { hasUncertainTermination } from '../../src/core/errors.ts';
import { cleanTerminal, redact } from '../../src/core/safety.ts';
import { FileRunStore } from '../../src/core/store.ts';

// command/exec shares SandboxManager transformation and policy environment handling with
// model tools. Its pipe launcher differs: this is not evidence of a model invocation.
const scope = 'native-linux-helper-policy';
const abort = new AbortController();
const interrupt = () => abort.abort(new Error('Native helper policy acceptance cancelled.'));
const emit = (value: unknown) =>
  process.stdout.write(`${cleanTerminal(redact(JSON.stringify(value)))}\n`);

const captureChild = String.raw`
let input='',ended=false,message;
process.stdin.setEncoding('utf8');process.stdin.on('data',value=>input+=value);
function finish(){
 if(!ended||(process.send&&message===undefined))return;
 process.stdout.write('stdout:'+input);process.stderr.write('stderr:'+input);process.exitCode=37;
 if(process.send){process.send(message);process.disconnect()}
}
process.stdin.on('end',()=>{ended=true;finish()});
if(process.send)process.on('message',value=>{message=value;finish()});
`;

const socketSource = String.raw`
import errno,json,socket
rows=[]
for name,family,kind in [('inet4',socket.AF_INET,socket.SOCK_STREAM),('inet6',socket.AF_INET6,socket.SOCK_STREAM),('unixStream',socket.AF_UNIX,socket.SOCK_STREAM),('unixDatagram',socket.AF_UNIX,socket.SOCK_DGRAM)]:
 s=None;error=None
 try:s=socket.socket(family,kind)
 except OSError as e:error=e.errno
 finally:
  if s:s.close()
 rows.append({'name':name,'errno':error})
print(json.dumps(rows))
`;

const payloadSource = String.raw`
const fs=require('node:fs'),net=require('node:net'),{spawnSync,spawn,fork}=require('node:child_process');
const p=JSON.parse(process.argv[1]),input='helper-input:'+p.nonce;
const deadline=setTimeout(()=>process.exit(3),18000);
function capture(child,method){return new Promise(resolve=>{
 let stdout='',stderr='',error=null,message=null,bytes=0;
 const timer=setTimeout(()=>{error='timeout';child.kill('SIGKILL')},4000);
 for(const stream of [child.stdin,child.stdout,child.stderr])stream.on('error',()=>error='stream');
 for(const [stream,name] of [[child.stdout,'stdout'],[child.stderr,'stderr']]){stream.setEncoding('utf8');stream.on('data',value=>{bytes+=Buffer.byteLength(value);if(bytes>8192){error='output-limit';child.kill('SIGKILL')}else if(name==='stdout')stdout+=value;else stderr+=value})}
 child.on('error',()=>error='spawn');child.on('message',value=>message=value);
 child.on('close',(status,signal)=>{clearTimeout(timer);resolve({method,status,signal,error,stdout,stderr,message})});
 if(method==='fork')child.send(input,e=>{if(e)error='ipc'});
 child.stdin.end(input);
})}
function denied(options){return new Promise(resolve=>{
 const socket=net.createConnection(options);let done=false;
 function finish(connected,error){if(done)return;done=true;socket.destroy();resolve({connected,error})}
 socket.setTimeout(2000,()=>finish(false,'timeout'));
 socket.once('connect',()=>finish(true,null));socket.once('error',e=>finish(false,e.code||'error'));
})}
(async()=>{
 const sync=spawnSync(process.execPath,['-e',p.captureChild],{input,encoding:'utf8',timeout:4000,maxBuffer:8192});
 const captures=[{method:'spawnSync',status:sync.status,signal:sync.signal,error:sync.error?'spawn':null,stdout:sync.stdout,stderr:sync.stderr,message:null}];
 captures.push(await capture(spawn(process.execPath,['-e',p.captureChild],{stdio:['pipe','pipe','pipe']}),'spawn'));
 captures.push(await capture(fork(p.forkPath,[],{stdio:['pipe','pipe','pipe','ipc']}),'fork'));
 const tcp=await denied({host:'127.0.0.1',port:p.port}),unix=await denied({path:p.socketPath});
 const sockets=spawnSync('/usr/bin/python3',['-I','-c',p.socketSource],{encoding:'utf8',timeout:3000,maxBuffer:8192});
 if(sockets.status!==0||sockets.signal!==null||sockets.error)throw new Error('Socket fixture failed');
 const credentials=['GH_TOKEN','GITHUB_TOKEN','OPENAI_API_KEY','CODEX_API_KEY','ANTHROPIC_API_KEY','SSH_AUTH_SOCK','DBUS_SESSION_BUS_ADDRESS','XDG_RUNTIME_DIR','AGENTGATE_FAKE_MANAGER_SECRET'].some(key=>Boolean(process.env[key]));
 const proxy=Object.keys(process.env).some(key=>/^(http|https|all|socks)_proxy$/i.test(key)&&Boolean(process.env[key]));
 const boundaryVisible=(()=>{try{fs.readdirSync(p.boundary);return true}catch{return false}})();
 process.stdout.write(JSON.stringify({nonce:p.nonce,captures,tcp,unix,sockets:JSON.parse(sockets.stdout),path:process.env.PATH||'',credentials,proxy,boundaryVisible}));
 process.stderr.write('helper-stderr:'+p.nonce);process.exitCode=37;clearTimeout(deadline);
})().catch(()=>{clearTimeout(deadline);process.stderr.write('Helper payload failed');process.exitCode=2});
`;

// This trusted client remains outside the worker sandbox but inside AgentGate's owned service.
// It sends no thread/turn/model requests and no command-level environment or policy overrides.
const clientSource = String.raw`
const {spawn}=require('node:child_process');
const p=JSON.parse(process.argv[1]);
const server=spawn(p.codex,[...p.configArgs,'app-server','--stdio'],{cwd:p.launcher,env:process.env,stdio:['pipe','pipe','pipe']});
let buffer='',total=0,diagnostics='',response=null,failure=null,initialized=false,stopping=false,force;
const timer=setTimeout(()=>fail('App-server client deadline exceeded'),25000);
function send(value){server.stdin.write(JSON.stringify(value)+'\n')}
function stop(){if(stopping)return;stopping=true;server.stdin.end();server.kill('SIGTERM');force=setTimeout(()=>server.kill('SIGKILL'),2000)}
function fail(reason){failure=reason;stop()}
for(const stream of [server.stdin,server.stdout,server.stderr])stream.on('error',()=>{if(!stopping)fail('App-server stream failed')});
server.on('error',()=>fail('App-server spawn failed'));
server.stderr.setEncoding('utf8');server.stderr.on('data',chunk=>{diagnostics+=chunk;if(Buffer.byteLength(diagnostics)>32768)fail('App-server diagnostics exceeded bound')});
server.stdout.setEncoding('utf8');server.stdout.on('data',chunk=>{
 total+=Buffer.byteLength(chunk);if(total>524288){fail('App-server protocol exceeded bound');return}buffer+=chunk;
 for(;;){const newline=buffer.indexOf('\n');if(newline<0)break;const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);if(!line.trim())continue;
  let message;try{message=JSON.parse(line)}catch{fail('Invalid app-server JSON');return}
  if(!message||typeof message!=='object'){fail('Invalid app-server message');return}
  if(message.id===1){
   if(initialized||message.error||!message.result||message.result.platformOs!=='linux'||message.result.codexHome!==p.codexHome){fail('App-server initialization failed');return}
   initialized=true;send({method:'initialized'});
   send({id:2,method:'command/exec',params:{command:[process.execPath,'-e',p.payloadSource,JSON.stringify(p.payload)],cwd:p.launcher,timeoutMs:20000,outputBytesCap:65536}});
  }else if(message.id===2){
   if(!initialized||response||message.error||!message.result){fail('command/exec failed');return}
   response=message.result;stop();
  }else if('id' in message){fail('Unexpected app-server request or response');return}
 }
});
server.on('close',()=>{
 clearTimeout(timer);clearTimeout(force);
 if(failure||!response){process.stderr.write((failure||'App-server closed without a result')+'\n'+diagnostics.slice(0,4096));process.exitCode=2;return}
 process.stdout.write(JSON.stringify({result:response,serverStopped:true}));
});
send({id:1,method:'initialize',params:{clientInfo:{name:'agentgate-native-fixture',title:'AgentGate native fixture',version:'1'},capabilities:{experimentalApi:false}}});
`;

const Capture = z.object({
  method: z.enum(['spawnSync', 'spawn', 'fork']),
  status: z.literal(37),
  signal: z.null(),
  error: z.null(),
  stdout: z.string().max(8192),
  stderr: z.string().max(8192),
  message: z.string().nullable(),
});
const Denied = z.object({ connected: z.literal(false), error: z.string().min(1) });
const Observation = z.object({
  nonce: z.uuid(),
  captures: z.array(Capture).length(3),
  tcp: Denied,
  unix: Denied,
  sockets: z.array(z.object({ name: z.string(), errno: z.literal(1) })).length(4),
  path: z.string().max(32768),
  credentials: z.literal(false),
  proxy: z.literal(false),
  boundaryVisible: z.literal(false),
});
const ClientResult = z.object({
  result: z.object({ exitCode: z.literal(37), stdout: z.string(), stderr: z.string() }),
  serverStopped: z.literal(true),
});

function baseline(options: { port: number; host: string } | { path: string }, nonce: string) {
  return new Promise<void>((resolve, reject) => {
    const socket = createConnection(options);
    let value = '';
    socket.setEncoding('utf8');
    socket.setTimeout(2000, () => socket.destroy(new Error('Host baseline timed out.')));
    socket.on('data', (chunk) => (value += chunk));
    socket.once('error', reject);
    socket.once('end', () => {
      socket.destroy();
      if (value === nonce) resolve();
      else reject(new Error('Host receiver baseline payload differed.'));
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => {
    if (!server.listening) return resolveClose();
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

async function verifyProfile(codex: string, root: string, writable: boolean) {
  const profile = writable ? 'write' : 'read-only';
  const home = join(root, `${profile}-state`),
    workspace = join(root, `${profile}-workspace`);
  await mkdir(workspace);
  const store = new FileRunStore(home);
  await store.init();
  const unlock = await store.acquireLock();
  const session = await createSandboxSession(home, workspace, writable, codex);
  const nonce = randomUUID(),
    socketPath = join(workspace, 'host.sock');
  assert.ok(Buffer.byteLength(socketPath) < 107);
  const boundary = session.env.PATH!.split(':')[0]!;
  assert.match(boundary, /\/boundary-[^/]+$/);
  const restoredPath = session.env.PATH!.split(':').slice(1).join(':');
  const forkPath = join(workspace, 'capture-child.cjs');
  await writeFile(forkPath, captureChild, { flag: 'wx' });
  const counts = { tcp: 0, unix: 0 };
  const tcp = createServer((socket) => {
    counts.tcp++;
    socket.end(nonce);
  });
  const unix = createServer((socket) => {
    counts.unix++;
    socket.end(nonce);
  });
  let uncertain = false;
  let failure: unknown;
  try {
    await assert.rejects(lstat(join(home, 'codex', 'auth.json')), { code: 'ENOENT' });
    await new Promise<void>((resolveListen, reject) => {
      tcp.once('error', reject);
      tcp.listen(0, '127.0.0.1', resolveListen);
    });
    await new Promise<void>((resolveListen, reject) => {
      unix.once('error', reject);
      unix.listen(socketPath, resolveListen);
    });
    const address = tcp.address();
    assert.ok(address && typeof address !== 'string');
    const tcpAddress = { host: '127.0.0.1', port: address.port };
    await baseline(tcpAddress, nonce);
    await baseline({ path: socketPath }, nonce);
    counts.tcp = counts.unix = 0;
    const result = await executeSandbox({
      command: process.execPath,
      args: [
        '-e',
        clientSource,
        JSON.stringify({
          codex: session.codexExecutable ?? codex,
          codexHome: session.env.CODEX_HOME,
          configArgs: session.configArgs,
          launcher: session.launcher,
          payloadSource,
          payload: {
            nonce,
            port: address.port,
            socketPath,
            forkPath,
            boundary,
            captureChild,
            socketSource,
          },
        }),
      ],
      cwd: session.launcher,
      env: session.env,
      timeoutMs: 35_000,
      maxOutputBytes: 128 * 1024,
      signal: abort.signal,
    });
    assert.equal(result.exitCode, 0, result.stderr.slice(0, 4096));
    await assertLinuxSandboxBoundaryUsed(session.launcher, true);
    const client = ClientResult.parse(JSON.parse(result.stdout));
    assert.equal(client.result.stderr, `helper-stderr:${nonce}`);
    const observation = Observation.parse(JSON.parse(client.result.stdout));
    assert.equal(observation.nonce, nonce);
    assert.deepEqual(observation.captures.map((row) => row.method).sort(), [
      'fork',
      'spawn',
      'spawnSync',
    ]);
    for (const row of observation.captures) {
      assert.equal(row.stdout, `stdout:helper-input:${nonce}`);
      assert.equal(row.stderr, `stderr:helper-input:${nonce}`);
      assert.equal(row.message, row.method === 'fork' ? `helper-input:${nonce}` : null);
    }
    assert.deepEqual(observation.sockets.map((row) => row.name).sort(), [
      'inet4',
      'inet6',
      'unixDatagram',
      'unixStream',
    ]);
    assert.equal(
      observation.path,
      restoredPath,
      'Worker PATH did not restore the original sanitized path.',
    );
    assert.ok(!observation.path.split(':').includes(boundary));
    assert.deepEqual(counts, { tcp: 0, unix: 0 });
    await baseline(tcpAddress, nonce);
    await baseline({ path: socketPath }, nonce);
    await assert.rejects(lstat(join(home, 'codex', 'auth.json')), { code: 'ENOENT' });
    emit({
      scope,
      phase: 'profile',
      profile,
      result: 'passed',
      capturedNodeCases: 3,
      commandExitCode: 37,
      socketCreationsDenied: 4,
      hostDeliveries: { tcp: 0, unix: 0 },
      controllerBaselinesBeforeAndAfter: true,
      privateBoundaryReceipt: true,
      policyPathRestored: true,
      boundaryInaccessible: true,
      credentialsAbsent: true,
      proxyAbsent: true,
      executionPath: 'app-server command/exec shared SandboxManager policy path',
      modelInvoked: false,
    });
  } catch (error) {
    uncertain = hasUncertainTermination(error);
    failure = error;
  }
  const closed = await Promise.allSettled([closeServer(tcp), closeServer(unix)]);
  for (const outcome of closed) if (outcome.status === 'rejected') failure ??= outcome.reason;
  if (!uncertain) {
    try {
      await session.cleanup();
      await unlock();
    } catch (error) {
      failure ??= error;
    }
  }
  emit({
    scope,
    phase: 'fixtures-retained',
    profile,
    home,
    workspace,
    lockRetained: uncertain,
    modelInvoked: false,
  });
  if (failure) throw failure;
}

async function main() {
  if (
    process.platform !== 'linux' ||
    process.arch !== 'x64' ||
    process.versions.node.split('.')[0] !== '24'
  )
    throw new Error('Native helper policy acceptance requires Linux x86_64 and Node.js 24.');
  if (process.argv.length !== 3 || !isAbsolute(process.argv[2]!))
    throw new Error(
      'Usage: node test/manual/verify-linux-helper-policy.ts <absolute-native-codex>',
    );
  const codex = await realpath(process.argv[2]!);
  assert.ok((await lstat(codex)).isFile());
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ag-helper-'));
  const version = await execute({
    command: codex,
    args: ['--version'],
    env: isolatedEnvironment(root, tmpdir()),
    timeoutMs: 10_000,
    maxOutputBytes: 4096,
    signal: abort.signal,
  });
  assert.equal(version.exitCode, 0);
  assert.equal(version.stdout.trim(), `codex-cli ${CODEX_VERSION}`);
  emit({
    scope,
    phase: 'environment',
    platform: process.platform,
    architecture: process.arch,
    kernel: release(),
    node: process.version,
    codex: CODEX_VERSION,
    root,
    modelInvoked: false,
  });
  for (const writable of [false, true]) await verifyProfile(codex, root, writable);
}

process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
try {
  await main();
} catch (error) {
  emit({
    scope,
    result: 'failed',
    detail: error instanceof Error ? error.message : String(error),
    uncertain: hasUncertainTermination(error),
    modelInvoked: false,
  });
  process.exitCode = 1;
} finally {
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', interrupt);
}
