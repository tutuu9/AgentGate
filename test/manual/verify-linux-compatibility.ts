import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { release, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { execute, type ExecuteResult } from '../../src/adapters/process.ts';
import {
  CODEX_VERSION,
  createSandboxSession,
  executeSandbox,
  isolatedEnvironment,
} from '../../src/adapters/sandbox.ts';
import { hasUncertainTermination } from '../../src/core/errors.ts';
import { cleanTerminal, redact } from '../../src/core/safety.ts';
import { FileRunStore } from '../../src/core/store.ts';

// Native production-policy observations only: fresh fake fixtures, no login and no model.
const scope = 'native-linux-node-network-compatibility';
const abort = new AbortController();
const interrupt = () => abort.abort(new Error('Native compatibility acceptance cancelled.'));
const emit = (value: unknown) =>
  process.stdout.write(`${cleanTerminal(redact(JSON.stringify(value)))}\n`);
const socketKinds = ['STREAM', 'SEQPACKET', 'DGRAM', 'RAW'] as const;
const socketFlags = [0, 2048, 524288, 526336] as const;
const locations = ['pathname', 'abstract'] as const;
const operations = [
  'local',
  'connect',
  'disconnectConnect',
  'shutdownReadConnect',
  'shutdownWriteConnect',
  'shutdownBothConnect',
  'peerCloseConnect',
  'sendto',
  'sendmsg',
  'sendmmsg',
] as const;
const endpointNames = [
  'tcp4',
  'tcp6',
  'udp4',
  'udp6',
  'pathnameSTREAM',
  'pathnameSEQPACKET',
  'pathnameDGRAM',
  'abstractSTREAM',
  'abstractSEQPACKET',
  'abstractDGRAM',
] as const;
const EndpointName = z.enum(endpointNames);
const HostReady = z
  .object({
    nonce: z.string().uuid(),
    baselines: z.record(EndpointName, z.literal(true)),
    ports: z.object({
      tcp4: z.number().int().positive(),
      tcp6: z.number().int().positive(),
      udp4: z.number().int().positive(),
      udp6: z.number().int().positive(),
    }),
  })
  .strict();
const HostResult = z
  .object({
    nonce: z.string().uuid(),
    stopped: z.literal(true),
    counts: z.record(EndpointName, z.number().int().nonnegative()),
    baselinesAfter: z.record(EndpointName, z.literal(true)),
  })
  .strict();

// All listeners are controller-side. Baselines are consumed before counters start and after
// counters are frozen, so a sandbox syscall report cannot conceal a delivered host message.
const hostSource = String.raw`
import json,os,select,socket,sys,time
p=json.loads(sys.argv[1]); listeners={}; addresses={}; kinds={}; counts={}
for name,family,kind,address in [
 ('tcp4',socket.AF_INET,socket.SOCK_STREAM,('127.0.0.1',0)),
 ('tcp6',socket.AF_INET6,socket.SOCK_STREAM,('::1',0)),
 ('udp4',socket.AF_INET,socket.SOCK_DGRAM,('127.0.0.1',0)),
 ('udp6',socket.AF_INET6,socket.SOCK_DGRAM,('::1',0))
]+[(location+kind,socket.AF_UNIX,getattr(socket,'SOCK_'+kind),p['targets'][location][kind]) for location in ['pathname','abstract'] for kind in ['STREAM','SEQPACKET','DGRAM']]:
 s=socket.socket(family,kind); s.bind(address)
 if kind!=socket.SOCK_DGRAM:s.listen(32)
 listeners[name]=s;addresses[name]=s.getsockname();kinds[name]=(family,kind);counts[name]=0
def baseline(name):
 s=listeners[name];family,kind=kinds[name];s.settimeout(1);c=socket.socket(family,kind);c.settimeout(1)
 marker=('baseline:'+p['nonce']).encode()
 try:
  if kind==socket.SOCK_DGRAM:c.sendto(marker,addresses[name]);ok=s.recv(4096)==marker
  else:
   c.connect(addresses[name]);c.sendall(marker);peer,_=s.accept();peer.settimeout(1)
   try:ok=peer.recv(4096)==marker
   finally:peer.close()
  return ok
 finally:c.close();s.setblocking(False)
before={name:baseline(name) for name in listeners}
with open(p['ready']+'.tmp','x') as f:json.dump({'nonce':p['nonce'],'baselines':before,'ports':{name:addresses[name][1] for name in ['tcp4','tcp6','udp4','udp6']}},f)
os.rename(p['ready']+'.tmp',p['ready'])
def drain():
 for name,s in listeners.items():
  while True:
   try:
    if kinds[name][1]==socket.SOCK_DGRAM:s.recv(65536)
    else:peer,_=s.accept();peer.close()
    counts[name]+=1
   except BlockingIOError:break
deadline=time.monotonic()+75
while not os.path.exists(p['stop']) and time.monotonic()<deadline:
 select.select(list(listeners.values()),[],[],.025);drain()
drain();snapshot=dict(counts);after={name:baseline(name) for name in listeners}
for s in listeners.values():s.close()
print(json.dumps({'nonce':p['nonce'],'stopped':os.path.exists(p['stop']),'counts':snapshot,'baselinesAfter':after}))
`;

const unixSource = String.raw`
import ctypes,errno,json,socket,struct,sys
p=json.loads(sys.argv[1]);nonce=p['nonce'].encode();libc=ctypes.CDLL(None,use_errno=True)
class Iovec(ctypes.Structure):_fields_=[('base',ctypes.c_void_p),('length',ctypes.c_size_t)]
class Msghdr(ctypes.Structure):_fields_=[('name',ctypes.c_void_p),('namelen',ctypes.c_uint),('iov',ctypes.POINTER(Iovec)),('iovlen',ctypes.c_size_t),('control',ctypes.c_void_p),('controllen',ctypes.c_size_t),('flags',ctypes.c_int)]
class Mmsghdr(ctypes.Structure):_fields_=[('header',Msghdr),('length',ctypes.c_uint)]
libc.sendmmsg.argtypes=[ctypes.c_int,ctypes.POINTER(Mmsghdr),ctypes.c_uint,ctypes.c_int];libc.sendmmsg.restype=ctypes.c_int
libc.connect.argtypes=[ctypes.c_int,ctypes.c_void_p,ctypes.c_uint];libc.connect.restype=ctypes.c_int
def sendmany(s,target):
 encoded=target.encode();address=struct.pack('H',socket.AF_UNIX)+encoded+(b'' if encoded.startswith(b'\0') else b'\0')
 raw=ctypes.create_string_buffer(address);data=ctypes.create_string_buffer(nonce);iov=Iovec(ctypes.cast(data,ctypes.c_void_p),len(nonce))
 msg=Mmsghdr(Msghdr(ctypes.cast(raw,ctypes.c_void_p),len(address),ctypes.pointer(iov),1,None,0,0),0)
 result=libc.sendmmsg(s.fileno(),ctypes.byref(msg),1,0)
 if result<0:raise OSError(ctypes.get_errno(),'sendmmsg failed')
 if result!=1 or msg.length!=len(nonce):raise RuntimeError('sendmmsg did not send the complete fixture')
rows=[]
for location in ['pathname','abstract']:
 for kind in ['STREAM','SEQPACKET','DGRAM','RAW']:
  for flags in [0,socket.SOCK_NONBLOCK,socket.SOCK_CLOEXEC,socket.SOCK_NONBLOCK|socket.SOCK_CLOEXEC]:
   for operation in ['local','connect','disconnectConnect','shutdownReadConnect','shutdownWriteConnect','shutdownBothConnect','peerCloseConnect','sendto','sendmsg','sendmmsg']:
    pair=None;row={'location':location,'kind':kind,'flags':flags,'operation':operation,'created':False,'errno':None,'sent':False,'localReceived':False}
    target=p['targets'][location]['DGRAM' if kind=='RAW' else kind]
    try:
     pair=socket.socketpair(socket.AF_UNIX,getattr(socket,'SOCK_'+kind)|flags);row['created']=True
     for s in pair:s.settimeout(.15)
     if operation=='local':pair[0].sendall(nonce);row['sent']=True;row['localReceived']=pair[1].recv(4096)==nonce
     elif operation in ['sendto','sendmsg','sendmmsg']:
      if operation=='sendto':pair[0].sendto(nonce,target)
      elif operation=='sendmsg':pair[0].sendmsg([nonce],[],0,target)
      else:sendmany(pair[0],target)
      row['sent']=True;row['localReceived']=pair[1].recv(4096)==nonce
     else:
      if operation=='disconnectConnect':
       address=ctypes.create_string_buffer(struct.pack('H',socket.AF_UNSPEC));libc.connect(pair[0].fileno(),address,2)
      elif operation.startswith('shutdown'):pair[0].shutdown({'shutdownReadConnect':socket.SHUT_RD,'shutdownWriteConnect':socket.SHUT_WR,'shutdownBothConnect':socket.SHUT_RDWR}[operation])
      elif operation=='peerCloseConnect':
       pair[1].close()
       try:pair[0].send(nonce)
       except OSError:pass
      pair[0].connect(target);pair[0].sendall(nonce);row['sent']=True
    except OSError as error:row['errno']=error.errno if error.errno is not None else errno.ETIMEDOUT
    finally:
     if pair:
      for s in pair:s.close()
    rows.append(row)
ordinary=[]
for location in ['pathname','abstract']:
 for kind in ['STREAM','SEQPACKET','DGRAM','RAW']:
  s=None;row={'location':location,'kind':kind,'created':False,'sent':False,'errno':None}
  try:
   s=socket.socket(socket.AF_UNIX,getattr(socket,'SOCK_'+kind));row['created']=True;s.settimeout(.15)
   s.connect(p['targets'][location]['DGRAM' if kind=='RAW' else kind]);s.sendall(nonce);row['sent']=True
  except OSError as error:row['errno']=error.errno if error.errno is not None else errno.ETIMEDOUT
  finally:
   if s:s.close()
  ordinary.append(row)
udp=[]
for name,family,address in [('udp4',socket.AF_INET,('127.0.0.1',p['ports']['udp4'])),('udp6',socket.AF_INET6,('::1',p['ports']['udp6']))]:
 s=None;row={'name':name,'sent':False,'errno':None}
 try:s=socket.socket(family,socket.SOCK_DGRAM);s.settimeout(.15);s.sendto(nonce,address);row['sent']=True
 except OSError as error:row['errno']=error.errno if error.errno is not None else errno.ETIMEDOUT
 finally:
  if s:s.close()
 udp.append(row)
print(json.dumps({'matrix':rows,'ordinary':ordinary,'udp':udp}))
`;

const captureChild = String.raw`
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);
process.stdin.on('end',()=>{console.log(JSON.stringify({input}));console.log('captured-stdout');console.error('captured-stderr');process.exitCode=37});
`;
const forkChild = `${captureChild}\nlet sequence=0;process.on('message',message=>{const current=++sequence;process.send({sequence:current,echo:message},error=>{if(error)process.exitCode=125;if(current===2)process.disconnect()})});`;
const nodeSource = String.raw`
const fs=require('node:fs'),net=require('node:net'),{spawn,spawnSync,fork}=require('node:child_process');
const p=JSON.parse(process.argv[1]);const failure=error=>typeof error?.code==='string'?error.code:null;
function captured(child,input,ipc){return new Promise(resolve=>{
 let stdout='',stderr='',error=null,timedOut=false,outputLimit=false;const messages=[];
 const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL')},7000);
 const collect=which=>chunk=>{if(stdout.length+stderr.length>1024*1024){outputLimit=true;child.kill('SIGKILL')}else if(which==='stdout')stdout+=chunk;else stderr+=chunk};
 child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',collect('stdout'));child.stderr.on('data',collect('stderr'));
 child.on('error',value=>error=failure(value));child.stdin.on('error',value=>error=failure(value));child.on('message',message=>messages.push(message));
 child.once('close',(exitCode,signal)=>{clearTimeout(timer);resolve({exitCode,signal,stdout,stderr,error,messages,timedOut,outputLimit})});
 if(ipc){child.send({marker:p.nonce,part:1},value=>{if(value)error=failure(value)});child.send({marker:p.nonce,part:2},value=>{if(value)error=failure(value)})}
 const bytes=Buffer.from(input);let position=0;
 function write(){while(position<bytes.length){const end=Math.min(position+8191,bytes.length),part=bytes.subarray(position,end);position=end;if(!child.stdin.write(part)){child.stdin.once('drain',write);return}}child.stdin.end()}
 write();
})}
function connect(options){return new Promise(resolve=>{let s;const done=(connected,error=null)=>{s?.destroy();resolve({connected,error})};try{s=net.createConnection(options);s.once('connect',()=>done(true));s.once('error',error=>done(false,failure(error)));s.setTimeout(1500,()=>done(false,'TIMEOUT'))}catch(error){done(false,failure(error))}})}
(async()=>{
 const inputs={empty:'',utf8:'stdin-'+p.nonce+' café ☃\nsecond line',multichunk:('chunk-'+p.nonce+'-π\n').repeat(4096)};const cases=[];
 for(const method of ['spawnSync','spawn','fork'])for(const [inputCase,input]of Object.entries(inputs)){
  let result;
  if(method==='spawnSync'){const r=spawnSync(process.execPath,['-e',p.captureChild],{input,encoding:'utf8',timeout:7000,maxBuffer:1024*1024});result={exitCode:r.status,signal:r.signal,stdout:r.stdout??'',stderr:r.stderr??'',error:failure(r.error),messages:[],timedOut:r.error?.code==='ETIMEDOUT',outputLimit:r.error?.code==='ENOBUFS'}}
  else result=await captured(method==='fork'?fork(p.forkPath,[],{stdio:['pipe','pipe','pipe','ipc']}):spawn(process.execPath,['-e',p.captureChild],{stdio:['pipe','pipe','pipe']}),input,method==='fork');
  cases.push({method,inputCase,exitCode:result.exitCode,signal:result.signal,error:result.error,timedOut:result.timedOut,outputLimit:result.outputLimit,stdinBytes:Buffer.byteLength(input),stdoutMatches:result.stdout===JSON.stringify({input})+'\ncaptured-stdout\n',stderrMatches:result.stderr==='captured-stderr\n',ipcMatches:JSON.stringify(result.messages)===JSON.stringify(method==='fork'?[{sequence:1,echo:{marker:p.nonce,part:1}},{sequence:2,echo:{marker:p.nonce,part:2}}]:[])});
 }
 const native=spawnSync('/usr/bin/python3',['-I','-c',p.unixSource,JSON.stringify({nonce:p.nonce,targets:p.targets,ports:p.ports})],{encoding:'utf8',timeout:15000,maxBuffer:256*1024});
 if(native.status!==0||native.signal||native.error)throw new Error('Unix syscall fixture did not complete: '+(native.error?.code??native.status)+' '+String(native.stderr).slice(0,1024));
 const unix=JSON.parse(native.stdout);
 const direct=[];for(const [name,host,port]of [['tcp4','127.0.0.1',p.ports.tcp4],['tcp6','::1',p.ports.tcp6],['public','1.1.1.1',443]])direct.push({name,...await connect({host,port})});
 const proxyPresent=['HTTP_PROXY','http_proxy','HTTPS_PROXY','https_proxy','ALL_PROXY','all_proxy','SOCKS_PROXY','socks_proxy'].some(name=>Boolean(process.env[name]));
 const credentials=['GH_TOKEN','GITHUB_TOKEN','OPENAI_API_KEY','CODEX_API_KEY','ANTHROPIC_API_KEY','SSH_AUTH_SOCK','DBUS_SESSION_BUS_ADDRESS','XDG_RUNTIME_DIR','AGENTGATE_FAKE_MANAGER_SECRET'].some(name=>Boolean(process.env[name]));
 fs.writeSync(1,JSON.stringify({nonce:p.nonce,cases,unix,direct,proxyPresent,credentials})+'\n');
})().catch(error=>{fs.writeSync(2,JSON.stringify({phase:'compatibility-probe-error',detail:error.message.slice(0,2048)})+'\n');process.exitCode=2});
`;

const MatrixRow = z
  .object({
    location: z.enum(locations),
    kind: z.enum(socketKinds),
    flags: z.number().int(),
    operation: z.enum(operations),
    created: z.boolean(),
    errno: z.number().int().nullable(),
    sent: z.boolean(),
    localReceived: z.boolean(),
  })
  .strict();
const Observation = z
  .object({
    nonce: z.string().uuid(),
    cases: z
      .array(
        z
          .object({
            method: z.enum(['spawnSync', 'spawn', 'fork']),
            inputCase: z.enum(['empty', 'utf8', 'multichunk']),
            exitCode: z.number().int().nullable(),
            signal: z.string().nullable(),
            error: z.string().nullable(),
            timedOut: z.boolean(),
            outputLimit: z.boolean(),
            stdinBytes: z.number().int().nonnegative(),
            stdoutMatches: z.boolean(),
            stderrMatches: z.boolean(),
            ipcMatches: z.boolean(),
          })
          .strict(),
      )
      .length(9),
    unix: z
      .object({
        matrix: z.array(MatrixRow).length(320),
        ordinary: z
          .array(
            z
              .object({
                location: z.enum(locations),
                kind: z.enum(socketKinds),
                created: z.boolean(),
                sent: z.boolean(),
                errno: z.number().int().nullable(),
              })
              .strict(),
          )
          .length(8),
        udp: z
          .array(
            z
              .object({
                name: z.enum(['udp4', 'udp6']),
                sent: z.boolean(),
                errno: z.number().int().nullable(),
              })
              .strict(),
          )
          .length(2),
      })
      .strict(),
    direct: z
      .array(
        z
          .object({
            name: z.enum(['tcp4', 'tcp6', 'public']),
            connected: z.boolean(),
            error: z.string().nullable(),
          })
          .strict(),
      )
      .length(3),
    proxyPresent: z.boolean(),
    credentials: z.boolean(),
  })
  .strict();

async function publicBaseline(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '1.1.1.1', port: 443 });
    const done = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(2500, () => done(false));
  });
}

