import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { endianness } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { z } from 'zod';
import type { DoctorCheck } from '../core/contracts.ts';
import { hasUncertainTermination } from '../core/errors.ts';
import { execute } from './process.ts';

type Instruction = readonly [number, number, number, number];
const DENIED_SYSCALLS = [41, 42, 43, 49, 50, 288, 101, 310, 311, 425, 426, 427];

// Installed by real bubblewrap only after its filesystem and namespace setup.
// Deny new sockets/endpoints, retain anonymous stream IPC, and preserve existing
// ptrace/process_vm/io_uring restrictions. The model controller stays outside.
export const LINUX_SOCKETPAIR_FILTER: readonly Instruction[] = [
  [0x20, 0, 0, 4],
  [0x15, 1, 0, 0xc000003e],
  [0x06, 0, 0, 0x80000000],
  [0x20, 0, 0, 0],
  [0x45, 0, 1, 0x40000000],
  [0x06, 0, 0, 0x80000000],
  ...DENIED_SYSCALLS.flatMap((syscall): Instruction[] => [
    [0x15, 0, 1, syscall],
    [0x06, 0, 0, 0x50001],
  ]),
  [0x15, 1, 0, 53],
  [0x06, 0, 0, 0x7fff0000],
  [0x20, 0, 0, 16],
  [0x15, 1, 0, 1],
  [0x06, 0, 0, 0x50001],
  [0x20, 0, 0, 20],
  [0x15, 1, 0, 0],
  [0x06, 0, 0, 0x50001],
  [0x20, 0, 0, 28],
  [0x15, 1, 0, 0],
  [0x06, 0, 0, 0x50001],
  [0x20, 0, 0, 32],
  [0x15, 1, 0, 0],
  [0x06, 0, 0, 0x50001],
  [0x20, 0, 0, 36],
  [0x15, 1, 0, 0],
  [0x06, 0, 0, 0x50001],
  [0x20, 0, 0, 24],
  [0x45, 0, 1, 0xfff7f7f0],
  [0x06, 0, 0, 0x50001],
  [0x54, 0, 0, 0xf],
  [0x15, 2, 0, 1],
  [0x15, 1, 0, 5],
  [0x06, 0, 0, 0x50001],
  [0x06, 0, 0, 0x7fff0000],
];
const filterBytes = Buffer.alloc(LINUX_SOCKETPAIR_FILTER.length * 8);
LINUX_SOCKETPAIR_FILTER.forEach(([code, yes, no, value], index) => {
  filterBytes.writeUInt16LE(code, index * 8);
  filterBytes[index * 8 + 2] = yes;
  filterBytes[index * 8 + 3] = no;
  filterBytes.writeUInt32LE(value, index * 8 + 4);
});
const filterDigest = createHash('sha256').update(filterBytes).digest('hex');

