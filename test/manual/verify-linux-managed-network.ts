import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createConnection, createServer, type ListenOptions, type Socket } from 'node:net';
import { arch, release, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { execute } from '../../src/adapters/process.ts';
import { createSandboxSession, executeSandbox } from '../../src/adapters/sandbox.ts';
import { hasUncertainTermination } from '../../src/core/errors.ts';
import { cleanTerminal, redact } from '../../src/core/safety.ts';
import { FileRunStore } from '../../src/core/store.ts';

// Experimental only. This does not authorize model workflows or alter production policy.
// Retain fresh, credential-free fixtures; interrupted Linux native workers retain their lock.
const scope = 'experimental-linux-managed-network';
const abort = new AbortController();
const interrupt = () => abort.abort(new Error('Managed network experiment cancelled.'));
const emit = (value: unknown) =>
  process.stdout.write(`${cleanTerminal(redact(JSON.stringify(value)))}\n`);

const streamChild = String.raw`
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);
process.stdin.on('end',()=>{console.log(JSON.stringify({input}));console.error('captured-stderr');process.exitCode=37});`;
const forkChild = String.raw`
process.on('message',message=>{process.send({echo:message});console.log('fork-stdout');console.error('fork-stderr');process.disconnect();process.exitCode=37});`;
const datagramServer = String.raw`
import json,os,socket,sys,time
p=json.loads(sys.argv[1]); s=socket.socket(socket.AF_UNIX,socket.SOCK_DGRAM); s.bind(p['path']); s.settimeout(.1)
s.sendto(p['nonce'].encode(),p['path']); baseline=s.recv(4096)==p['nonce'].encode()
with open(p['ready']+'.tmp','x') as ready: ready.write(json.dumps({'baseline':baseline}))
os.rename(p['ready']+'.tmp',p['ready'])
received=0; deadline=time.monotonic()+40
while not os.path.exists(p['stop']) and time.monotonic()<deadline:
    try:
        if s.recv(4096)==p['nonce'].encode(): received+=1
    except TimeoutError: pass
s.setblocking(False)
while True:
    try:
        if s.recv(4096)==p['nonce'].encode(): received+=1
    except BlockingIOError: break
s.close(); print(json.dumps({'received':received,'stopped':os.path.exists(p['stop'])}))
`;
const datagramClient = String.raw`
import json,socket,sys
p=json.loads(sys.argv[1]); result={}
for mode in ['connectSend','sendto']:
    pair=None
    try:
        pair=socket.socketpair(socket.AF_UNIX,socket.SOCK_DGRAM)
        if mode=='connectSend': pair[0].connect(p['path']); pair[0].send(p['nonce'].encode())
        else: pair[0].sendto(p['nonce'].encode(),p['path'])
        result[mode]={'sent':True,'errno':None}
    except OSError as error: result[mode]={'sent':False,'errno':error.errno}
    finally:
        if pair:
            for endpoint in pair: endpoint.close()
print(json.dumps(result))
`;

const probe = String.raw`
const fs=require('node:fs'),net=require('node:net'),dgram=require('node:dgram');
const {spawn,spawnSync,fork}=require('node:child_process');
const p=JSON.parse(process.argv[1]);
let phase='unix-datagram';
const code=error=>typeof error?.code==='string'?error.code:null;
function connect(options){return new Promise(resolve=>{let s;const done=(connected,error=null)=>{s?.destroy();resolve({connected,error})};try{s=net.createConnection(options);s.setTimeout(1500,()=>done(false,'TIMEOUT'));s.once('connect',()=>done(true));s.once('error',error=>done(false,code(error)))}catch(error){done(false,code(error))}})}
function proxyRequest(proxy,target,method){return new Promise(resolve=>{let socket,received='';const done=(status,error=null)=>{socket?.destroy();resolve({status,error})};try{socket=net.createConnection({host:proxy.hostname,port:Number(proxy.port)});socket.once('connect',()=>socket.write(method+' '+target+' HTTP/1.1\r\nHost: '+(method==='CONNECT'?target:new URL(target).host)+'\r\nConnection: close\r\n\r\n'));socket.on('data',chunk=>{received+=chunk.toString();const match=/^HTTP\/1\.[01] (\d{3})/.exec(received);if(match)done(Number(match[1]));else if(received.length>8192)done(null,'RESPONSE_LIMIT')});socket.once('error',error=>done(null,code(error)));socket.once('end',()=>done(null,'NO_STATUS'));socket.setTimeout(1500,()=>done(null,'TIMEOUT'))}catch(error){done(null,code(error))}})}
function asyncChild(child,input){return new Promise(resolve=>{let stdout='',stderr='',error=null,message=null;child.stdout?.setEncoding('utf8');child.stderr?.setEncoding('utf8');child.stdout?.on('data',s=>stdout+=s);child.stderr?.on('data',s=>stderr+=s);child.once('error',e=>error=code(e));child.on('message',value=>message=value);child.once('close',(exitCode,signal)=>resolve({exitCode,signal,stdout,stderr,error,message}));if(input!==undefined)child.stdin.end(input)})}
function udp(){return new Promise(resolve=>{let s;try{s=dgram.createSocket('udp4');s.once('error',error=>{s.close();resolve(code(error))});s.send(p.nonce,p.udpPort,'127.0.0.1',error=>{s.close();resolve(code(error))})}catch(error){s?.close();resolve(code(error))}})}
(async()=>{
  const datagram=spawnSync('/usr/bin/python3',['-I','-c',p.datagramClient,JSON.stringify({path:p.datagramPath,nonce:p.nonce})],{encoding:'utf8',timeout:3000,maxBuffer:8192});
  fs.writeSync(2,JSON.stringify({phase:'unix-datagram-attempt',exitCode:datagram.status,stdout:datagram.stdout,stderr:datagram.stderr,error:code(datagram.error)})+'\n');
  phase='spawnSync';
  const sync=spawnSync(process.execPath,['-e',p.streamChild],{input:'captured-stdin',encoding:'utf8',timeout:3000,maxBuffer:8192});
  phase='spawn';
  const asynchronous=await asyncChild(spawn(process.execPath,['-e',p.streamChild],{stdio:['pipe','pipe','pipe']}),'captured-stdin');
  phase='fork';
  const forked=fork(p.forkPath,[],{stdio:['pipe','pipe','pipe','ipc']});const forkResult=asyncChild(forked);forked.send('ipc-message');forked.stdin.end();
  const ipc=await forkResult;
  phase='filesystem';
  let outsideRead=false;try{fs.readFileSync(p.outside);outsideRead=true}catch{}
  let protectedWrite=false;try{fs.writeFileSync(p.protected,'changed');protectedWrite=true}catch{}
  const workspaceRead=fs.readFileSync(p.allowed,'utf8')===p.nonce;fs.writeFileSync(p.written,p.nonce,{flag:'wx'});
  const proxyValue=process.env.HTTP_PROXY??process.env.http_proxy;const proxy=proxyValue?new URL(proxyValue):null;
  phase='network';
  const direct=await Promise.all([connect({host:'127.0.0.1',port:p.port4}),connect({host:'::1',port:p.port6}),connect({host:'1.1.1.1',port:443}),connect({path:p.unix}),connect({path:p.outsideUnix})]);
  const requests=[];if(proxy)for(const [target,method]of[['http://1.1.1.1/','GET'],['1.1.1.1:443','CONNECT'],['http://127.0.0.1:'+p.port4+'/','GET'],['127.0.0.1:'+p.port4,'CONNECT'],['unconfigured.invalid:443','CONNECT']])requests.push(await proxyRequest(proxy,target,method));
  const udpError=await udp();
  console.log(JSON.stringify({sync:{exitCode:sync.status,signal:sync.signal,stdout:sync.stdout,stderr:sync.stderr,error:code(sync.error)},asynchronous,ipc,datagram:{exitCode:datagram.status,signal:datagram.signal,stdout:datagram.stdout,stderr:datagram.stderr,error:code(datagram.error)},workspaceRead,outsideRead,protectedWrite,direct,requests,udpError,proxyConfigured:Boolean(proxy),proxyPortNonzero:!!proxy&&Number(proxy.port)>0,socksConfigured:/^socks/i.test(process.env.ALL_PROXY??process.env.all_proxy??''),credentials:['GH_TOKEN','GITHUB_TOKEN','OPENAI_API_KEY','CODEX_API_KEY','ANTHROPIC_API_KEY','SSH_AUTH_SOCK'].some(key=>Boolean(process.env[key]))}));
})().catch(error=>{fs.writeSync(2,JSON.stringify({phase:'managed-probe-failure',operation:phase,name:error.name,code:code(error)})+'\n');process.exitCode=2});`;

const childResult = z.object({
  exitCode: z.number().nullable(),
  signal: z.string().nullable(),
  stdout: z.string().max(8192),
  stderr: z.string().max(8192),
  error: z.string().nullable(),
});
const observationSchema = z.object({
  sync: childResult,
  asynchronous: childResult.extend({ message: z.unknown() }),
  ipc: childResult.extend({ message: z.unknown() }),
  datagram: childResult,
  workspaceRead: z.boolean(),
  outsideRead: z.boolean(),
  protectedWrite: z.boolean(),
  direct: z.array(z.object({ connected: z.boolean(), error: z.string().nullable() })).length(5),
  requests: z
    .array(z.object({ status: z.number().nullable(), error: z.string().nullable() }))
    .length(5),
  udpError: z.string().nullable(),
  proxyConfigured: z.boolean(),
  proxyPortNonzero: z.boolean(),
  socksConfigured: z.boolean(),
  credentials: z.boolean(),
});

async function listener(options: ListenOptions) {
  let connections = 0;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    port:
      typeof server.address() === 'object'
        ? (server.address() as { port: number }).port
        : undefined,
    count: () => connections,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

async function reachable(
  options: { host: string; port: number } | { path: string },
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(options);
    const done = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(2500, () => done(false));
  });
}

