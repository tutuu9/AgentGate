import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  LINUX_BWRAP_VALIDATOR,
  LINUX_SOCKETPAIR_FILTER,
  assertLinuxSandboxBoundaryUsed,
  beginLinuxSandboxBoundaryInvocation,
  checkLinuxNetworkFilter,
  createLinuxSandboxBoundary,
} from '../src/adapters/linux-network-filter.ts';
import { execute } from '../src/adapters/process.ts';

const ALLOW = 0x7fff0000;
const EPERM = 0x50001;
const KILL = 0x80000000;

/** Evaluate the actual shipped classic-BPF program against syscall data, without claiming native evidence. */
function decision({ arch = 0xc000003e, syscall = 53, args = [1n, 1n, 0n] } = {}): number {
  const data = Buffer.alloc(64);
  data.writeUInt32LE(syscall >>> 0, 0);
  data.writeUInt32LE(arch >>> 0, 4);
  args.forEach((argument, index) =>
    data.writeBigUInt64LE(BigInt.asUintN(64, argument), 16 + index * 8),
  );
  let accumulator = 0;
  for (let pc = 0; pc < LINUX_SOCKETPAIR_FILTER.length; pc++) {
    const [opcode, yes, no, value] = LINUX_SOCKETPAIR_FILTER[pc]!;
    switch (opcode) {
      case 0x20:
        accumulator = data.readUInt32LE(value);
        break;
      case 0x15:
        pc += accumulator === value ? yes : no;
        break;
      case 0x45:
        pc += (accumulator & value) !== 0 ? yes : no;
        break;
      case 0x54:
        accumulator = (accumulator & value) >>> 0;
        break;
      case 0x06:
        return value;
      default:
        throw new Error(`Unsupported BPF instruction ${opcode}.`);
    }
  }
  throw new Error('Network filter did not return a decision.');
}

test('socketpair filter preserves anonymous stream and sequenced-packet IPC with supported flags', () => {
  for (const type of [1n, 5n])
    for (const flags of [0n, 0x800n, 0x80000n, 0x80800n])
      assert.equal(decision({ args: [1n, type | flags, 0n] }), ALLOW);
});

test('socketpair filter denies datagram and raw pairs including every supported flag combination', () => {
  for (const type of [0n, 2n, 3n, 4n, 6n, 15n])
    for (const flags of [0n, 0x800n, 0x80000n, 0x80800n])
      assert.equal(decision({ args: [1n, type | flags, 0n] }), EPERM);
});

test('socketpair filter rejects other families, protocols, unknown flags and upper-word aliases', () => {
  for (const domain of [0n, 2n, 10n, 40n, -1n, 0x100000001n])
    assert.equal(decision({ args: [domain, 1n, 0n] }), EPERM);
  for (const protocol of [1n, 6n, -1n, 0x100000000n])
    assert.equal(decision({ args: [1n, 1n, protocol] }), EPERM);
  for (const type of [0x11n, 0x1001n, 0x100001n, 0x100000001n, -1n])
    assert.equal(decision({ args: [1n, type, 0n] }), EPERM);
});

test('socketpair filter kills alternate syscall ABIs before considering syscall numbers', () => {
  for (const arch of [0x40000003, 0xc00000b7, 0, 0xffffffff]) {
    assert.equal(decision({ arch }), KILL);
    assert.equal(decision({ arch, syscall: 1 }), KILL);
  }
  for (const syscall of [0x40000035, 0x40000000, 0xffffffff])
    assert.equal(decision({ syscall }), KILL);
});

test('target filter denies every new socket endpoint and process inspection escape', () => {
  for (const syscall of [41, 42, 43, 49, 50, 288, 101, 310, 311, 425, 426, 427])
    for (const args of [
      [1n, 1n, 0n],
      [2n, 2n, 17n],
    ])
      assert.equal(decision({ syscall, args }), EPERM);
});

test('target filter preserves stream classification, shutdown and messaging on existing anonymous peers', () => {
  for (const syscall of [0, 1, 44, 46, 47, 51, 52, 54, 55, 48, 59, 299, 307])
    assert.equal(decision({ syscall, args: [2n, 2n, 17n] }), ALLOW);
});