/** Linux tests exercise the same validator executed by the actual private shim. */
export const LINUX_BWRAP_VALIDATOR = String.raw`
import json,os,re
def require(value,message):
    if not value: raise ValueError(message)
def unique_object(pairs):
    result={}
    for key,value in pairs:
        require(key not in result,'Duplicate permission field')
        result[key]=value
    return result
def prepare(arguments,expected_codex,expected_cwd):
    require(all(isinstance(value,str) and '\0' not in value for value in arguments),'Invalid argument')
    require(len(arguments)<65536 and sum(map(len,arguments))<4*1024*1024,'Argument limit')
    if arguments==['--unshare-user','--unshare-net','--ro-bind','/','/','/bin/true']:
        return list(arguments),'capability',None,None
    arities={
        '--as-pid-1':0,'--new-session':0,'--die-with-parent':0,
        '--unshare-user':0,'--unshare-pid':0,'--unshare-ipc':0,'--unshare-net':0,
        '--tmpfs':1,'--dev':1,'--proc':1,'--dir':1,'--remount-ro':1,'--perms':1,
        '--cap-drop':1,'--argv0':1,'--chdir':1,
        '--ro-bind':2,'--bind':2,'--bind-try':2,'--ro-bind-data':2,'--ro-bind-fd':2,
    }
    seen={}; index=0
    while index<len(arguments) and arguments[index]!='--':
        option=arguments[index]; require(option in arities,'Unsupported bubblewrap option')
        count=arities[option]; require(index+count<len(arguments),'Missing bubblewrap argument')
        values=arguments[index+1:index+count+1]
        require(all(values),'Empty bubblewrap argument')
        seen.setdefault(option,[]).append(values); index+=count+1
    require(index<len(arguments),'Missing bubblewrap command separator')
    for option in ['--as-pid-1','--new-session','--die-with-parent','--unshare-user','--unshare-pid','--unshare-ipc','--unshare-net']:
        require(seen.get(option)==[[]],'Missing or repeated namespace boundary')
    require(seen.get('--cap-drop')==[['ALL']],'Missing capability ceiling')
    require(['/'] in seen.get('--tmpfs',[]),'Missing private root filesystem')
    for option in ['--bind','--bind-try','--ro-bind']:
        require(all(values[1]!='/' for values in seen.get(option,[])),'Host root bind is unsupported')
    require(seen.get('--proc',[]) in [[],[['/proc']]],'Unexpected proc mount')
    payload=arguments[index+1:]
    if payload in [['/bin/true'],['/usr/bin/true']]:
        require('--argv0' not in seen,'Unexpected probe argv0')
        return list(arguments),'probe',None,index
    require(seen.get('--argv0')==[['codex-linux-sandbox']],'Missing trusted inner argv0')
    require(payload and payload[0]==expected_codex,'Unexpected inner executable')
    cursor=1
    while cursor<len(payload) and payload[cursor]=='--verify-fd-mount':
        require(cursor+1<len(payload) and re.fullmatch(r'[0-9]+:/.*',payload[cursor+1]),'Invalid mount verification')
        require(int(payload[cursor+1].split(':',1)[0])>2,'Unsafe mount descriptor')
        cursor+=2
    require(payload[cursor:cursor+2]==['--sandbox-policy-cwd',expected_cwd],'Unexpected policy directory'); cursor+=2
    if cursor<len(payload) and payload[cursor]=='--command-cwd':
        require(cursor+1<len(payload) and os.path.isabs(payload[cursor+1]),'Invalid command directory'); cursor+=2
    require(cursor+1<len(payload) and payload[cursor]=='--permission-profile','Missing permission profile')
    profile_index=cursor+1
    profile=json.loads(payload[profile_index],object_pairs_hook=unique_object)
    require(isinstance(profile,dict) and set(profile)=={'type','file_system','network'},'Unsupported permission profile')
    require(profile['type']=='managed' and profile['network']=='restricted','Network policy must remain restricted outside the shim')
    filesystem=profile['file_system']
    require(isinstance(filesystem,dict) and filesystem.get('type')=='restricted' and isinstance(filesystem.get('entries'),list),'Filesystem policy must be restricted')
    require(set(filesystem)<={'type','entries','glob_scan_max_depth'},'Unsupported filesystem policy field')
    require(payload[cursor+2:cursor+4]==['--apply-seccomp-then-exec','--'] and len(payload)>cursor+4,'Unexpected inner sandbox stage')
    original_profile=payload[profile_index]
    profile['network']='enabled'
    updated=list(arguments); updated[index+1+profile_index]=json.dumps(profile,separators=(',',':'))
    return updated,'worker',original_profile,index
`;

interface BoundarySpec {
  nonce: string;
  directory: string;
  receiptPath: string;
  codexExecutable: string;
  launcher: string;
  originalPath?: string;
  bwrap: string;
}