function compatible(result: z.infer<typeof childResult>): boolean {
  return (
    result.exitCode === 37 &&
    result.signal === null &&
    result.error === null &&
    result.stdout === '{"input":"captured-stdin"}\n' &&
    result.stderr === 'captured-stderr\n'
  );
}

async function main() {
  if (process.platform !== 'linux' || process.versions.node.split('.')[0] !== '24')
    throw new Error('This experiment requires native Linux and Node.js 24.');
  if (process.argv.length !== 3 || !isAbsolute(process.argv[2]!))
    throw new Error(
      'Usage: node test/manual/verify-linux-managed-network.ts <absolute-native-codex-path>',
    );
  const codexPath = await realpath(process.argv[2]!);
  assert.ok((await lstat(codexPath)).isFile());
  const temporary = await realpath(tmpdir());
  const home = await mkdtemp(join(temporary, 'agentgate-managed-state-'));
  const fixture = await mkdtemp(join(temporary, 'agentgate-managed-fixture-'));
  const workspace = join(fixture, 'workspace');
  await mkdir(workspace);
  await mkdir(join(workspace, '.git'));
  const nonce = randomUUID(),
    secret = randomUUID();
  const outside = join(fixture, 'fake-secret'),
    allowed = join(workspace, 'allowed');
  const written = join(workspace, 'written'),
    protectedPath = join(workspace, '.git', 'protected');
  const forkPath = join(workspace, 'ipc-child.cjs'),
    unix = join(workspace, 'host.sock');
  const outsideUnix = join(fixture, 'outside.sock');
  const datagramPath = join(workspace, 'host-dgram.sock');
  await writeFile(outside, secret, { flag: 'wx' });
  await writeFile(allowed, nonce, { flag: 'wx' });
  await writeFile(protectedPath, nonce, { flag: 'wx' });
  await writeFile(forkPath, forkChild, { flag: 'wx' });
  const store = new FileRunStore(home);
  await store.init();
  const unlock = await store.acquireLock();
  const session = await createSandboxSession(home, workspace, true, codexPath);
  const datagramReady = join(home, 'datagram-ready.json'),
    datagramStop = join(home, 'datagram-stop');
  let serverExecution:
    Promise<{ result: Awaited<ReturnType<typeof execute>> } | { error: unknown }> | undefined;
  const listeners: Awaited<ReturnType<typeof listener>>[] = [];
  const udp = createSocket('udp4');
  let udpPackets = 0,
    uncertain = false,
    udpBound = false;
  udp.on('message', (message) => {
    if (message.toString() === nonce) udpPackets++;
  });
  const stopDatagramServer = async () => {
    if (!serverExecution) return;
    let stopError: unknown;
    try {
      await writeFile(datagramStop, 'stop');
    } catch (error) {
      stopError = error;
    }
    const outcome = await serverExecution;
    if ('error' in outcome) {
      if (hasUncertainTermination(outcome.error)) {
        uncertain = true;
        throw outcome.error;
      }
      if (!uncertain) throw outcome.error;
    }
    if (stopError && !uncertain) throw stopError;
  };
  try {
    const version = await execute({
      command: session.codexExecutable!,
      args: ['--version'],
      cwd: session.launcher,
      env: session.env,
      timeoutMs: 10_000,
      signal: abort.signal,
    });
    assert.equal(version.exitCode, 0);
    assert.match(version.stdout.trim(), /^codex-cli 0\.(154|166)\.0$/);
    await assert.rejects(lstat(join(home, 'codex', 'auth.json')), { code: 'ENOENT' });
    emit({
      phase: 'environment',
      scope,
      codexVersion: version.stdout.trim(),
      nodeVersion: process.version,
      osVersion: release(),
      architecture: arch(),
      home,
      fixture,
      freshHome: true,
      fixturesRetained: true,
      modelInvoked: false,
      workflowAuthorized: false,
    });
    listeners.push(await listener({ host: '127.0.0.1', port: 0 }));
    listeners.push(await listener({ host: '::1', port: 0 }));
    listeners.push(await listener({ path: unix }));
    listeners.push(await listener({ path: outsideUnix }));
    await new Promise<void>((resolve, reject) => {
      udp.once('error', reject);
      udp.bind(0, '127.0.0.1', () => {
        udpBound = true;
        udp.off('error', reject);
        resolve();
      });
    });
    const udpPort = udp.address().port;
    udp.send(nonce, udpPort, '127.0.0.1');
    for (let i = 0; i < 50 && udpPackets === 0; i++) await delay(10);
    assert.equal(udpPackets, 1, 'Controller UDP baseline must arrive.');
    const endpoints = [
      { host: '127.0.0.1', port: listeners[0]!.port! },
      { host: '::1', port: listeners[1]!.port! },
      { host: '1.1.1.1', port: 443 },
      { path: unix },
      { path: outsideUnix },
    ];
    const before = await Promise.all(endpoints.map(reachable));
    assert.ok(before.every(Boolean), 'All controller network baselines must be reachable.');
    await delay(25);
    const counts = listeners.map((entry) => entry.count());
    serverExecution = execute({
      command: '/usr/bin/python3',
      args: [
        '-I',
        '-c',
        datagramServer,
        JSON.stringify({ path: datagramPath, ready: datagramReady, stop: datagramStop, nonce }),
      ],
      cwd: session.launcher,
      env: session.env,
      timeoutMs: 45_000,
      maxOutputBytes: 4096,
      signal: abort.signal,
    }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    let datagramBaseline = false;
    for (let i = 0; i < 100 && !datagramBaseline; i++) {
      try {
        datagramBaseline = z
          .object({ baseline: z.literal(true) })
          .parse(JSON.parse(await readFile(datagramReady, 'utf8'))).baseline;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      if (!datagramBaseline) await delay(25, undefined, { signal: abort.signal });
    }
    assert.ok(datagramBaseline, 'Controller Unix datagram baseline must arrive.');
    // The supported feature owns the proxy; no allowed domain or Unix endpoint is supplied.
    // The sandbox CLI has no approval decider. This does NOT prove model-exec hard-deny behavior.
    const proxyConfig =
      'features.network_proxy={enabled=true,proxy_url="http://127.0.0.1:0",mode="full",enable_socks5=false,enable_socks5_udp=false,allow_upstream_proxy=false,allow_local_binding=false,dangerously_allow_non_loopback_proxy=false,dangerously_allow_all_unix_sockets=false,credential_broker=false,domains={},unix_sockets={}}';
    const result = await executeSandbox({
      command: session.codexExecutable!,
      linuxPipeTransport: true,
      args: [
        ...session.configArgs,
        '-c',
        `permissions.${session.profile}.network.enabled=true`,
        '-c',
        proxyConfig,
        'sandbox',
        '--include-managed-config',
        '-P',
        session.profile,
        '-C',
        session.launcher,
        '--',
        process.execPath,
        '-e',
        probe,
        JSON.stringify({
          nonce,
          outside,
          allowed,
          written,
          protected: protectedPath,
          forkPath,
          unix,
          outsideUnix,
          datagramPath,
          datagramClient,
          port4: listeners[0]!.port,
          port6: listeners[1]!.port,
          udpPort,
          streamChild,
        }),
      ],
      cwd: session.launcher,
      env: session.env,
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024,
      signal: abort.signal,
    });
    emit({
      phase: 'native-result',
      exitCode: result.exitCode,
      stdout: result.stdout.slice(0, 16_384),
      stderr: result.stderr.slice(0, 8192),
      durationMs: result.durationMs,
    });
    assert.equal(result.exitCode, 0, 'Managed network probe failed before validated observations.');
    const observation = observationSchema.parse(JSON.parse(result.stdout));
    await delay(100);
    await writeFile(datagramStop, 'stop', { flag: 'wx' });
    const datagramOutcome = await serverExecution;
    if ('error' in datagramOutcome) throw datagramOutcome.error;
    assert.equal(datagramOutcome.result.exitCode, 0);
    const datagramHost = z
      .object({ received: z.number().int().nonnegative(), stopped: z.literal(true) })
      .parse(JSON.parse(datagramOutcome.result.stdout));
    assert.equal(
      observation.datagram.exitCode,
      0,
      'Unix datagram adversarial probe must actually run.',
    );
    assert.equal(observation.datagram.error, null);
    const datagramAttempt = z.object({ sent: z.boolean(), errno: z.number().int().nullable() });
    const datagramAttempts = z
      .object({ connectSend: datagramAttempt, sendto: datagramAttempt })
      .parse(JSON.parse(observation.datagram.stdout));
    const unixDatagramDenied =
      datagramHost.received === 0 &&
      !datagramAttempts.connectSend.sent &&
      !datagramAttempts.sendto.sent;
    const hostNetworkUntouched =
      listeners.every((entry, index) => entry.count() === counts[index]) && udpPackets === 1;
    const hostFilesVerified =
      (await readFile(outside, 'utf8')) === secret &&
      (await readFile(protectedPath, 'utf8')) === nonce &&
      (await readFile(written, 'utf8')) === nonce;
    const after = await Promise.all(endpoints.map(reachable));
    const capturedStreams = compatible(observation.sync) && compatible(observation.asynchronous);
    const forkIpc =
      observation.ipc.exitCode === 37 &&
      observation.ipc.signal === null &&
      observation.ipc.error === null &&
      observation.ipc.stdout === 'fork-stdout\n' &&
      observation.ipc.stderr === 'fork-stderr\n' &&
      JSON.stringify(observation.ipc.message) === '{"echo":"ipc-message"}';
    const networkDenied =
      observation.direct.every((entry) => !entry.connected) &&
      observation.requests.every((entry) => entry.status === 403 && entry.error === null) &&
      hostNetworkUntouched &&
      unixDatagramDenied &&
      before.every(Boolean) &&
      after.every(Boolean);
    const passed =
      capturedStreams &&
      forkIpc &&
      networkDenied &&
      hostFilesVerified &&
      observation.workspaceRead &&
      !observation.outsideRead &&
      !observation.protectedWrite &&
      !observation.credentials &&
      observation.proxyConfigured &&
      observation.proxyPortNonzero &&
      !observation.socksConfigured;
    emit({
      result: passed ? 'passed' : 'failed',
      scope,
      capturedStreams,
      forkIpc,
      networkDenied,
      hostNetworkUntouched,
      hostFilesVerified,
      unixDatagramDenied,
      datagramHost,
      datagramAttempts,
      observation,
      baselineBefore: before,
      baselineAfter: after,
      modelInvoked: false,
      workflowAuthorized: false,
      modelPolicyDeciderVerified: false,
    });
    process.exitCode = passed ? 0 : 2;
  } catch (error) {
    uncertain = hasUncertainTermination(error);
    throw error;
  } finally {
    try {
      await stopDatagramServer();
    } finally {
      if (udpBound) udp.close();
      for (const entry of listeners) await entry.close();
      if (!uncertain) await unlock();
    }
  }
}

process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
main()
  .catch((error) => {
    emit({
      result: 'blocked',
      scope,
      error: error instanceof Error ? error.message : 'Experiment failed.',
      uncertainTermination: hasUncertainTermination(error),
      modelInvoked: false,
      workflowAuthorized: false,
    });
    process.exitCode = 2;
  })
  .finally(() => {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  });