const codex = '/opt/codex/codex';
const launcher = '/state/runtime/launch-test';
const filesystem = {
  type: 'restricted',
  entries: [{ path: { type: 'path', path: '/workspace/quote";$ literal' }, access: 'read' }],
  glob_scan_max_depth: 8,
};
const profile = JSON.stringify({ type: 'managed', file_system: filesystem, network: 'restricted' });
const outer = [
  '--as-pid-1',
  '--tmpfs',
  '/',
  '--dev',
  '/dev',
  '--ro-bind',
  '/usr',
  '/usr',
  '--ro-bind-data',
  '10',
  '/etc/fixture',
  '--ro-bind',
  '/proc/self/fd/9',
  '/workspace/.git',
  '--new-session',
  '--die-with-parent',
  '--unshare-user',
  '--unshare-pid',
  '--unshare-ipc',
  '--unshare-net',
  '--proc',
  '/proc',
  '--cap-drop',
  'ALL',
];
const inner = [
  codex,
  '--verify-fd-mount',
  '9:/workspace/.git',
  '--sandbox-policy-cwd',
  launcher,
  '--command-cwd',
  '/workspace',
  '--permission-profile',
  profile,
  '--apply-seccomp-then-exec',
  '--',
  '/usr/bin/node',
  '-e',
  'console.log("literal $;% --")',
];
const invocation = [...outer, '--argv0', 'codex-linux-sandbox', '--', ...inner];

