import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { ChangedFile, Run } from './contracts.ts';

const REDACTED = '[REDACTED]';
const sensitiveEnvironmentName =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIALS?)(?:_|$)|^(?:DATABASE|REDIS)_URL$/i;
const secretKey =
  /^(?:authorization|proxyAuthorization|password|passwd|secret|token|accessToken|refreshToken|idToken|apiKey|privateKey|credentials|cookie|setCookie)$/i;
const reasoningKey = /^(?:raw)?reasoning(?:content|text|delta)?$|^chainofthought$/i;

/** Redact recognized credentials and configured secret values, without masking ordinary Git hashes. */
export function redact(text: string, sensitiveValues: readonly string[] = []): string {
  const environmentValues = Object.entries(process.env)
    .filter(([name, value]) => sensitiveEnvironmentName.test(name) && value && value.length >= 4)
    .map(([, value]) => value as string);
  const values = [...new Set([...environmentValues, ...sensitiveValues])]
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length);
  let result = text;
  for (const value of values) result = result.split(value).join(REDACTED);
  return result
    .replace(
      /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g,
      REDACTED,
    )
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{16,})\b/g,
      REDACTED,
    )
    .replace(/\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(
      /\b(?:AKIA[A-Z0-9]{16}|npm_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g,
      REDACTED,
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, `$1 ${REDACTED}`)
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`)
    .replace(
      /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|authorization)["']?\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
      `$1${REDACTED}`,
    );
}

/** Strip escape sequences, cursor controls and directional overrides before terminal display. */
export function cleanTerminal(text: string): string {
  const clean = stripVTControlCharacters(text)
    .replace(/\r\n?/g, '\n')
    // Control characters are the intended input of this terminal sanitizer.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '');
  return redact(clean);
}

/** Keep stored events JSON-shaped, remove reasoning, and scrub secrets at every nesting level. */
export function scrubForStorage(value: unknown): unknown {
  return scrub(value, new Set<object>(), 0);
}

function scrub(value: unknown, ancestors: Set<object>, depth: number): unknown {
  if (depth > 64) throw new Error('Stored data exceeds the nesting limit');
  if (typeof value === 'string') return redact(value);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value === undefined) return undefined;
  if (typeof value !== 'object') throw new Error('Stored data must contain only JSON values');
  if (ancestors.has(value)) throw new Error('Stored data must not contain cycles');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => scrub(item, ancestors, depth + 1));
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      throw new Error('Stored data must contain only plain objects');
    }
    const record = value as Record<string, unknown>;
    if (
      ['type', 'method'].some(
        (key) => typeof record[key] === 'string' && /reasoning|chain.of.thought/i.test(record[key]),
      )
    ) {
      return { type: 'omitted', category: 'reasoning' };
    }
    return Object.fromEntries(
      Object.entries(record)
        .filter(([key]) => !reasoningKey.test(key.replace(/[_-]/g, '')))
        .map(([key, item]) => [
          key,
          secretKey.test(key.replace(/[_-]/g, '')) ? REDACTED : scrub(item, ancestors, depth + 1),
        ]),
    );
  } finally {
    ancestors.delete(value);
  }
}

export function approvalFingerprint(run: Run): string {
  if (!run.plan) throw new Error('A plan is required before calculating its approval');
  const approved = scrubForStorage({
    schemaVersion: run.schemaVersion,
    id: run.id,
    repo: { ...run.repo, path: resolve(run.repo.path) },
    issue: run.issue,
    baseCommit: run.baseCommit,
    branch: run.branch,
    worktree: resolve(run.worktree),
    plan: run.plan,
  });
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(approved)))
    .digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function scopePath(value: string, directoryAllowed: boolean): string {
  const path = directoryAllowed ? value.replace(/\/$/, '') : value;
  if (
    !path ||
    ['\\', ':', '*', '?', '[', ']'].some((character) => path.includes(character)) ||
    [...path].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('Scope paths must be explicit repository-relative files or directory prefixes');
  }
  return path;
}

export function assertWithinScope(files: ChangedFile[], allowedPaths: string[]): void {
  if (allowedPaths.length === 0) throw new Error('An approved file scope is required');
  const allowed = allowedPaths.map((path) => scopePath(path, true));
  for (const file of files) {
    const path = scopePath(file.path, false);
    if (!allowed.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
      throw new Error(`Change outside the approved scope: ${cleanTerminal(path)}`);
    }
  }
}

/** Conservative publication exclusions; examples remain usable without admitting real env files. */
export function isSensitivePath(file: string): boolean {
  const path = file.replace(/\\/g, '/').toLowerCase();
  const parts = path.split('/');
  if (
    parts.some((part) => ['.git', '.aws', '.ssh', '.codex', '.claude', '.agentgate'].includes(part))
  )
    return true;
  const name = parts.at(-1) ?? '';
  if ((name === '.env' || name.startsWith('.env.')) && name !== '.env.example') return true;
  return /^(?:auth|credentials)(?:\.(?:json|ya?ml|toml|ini))?$|^id_(?:rsa|dsa|ecdsa|ed25519)$|\.(?:key|p12|pfx)$/.test(
    name,
  );
}
