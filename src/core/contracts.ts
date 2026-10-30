import { z } from 'zod';

export const CheckSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()),
  timeoutMs: z.number().int().positive().max(600_000).default(600_000),
});
export type CheckSpec = z.infer<typeof CheckSchema>;
export const RepoSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
  path: z.string().min(1),
  fullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  baseBranch: z.string().min(1),
  checks: z.array(CheckSchema).min(1),
});
export type RepoProfile = z.infer<typeof RepoSchema>;
const ScopePath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !['\\', ':', '*', '?', '[', ']'].some((character) => value.includes(character)) &&
      !value
        .replace(/\/$/, '')
        .split('/')
        .some((part) => !part || part === '..' || part === '.') &&
      ![...value].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ),
    'Use explicit repository-relative files or directory prefixes, without globs or parent traversal',
  );
export const PlanSchema = z.object({
  objective: z.string().min(1),
  steps: z.array(z.string().min(1)).min(1),
  allowedPaths: z.array(ScopePath).min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  risks: z.array(z.string()),
});
export type Plan = z.infer<typeof PlanSchema>;
export const ImplementationSchema = z.object({ summary: z.string().min(1) });
export const ReviewSchema = z.object({
  summary: z.string().min(1),
  findings: z.array(
    z.object({
      severity: z.enum(['blocking', 'advisory']),
      file: z.string(),
      message: z.string().min(1),
    }),
  ),
});
export type Review = z.infer<typeof ReviewSchema>;
export type AgentStage = 'plan' | 'implement' | 'review';
export interface AgentResultMap {
  plan: Plan;
  implement: z.infer<typeof ImplementationSchema>;
  review: Review;
}
export const IssueSchema = z.object({
  url: z.string().url(),
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
});
export type Issue = z.infer<typeof IssueSchema>;
export const CheckResultSchema = z.object({
  name: z.string(),
  exitCode: z.number().int(),
  output: z.string(),
  durationMs: z.number().nonnegative(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;
export const RunSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  repo: RepoSchema,
  issue: IssueSchema,
  baseCommit: z.string(),
  branch: z.string(),
  worktree: z.string(),
  status: z.enum([
    'planning',
    'awaiting_plan',
    'preparing',
    'implementing',
    'checking',
    'reviewing',
    'awaiting_publish',
    'publishing',
    'completed',
    'blocked',
    'failed',
    'cancelled',
    'interrupted',
  ]),
  checkpoint: z
    .enum(['plan', 'prepare', 'implement', 'check', 'review', 'publish'])
    .default('plan'),
  createdAt: z.string(),
  updatedAt: z.string(),
  activeMs: z.number().nonnegative().default(0),
  activeStartedAt: z.number().int().nonnegative().optional(),
  plan: PlanSchema.optional(),
  planApproval: z.string().optional(),
  checks: z.array(CheckResultSchema).default([]),
  review: ReviewSchema.optional(),
  checkedTree: z.string().optional(),
  candidateCommit: z.string().optional(),
  publicationApproval: z.string().optional(),
  repairAttempts: z.number().int().min(0).max(1).default(0),
  repairFeedback: z.string().optional(),
  prUrl: z.string().url().optional(),
  ordinaryPrApproved: z.boolean().default(false),
  message: z.string().optional(),
  implementationSummary: z.string().optional(),
});
export type Run = z.infer<typeof RunSchema>;
export interface AgentContext {
  run: Run;
  feedback?: string;
  diff?: string;
}
export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}
export interface AgentRunner {
  run<S extends AgentStage>(
    stage: S,
    context: AgentContext,
    signal?: AbortSignal,
  ): Promise<AgentResultMap[S]>;
}
export interface SandboxRunner {
  doctor(signal?: AbortSignal): Promise<DoctorCheck[]>;
  check(spec: CheckSpec, worktree: string, signal?: AbortSignal): Promise<CheckResult>;
}
export interface ChangedFile {
  path: string;
  status: string;
}
export interface GitHubGateway {
  identify(path: string, signal?: AbortSignal): Promise<{ fullName: string; baseBranch: string }>;
  issue(url: string, repo: RepoProfile, signal?: AbortSignal): Promise<Issue>;
  baseCommit(repo: RepoProfile, signal?: AbortSignal): Promise<string>;
  createWorktree(
    repo: RepoProfile,
    path: string,
    branch: string,
    baseCommit: string,
    signal?: AbortSignal,
  ): Promise<void>;
  snapshot(worktree: string, signal?: AbortSignal): Promise<string>;
  changes(worktree: string, baseCommit: string, signal?: AbortSignal): Promise<ChangedFile[]>;
  diff(worktree: string, baseCommit: string, signal?: AbortSignal): Promise<string>;
  commit(worktree: string, tree: string, message: string, signal?: AbortSignal): Promise<string>;
  verifyCommit(worktree: string, commit: string, tree: string, signal?: AbortSignal): Promise<void>;
  publish(
    run: Run,
    draft: boolean,
    signal?: AbortSignal,
  ): Promise<{ kind: 'published'; url: string } | { kind: 'draft-unavailable' }>;
  cleanup(run: Run, signal?: AbortSignal): Promise<void>;
}
export interface UserInteraction {
  show(text: string): void;
  approvePlan(run: Run): Promise<'approve' | 'reject' | { feedback: string }>;
  prepared(run: Run): Promise<boolean>;
  approvePublication(run: Run, diff: string): Promise<boolean>;
  approveOrdinaryPr(run: Run): Promise<boolean>;
}