async function readReady(path: string, nonce: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    abort.signal.throwIfAborted();
    try {
      const file = await lstat(path);
      assert.ok(file.isFile() && !file.isSymbolicLink() && file.size < 8192);
      const ready = HostReady.parse(JSON.parse(await readFile(path, 'utf8')));
      assert.equal(ready.nonce, nonce);
      return ready;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    await delay(10, undefined, { signal: abort.signal });
  }
  throw new Error('Host receiver baselines did not become ready.');
}

function requireKeys(actual: string[], expected: string[], message: string) {
  assert.deepEqual([...actual].sort(), [...expected].sort(), message);
}

function validateObservation(observation: z.infer<typeof Observation>) {
  requireKeys(
    observation.cases.map((row) => `${row.method}/${row.inputCase}`),
    ['spawnSync', 'spawn', 'fork'].flatMap((method) =>
      ['empty', 'utf8', 'multichunk'].map((input) => `${method}/${input}`),
    ),
    'Captured Node case matrix is incomplete.',
  );
  for (const row of observation.cases) {
    assert.equal(row.exitCode, 37, JSON.stringify(row));
    assert.equal(row.signal, null, JSON.stringify(row));
    assert.equal(row.error, null, JSON.stringify(row));
    assert.ok(
      !row.timedOut && !row.outputLimit && row.stdoutMatches && row.stderrMatches && row.ipcMatches,
      JSON.stringify(row),
    );
    if (row.inputCase === 'multichunk') assert.ok(row.stdinBytes > 128 * 1024);
    if (row.inputCase === 'empty') assert.equal(row.stdinBytes, 0);
  }
  const matrixKey = (row: z.infer<typeof MatrixRow>) =>
    `${row.location}/${row.kind}/${row.flags}/${row.operation}`;
  requireKeys(
    observation.unix.matrix.map(matrixKey),
    locations.flatMap((location) =>
      socketKinds.flatMap((kind) =>
        socketFlags.flatMap((flags) =>
          operations.map((operation) => `${location}/${kind}/${flags}/${operation}`),
        ),
      ),
    ),
    'Unix socketpair case matrix is incomplete.',
  );
  for (const row of observation.unix.matrix) {
    if (row.kind === 'DGRAM' || row.kind === 'RAW') {
      assert.ok(
        !row.created && !row.sent && !row.localReceived && row.errno === 1,
        JSON.stringify(row),
      );
    } else if (row.operation === 'local') {
      assert.ok(
        row.created && row.sent && row.localReceived && row.errno === null,
        JSON.stringify(row),
      );
    } else if (['sendto', 'sendmsg', 'sendmmsg'].includes(row.operation)) {
      // Connected pair types may ignore a supplied destination. Require local-peer delivery
      // or explicit denial; independent host counters must still remain zero.
      assert.ok(
        row.created &&
          ((row.sent && row.localReceived && row.errno === null) ||
            (!row.sent && !row.localReceived && row.errno !== null)),
        JSON.stringify(row),
      );
    } else
      assert.ok(
        row.created && !row.sent && !row.localReceived && row.errno !== null,
        JSON.stringify(row),
      );
  }
  requireKeys(
    observation.unix.ordinary.map((row) => `${row.location}/${row.kind}`),
    locations.flatMap((location) => socketKinds.map((kind) => `${location}/${kind}`)),
    'Ordinary Unix socket cases are incomplete.',
  );
  assert.ok(
    observation.unix.ordinary.every((row) => !row.sent && row.errno !== null),
    'A host Unix endpoint accepted communication.',
  );
  requireKeys(
    observation.unix.udp.map((row) => row.name),
    ['udp4', 'udp6'],
    'UDP cases are incomplete.',
  );
  assert.ok(
    observation.unix.udp.every((row) => row.sent === (row.errno === null)),
    'A UDP observation omitted its syscall outcome.',
  );
  requireKeys(
    observation.direct.map((row) => row.name),
    ['tcp4', 'tcp6', 'public'],
    'TCP cases are incomplete.',
  );
  assert.ok(
    observation.direct.every((row) => !row.connected && row.error !== null),
    'A denied TCP connection succeeded.',
  );
  assert.equal(observation.proxyPresent, false, 'Offline production policy exposed a proxy.');
  assert.equal(
    observation.credentials,
    false,
    'Controller or manager credentials reached the payload.',
  );
}