test(
  'the actual Python validator preserves original mounts and target while rejecting unsupported boundaries',
  { skip: process.platform !== 'linux' },
  async () => {
    const replace = (before: string, after: string) =>
      invocation.map((value) => (value === before ? after : value));
    const invalid = [
      invocation.filter((value) => value !== '--unshare-net'),
      ['--unshare-net', ...invocation],
      ['--share-net', ...invocation],
      ['--seccomp', '9', ...invocation],
      ['--args', '9', ...invocation],
      ['--cap-add', 'ALL', ...invocation],
      replace(codex, '/workspace/untrusted-codex'),
      replace(launcher, '/workspace'),
      replace('9:/workspace/.git', '1:/workspace/.git'),
      replace(profile, profile.replace('"restricted"}', '"enabled"}')),
      replace(
        profile,
        JSON.stringify({
          type: 'managed',
          file_system: { type: 'unrestricted' },
          network: 'restricted',
        }),
      ),
      replace(
        profile,
        profile.replace('"type":"managed"', '"type":"managed","network":"restricted"'),
      ),
      replace('--apply-seccomp-then-exec', '--allow-network-for-proxy'),
      [...outer, '--', '/bin/true', 'unexpected'],
      [...outer, '--', '/usr/bin/node'],
      ['--ro-bind', '/', '/', ...invocation],
    ];
    const cases = [
      invocation,
      [...outer, '--', '/bin/true'],
      ['--unshare-user', '--unshare-net', '--ro-bind', '/', '/', '/bin/true'],
      ...invalid,
    ];
    const script =
      LINUX_BWRAP_VALIDATOR +
      String.raw`
import sys
records=json.load(sys.stdin); results=[]
for arguments in records:
    try:
        updated,kind,original,separator=prepare(arguments,'/opt/codex/codex','/state/runtime/launch-test')
        results.append({'accepted':True,'args':updated,'kind':kind,'original':original,'separator':separator})
    except (ValueError,TypeError,KeyError,IndexError): results.append({'accepted':False})
print(json.dumps(results))
`;
    const result = await execute({
      command: '/usr/bin/python3',
      args: ['-I', '-S', '-c', script],
      env: { PATH: '/usr/bin:/bin' },
      input: JSON.stringify(cases),
      timeoutMs: 10_000,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    const records = JSON.parse(result.stdout) as {
      accepted: boolean;
      args: string[];
      kind: string;
      original: string;
      separator: number;
    }[];
    assert.equal(records[0]!.kind, 'worker');
    const updated = [...records[0]!.args];
    const profileIndex = updated.indexOf('--permission-profile') + 1;
    assert.deepEqual(JSON.parse(updated[profileIndex]!), {
      type: 'managed',
      file_system: filesystem,
      network: 'enabled',
    });
    updated[profileIndex] = profile;
    assert.deepEqual(updated, invocation);
    assert.equal(records[0]!.original, profile);
    assert.equal(records[0]!.separator, outer.length + 2);
    assert.equal(records[1]!.kind, 'probe');
    assert.equal(records[2]!.kind, 'capability');
    assert.ok(records.slice(3).every((record) => !record.accepted));
  },
);

test(
  'boundary artifacts stay private and invocation receipts fail closed without native execution',
  { skip: process.platform !== 'linux' },
  async () => {
    const runtime = await mkdtemp(join(tmpdir(), 'agentgate-boundary-test-'));
    try {
      const session = join(runtime, 'launch-test');
      const executable = join(runtime, 'fake-codex');
      await mkdir(session, { mode: 0o700 });
      await writeFile(executable, 'This fixture must never execute.');
      const boundary = await createLinuxSandboxBoundary(
        runtime,
        executable,
        '/usr/bin:/bin',
        session,
      );
      assert.equal(boundary.path, `${boundary.directory}:/usr/bin:/bin`);
      const source = await readFile(join(boundary.directory, 'bwrap'), 'utf8');
      assert.ok(source.startsWith('#!/usr/bin/env -S /usr/bin/python3 -I -S'));
      const syntax = await execute({
        command: '/usr/bin/python3',
        args: ['-I', '-S', '-c', 'import sys;compile(sys.stdin.read(),"boundary","exec")'],
        env: { PATH: '/usr/bin:/bin' },
        input: source,
        timeoutMs: 10_000,
      });
      assert.equal(syntax.exitCode, 0, syntax.stderr);
      await beginLinuxSandboxBoundaryInvocation(session);
      await assertLinuxSandboxBoundaryUsed(session, false);
      await assert.rejects(assertLinuxSandboxBoundaryUsed(session), { code: 'ENOENT' });

      // Simulate trusted shim receipts to test freshness, without claiming native enforcement.
      const spec = JSON.parse(JSON.parse(/^spec=json.loads\((.*)\)$/m.exec(source)![1]!)) as {
        nonce: string;
      };
      const bytes = Buffer.alloc(LINUX_SOCKETPAIR_FILTER.length * 8);
      LINUX_SOCKETPAIR_FILTER.forEach(([code, yes, no, value], index) => {
        bytes.writeUInt16LE(code, index * 8);
        bytes[index * 8 + 2] = yes;
        bytes[index * 8 + 3] = no;
        bytes.writeUInt32LE(value, index * 8 + 4);
      });
      const publish = async () =>
        writeFile(
          boundary.receiptPath,
          JSON.stringify({
            nonce: spec.nonce,
            id: randomUUID(),
            kind: 'worker',
            filterSha256: createHash('sha256').update(bytes).digest('hex'),
            profileSha256: createHash('sha256').update(profile).digest('hex'),
          }),
          { mode: 0o600 },
        );
      await publish();
      await assertLinuxSandboxBoundaryUsed(session, false);
      await beginLinuxSandboxBoundaryInvocation(session);
      await assert.rejects(assertLinuxSandboxBoundaryUsed(session), /could not be established/);
      await publish();
      await assertLinuxSandboxBoundaryUsed(session, false);
      await assertLinuxSandboxBoundaryUsed(session);
      await assert.rejects(assertLinuxSandboxBoundaryUsed(session), /could not be established/);
      await writeFile(boundary.receiptPath, '{}', { mode: 0o600 });
      await assert.rejects(beginLinuxSandboxBoundaryInvocation(session));
      await assert.rejects(assertLinuxSandboxBoundaryUsed(session, false));
      await boundary.cleanup();
      await assert.rejects(
        assertLinuxSandboxBoundaryUsed(session),
        /no registered private network boundary/,
      );
    } finally {
      await rm(runtime, { recursive: true, force: true });
    }
  },
);

test(
  'unsupported hosts report the network filter prerequisite blocked',
  { skip: process.platform === 'linux' && process.arch === 'x64' },
  async () => {
    const result = await checkLinuxNetworkFilter();
    assert.equal(result.name, 'linux-network-filter');
    assert.equal(result.ok, false);
  },
);