function shimSource(spec: BoundarySpec): string {
  return (
    '#!/usr/bin/env -S /usr/bin/python3 -I -S\n' +
    LINUX_BWRAP_VALIDATOR +
    String.raw`
import fcntl,hashlib,platform,struct,sys,uuid
if sys.version_info[:2]!=(3,12) or sys.byteorder!='little' or platform.machine()!='x86_64':
    raise SystemExit('Unsupported Linux boundary runtime.')
def trusted_executable(selected):
    require(os.lstat(selected).st_uid==0,'Untrusted boundary helper')
    path=os.path.realpath(selected); executable=path
    while True:
        entry=os.lstat(path)
        require(entry.st_uid==0 and not entry.st_mode&0o022,'Writable boundary helper')
        require(os.path.isfile(path) if path==executable else os.path.isdir(path),'Invalid boundary helper')
        parent=os.path.dirname(path)
        if parent==path: break
        path=parent
    require(os.access(executable,os.X_OK),'Boundary helper is not executable')
    return executable
for helper in ['/usr/bin/python3','/usr/bin/env','/bin/true','/usr/bin/true']:
    trusted_executable(helper)
spec=json.loads(${JSON.stringify(JSON.stringify(spec))})
spec['bwrap']=trusted_executable(spec['bwrap'])
arguments=sys.argv[1:]
if arguments in [['--help'],['--version']]:
    os.execve(spec['bwrap'],[spec['bwrap']]+arguments,os.environ)
try:
    updated,kind,profile,separator=prepare(arguments,spec['codexExecutable'],spec['launcher'])
except (ValueError,TypeError,KeyError,IndexError):
    raise SystemExit('Unsupported Codex bubblewrap invocation; execution blocked.')
environment=dict(os.environ)
if 'originalPath' in spec: environment['PATH']=spec['originalPath']
else: environment.pop('PATH',None)
if kind!='capability':
    instructions=${JSON.stringify(LINUX_SOCKETPAIR_FILTER)}
    raw=b''.join(struct.pack('<HBBI',*entry) for entry in instructions)
    descriptor=os.memfd_create('agentgate-network-filter',os.MFD_CLOEXEC|os.MFD_ALLOW_SEALING)
    require(os.write(descriptor,raw)==len(raw),'Incomplete seccomp program')
    os.lseek(descriptor,0,os.SEEK_SET)
    fcntl.fcntl(descriptor,fcntl.F_ADD_SEALS,fcntl.F_SEAL_WRITE|fcntl.F_SEAL_GROW|fcntl.F_SEAL_SHRINK|fcntl.F_SEAL_SEAL)
    os.set_inheritable(descriptor,True)
    updated[separator:separator]=['--seccomp',str(descriptor)]
    if kind=='worker':
        receipt={'nonce':spec['nonce'],'id':str(uuid.uuid4()),'kind':'worker','filterSha256':hashlib.sha256(raw).hexdigest(),'profileSha256':hashlib.sha256(profile.encode()).hexdigest()}
        temporary=spec['receiptPath']+'.'+str(os.getpid())+'.tmp'
        record=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(record,'w') as stream: json.dump(receipt,stream)
        os.replace(temporary,spec['receiptPath'])
os.execve(spec['bwrap'],[spec['bwrap']]+updated,environment)
`
  );
}

async function trustedExecutable(selected: string): Promise<string> {
  const link = await lstat(selected);
  if (link.uid !== 0) throw new Error('Linux boundary helpers must be owned by root.');
  const executable = await realpath(selected);
  for (let path = executable; ; path = dirname(path)) {
    const entry = await lstat(path);
    if (
      entry.isSymbolicLink() ||
      entry.uid !== 0 ||
      entry.mode & 0o022 ||
      (path === executable ? !entry.isFile() : !entry.isDirectory())
    )
      throw new Error(
        'Linux boundary helpers and ancestors must be root-owned and not writable by other users.',
      );
    if (dirname(path) === path) break;
  }
  await access(executable, constants.X_OK);
  return executable;
}

async function runtimeHelpers(): Promise<{ python: string; bwrap: string }> {
  if (process.platform !== 'linux' || process.arch !== 'x64' || endianness() !== 'LE')
    throw new Error('Linux network filtering supports native x86_64 little endian only.');
  const python = await trustedExecutable('/usr/bin/python3');
  const bwrap = await trustedExecutable('/usr/bin/bwrap');
  await trustedExecutable('/usr/bin/env');
  await trustedExecutable('/bin/true');
  await trustedExecutable('/usr/bin/true');
  if (/\s/.test(python)) throw new Error('Unsupported Python executable path.');
  return { python, bwrap };
}

const environment = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };

export async function checkLinuxNetworkFilter(signal?: AbortSignal): Promise<DoctorCheck> {
  try {
    const { python, bwrap } = await runtimeHelpers();
    const version = await execute({
      command: python,
      args: ['-I', '-S', '-c', 'import sys;print("%d.%d"%sys.version_info[:2])'],
      env: environment,
      timeoutMs: 10_000,
      maxOutputBytes: 4096,
      signal,
    });
    const help = await execute({
      command: bwrap,
      args: ['--help'],
      env: environment,
      timeoutMs: 10_000,
      maxOutputBytes: 32 * 1024,
      signal,
    });
    if (
      version.exitCode ||
      version.stdout.trim() !== '3.12' ||
      help.exitCode ||
      !['--as-pid-1', '--perms', '--argv0', '--seccomp'].every((option) =>
        help.stdout.includes(option),
      )
    )
      throw new Error(
        'Distro Python 3.12 and the required bubblewrap capabilities are unavailable.',
      );
    return {
      name: 'linux-network-filter',
      ok: true,
      detail:
        'Trusted Python and bubblewrap filter support are available; each physical probe must prove the private boundary was used.',
    };
  } catch (error) {
    signal?.throwIfAborted();
    return {
      name: 'linux-network-filter',
      ok: false,
      detail: error instanceof Error ? error.message : 'Linux network filtering is unavailable.',
    };
  }
}