async function verifyProfile(codex: string, root: string, writable: boolean) {
  const name = writable ? 'write' : 'read-only';
  const home = join(root, `${name}-state`),
    workspace = join(root, `${name}-workspace`);
  await mkdir(workspace);
  const store = new FileRunStore(home);
  await store.init();
  const unlock = await store.acquireLock();
  const session = await createSandboxSession(home, workspace, writable, codex);
  const nonce = randomUUID();
  const targets = Object.fromEntries(
    locations.map((location) => [
      location,
      Object.fromEntries(
        ['STREAM', 'SEQPACKET', 'DGRAM'].map((kind) => [
          kind,
          location === 'pathname'
            ? join(workspace, `${kind.toLowerCase()}.sock`)
            : `\0agentgate-${nonce}-${kind}`,
        ]),
      ),
    ]),
  );
  for (const values of Object.values(targets))
    for (const path of Object.values(values))
      assert.ok(
        Buffer.byteLength(path) < 107,
        'Unix fixture path exceeds the native address limit.',
      );
  const forkPath = join(workspace, 'capture-child.cjs');
  await writeFile(forkPath, forkChild, { flag: 'wx' });
  const readyPath = join(home, 'receivers-ready.json'),
    stopPath = join(home, 'receivers-stop');
  let uncertain = false,
    hostStopped = false;
  let failure: unknown;
  const server = execute({
    command: '/usr/bin/python3',
    args: [
      '-I',
      '-c',
      hostSource,
      JSON.stringify({ nonce, targets, ready: readyPath, stop: stopPath }),
    ],
    cwd: session.launcher,
    env: session.env,
    timeoutMs: 80_000,
    maxOutputBytes: 16 * 1024,
    signal: abort.signal,
  }).then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
  const stopHost = async (): Promise<ExecuteResult> => {
    if (!hostStopped) {
      await writeFile(stopPath, nonce, { flag: 'wx' });
      hostStopped = true;
    }
    const outcome = await server;
    if ('error' in outcome) {
      uncertain ||= hasUncertainTermination(outcome.error);
      throw outcome.error;
    }
    return outcome.result;
  };
  try {
    await assert.rejects(lstat(join(home, 'codex', 'auth.json')), { code: 'ENOENT' });
    const ready = await readReady(readyPath, nonce);
    assert.equal(
      await publicBaseline(),
      true,
      'Public controller network baseline is unavailable.',
    );
    const result = await executeSandbox({
      command: session.codexExecutable ?? codex,
      args: [
        ...session.configArgs,
        'sandbox',
        '--include-managed-config',
        '-P',
        session.profile,
        '-C',
        session.launcher,
        '--',
        process.execPath,
        '-e',
        nodeSource,
        JSON.stringify({ nonce, targets, ports: ready.ports, forkPath, captureChild, unixSource }),
      ],
      cwd: session.launcher,
      env: session.env,
      linuxPipeTransport: true,
      timeoutMs: 55_000,
      maxOutputBytes: 256 * 1024,
      signal: abort.signal,
    });
    assert.equal(
      result.exitCode,
      0,
      `Native compatibility probe failed: ${result.stderr.slice(0, 4096)}`,
    );
    const observation = Observation.parse(JSON.parse(result.stdout));
    assert.equal(observation.nonce, nonce);
    const host = await stopHost();
    assert.equal(host.exitCode, 0, host.stderr.slice(0, 2048));
    const hostResult = HostResult.parse(JSON.parse(host.stdout));
    assert.equal(hostResult.nonce, nonce);
    assert.ok(
      Object.values(hostResult.counts).every((count) => count === 0),
      JSON.stringify({ unexpectedHostTraffic: hostResult.counts }),
    );
    assert.equal(
      await publicBaseline(),
      true,
      'Public controller baseline disappeared after the probe.',
    );
    validateObservation(observation);
    emit({
      phase: 'profile',
      profile: name,
      result: 'passed',
      capturedNodeCases: observation.cases.length,
      socketpairCases: observation.unix.matrix.length,
      ordinaryUnixCases: observation.unix.ordinary.length,
      hostCounts: hostResult.counts,
      controllerBaselinesBeforeAndAfter: true,
      localStreamAndSeqpacketIpc: true,
      proxyAbsent: true,
      credentialsAbsent: true,
      productionPolicy: true,
      modelInvoked: false,
    });
  } catch (error) {
    uncertain ||= hasUncertainTermination(error);
    failure = error;
  }
  try {
    await stopHost();
  } catch (error) {
    uncertain ||= hasUncertainTermination(error);
    if (!failure) failure = error;
    else if (hasUncertainTermination(error))
      failure = new AggregateError([failure, error], 'Compatibility fixture cleanup is uncertain.');
  }
  if (!uncertain) {
    try {
      await session.cleanup();
      await unlock();
    } catch (error) {
      failure ??= error;
    }
  }
  emit({
    phase: 'fixtures-retained',
    profile: name,
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
    throw new Error('Native compatibility acceptance requires Linux x86_64 and Node.js 24.');
  if (process.argv.length !== 3 || !isAbsolute(process.argv[2]!))
    throw new Error(
      'Usage: node test/manual/verify-linux-compatibility.ts <absolute-native-codex>',
    );
  const codex = await realpath(process.argv[2]!);
  assert.ok((await lstat(codex)).isFile());
  const root = await mkdtemp(join(await realpath(tmpdir()), 'agentgate-compat-'));
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
    phase: 'environment',
    scope,
    kernel: release(),
    node: process.version,
    architecture: process.arch,
    codex: CODEX_VERSION,
    root,
    productionPolicy: true,
    modelInvoked: false,
    authenticatedWorkflow: false,
  });
  await verifyProfile(codex, root, false);
  await verifyProfile(codex, root, true);
  emit({ result: 'passed', scope, modelInvoked: false, authenticatedWorkflow: false });
}

process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
try {
  await main();
} catch (error) {
  emit({
    result: 'blocked',
    scope,
    error:
      error instanceof Error
        ? error.message.slice(0, 8192)
        : 'Native compatibility acceptance failed.',
    uncertainTermination: hasUncertainTermination(error),
    modelInvoked: false,
  });
  process.exitCode = 2;
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
}