export interface LinuxSandboxBoundary {
  directory: string;
  path: string;
  receiptPath: string;
  beginInvocation(): Promise<void>;
  assertUsed(requireInvocation?: boolean): Promise<void>;
  cleanup(): Promise<void>;
}
const boundaries = new Map<string, LinuxSandboxBoundary>();
const ReceiptSchema = z.object({
  nonce: z.uuid(),
  id: z.uuid(),
  kind: z.literal('worker'),
  filterSha256: z.string().regex(/^[a-f0-9]{64}$/),
  profileSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export async function createLinuxSandboxBoundary(
  runtime: string,
  codexExecutable: string,
  originalPath: string | undefined,
  launcher: string,
): Promise<LinuxSandboxBoundary> {
  runtime = await realpath(runtime);
  launcher = await realpath(launcher);
  codexExecutable = await realpath(codexExecutable);
  if (dirname(launcher) !== runtime || boundaries.has(launcher))
    throw new Error('Linux boundary requires an unused controller-owned runtime launcher.');
  for (const path of [runtime, launcher]) {
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.uid !== process.getuid!() || entry.mode & 0o077)
      throw new Error('Linux boundary directories must be private and owned by the controller.');
  }
  const directory = await mkdtemp(join(runtime, 'boundary-'));
  const child = relative(runtime, directory);
  if (!child || isAbsolute(child) || child.startsWith('..'))
    throw new Error('Unsafe boundary directory.');
  const receiptPath = join(directory, 'receipt.json');
  const nonce = randomUUID();
  const spec: BoundarySpec = {
    nonce,
    directory,
    receiptPath,
    codexExecutable,
    launcher,
    originalPath,
    bwrap: '/usr/bin/bwrap',
  };
  let lastReceipt: string | undefined;
  async function readReceipt(): Promise<z.infer<typeof ReceiptSchema>> {
    const entry = await lstat(receiptPath);
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      entry.uid !== process.getuid!() ||
      entry.mode & 0o077 ||
      entry.size > 4096
    )
      throw new Error('Unsafe Linux boundary receipt.');
    const receipt = ReceiptSchema.parse(JSON.parse(await readFile(receiptPath, 'utf8')));
    if (receipt.nonce !== nonce || receipt.filterSha256 !== filterDigest)
      throw new Error('Linux boundary usage could not be established for this invocation.');
    return receipt;
  }
  const boundary: LinuxSandboxBoundary = {
    directory,
    path: originalPath ? `${directory}:${originalPath}` : directory,
    receiptPath,
    async beginInvocation() {
      try {
        lastReceipt = (await readReceipt()).id;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
          lastReceipt = undefined;
        else throw error;
      }
    },
    async assertUsed(requireInvocation = true) {
      try {
        const receipt = await readReceipt();
        if (requireInvocation && receipt.id === lastReceipt)
          throw new Error('Linux boundary usage could not be established for this invocation.');
        if (requireInvocation) lastReceipt = receipt.id;
      } catch (error) {
        if (
          !requireInvocation &&
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        )
          return;
        throw error;
      }
    },
    async cleanup() {
      await rm(directory, { recursive: true });
      boundaries.delete(launcher);
    },
  };
  try {
    const shim = join(directory, 'bwrap');
    await writeFile(shim, shimSource(spec), { flag: 'wx', mode: 0o700 });
    boundaries.set(launcher, boundary);
    return boundary;
  } catch (error) {
    if (!hasUncertainTermination(error)) await rm(directory, { recursive: true });
    throw error;
  }
}

export async function beginLinuxSandboxBoundaryInvocation(launcher: string): Promise<void> {
  const boundary = boundaries.get(await realpath(launcher));
  if (!boundary) throw new Error('The native sandbox has no registered private network boundary.');
  await boundary.beginInvocation();
}

export async function assertLinuxSandboxBoundaryUsed(
  launcher: string,
  requireInvocation = true,
): Promise<void> {
  const boundary = boundaries.get(await realpath(launcher));
  if (!boundary) throw new Error('The native sandbox has no registered private network boundary.');
  await boundary.assertUsed(requireInvocation);
}
