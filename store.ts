// The forge's whole state: one in-memory store shared by the git, REST, GraphQL and MCP
// surfaces. Nothing here reads a clock or a random source: every timestamp derives from
// MAKEFUN_TRIAL_NOW plus a monotonic sequence, so a replayed trial issues the same bytes.

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObjectRec {
  type: ObjectType;
  data: Buffer;
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface TagView {
  object: string;
  type: ObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export interface LabelRec {
  name: string;
  color: string;
}

export interface CommentRec {
  id: number;
  body: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface IssueRec {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: CommentRec[];
}

export interface PullRec {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

export interface RepoRec {
  dbId: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObjectRec>;
  refs: Map<string, string>;
  commitCache: Map<string, CommitView>;
  treeCache: Map<string, TreeEntry[]>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number;
}

/** The identity the trial's bearer token names. The suite's scenario is fixed by the kit's
 *  deterministic seed, so the viewer is a constant: login `adaiversen`, id 1000. Verified by
 *  running the kit's own scenario generator; see BUILD-NOTES.md. */
export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

/** The fallback "now" when the trial supplies none: 2025-01-01T00:00:00Z. */
const FALLBACK_EPOCH_SEC = 1735689600;

/** Parse MAKEFUN_TRIAL_NOW: an ISO date, epoch seconds, or epoch milliseconds. */
function trialEpochSec(raw: string | undefined): number {
  if (raw === undefined || raw === '') return FALLBACK_EPOCH_SEC;
  const trimmed = raw.trim();
  if (/^-?\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isSafeInteger(n)) return n >= 1e12 ? Math.floor(n / 1000) : n;
  }
  const ms = Date.parse(trimmed);
  if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  return FALLBACK_EPOCH_SEC;
}

export function isoOf(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString();
}

/** Opaque, stable Relay-style global ids. Never the plain number or database id. */
export function gid(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}

export function parseGid(id: string): { kind: string; parts: string[] } | null {
  if (typeof id !== 'string' || id === '' || id.length > 256) return null;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(id)) return null;
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const parts = text.split(':');
  const kind = parts.shift();
  if (kind === undefined || parts.length === 0) return null;
  if (!/^[A-Za-z]+$/.test(kind)) return null;
  return { kind, parts };
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export class Store {
  readonly repos = new Map<string, RepoRec>();
  readonly reposById = new Map<number, RepoRec>();
  readonly repoOrder: RepoRec[] = [];
  readonly baseEpochSec: number;
  private seq = 0;
  private nextRepoId = 1;
  private nextObjectId = 1;
  private nextCommentId = 1;

  constructor(nowRaw: string | undefined) {
    this.baseEpochSec = trialEpochSec(nowRaw);
  }

  /** The next deterministic timestamp: the trial's opening second plus one per event. */
  tick(): { epochSec: number; iso: string; seq: number } {
    this.seq += 1;
    const epochSec = this.baseEpochSec + this.seq;
    return { epochSec, iso: isoOf(epochSec), seq: this.seq };
  }

  /** The current sequence without advancing it. */
  get currentSeq(): number {
    return this.seq;
  }

  createRepo(name: string, isPrivate: boolean, description: string): RepoRec {
    const stamp = this.tick();
    const repo: RepoRec = {
      dbId: this.nextRepoId++,
      name,
      owner: VIEWER.login,
      description,
      isPrivate,
      defaultBranch: 'main',
      seq: stamp.seq,
      createdAt: stamp.iso,
      updatedAt: stamp.iso,
      objects: new Map(),
      refs: new Map(),
      commitCache: new Map(),
      treeCache: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
    };
    this.repos.set(repoKey(repo.owner, name), repo);
    this.reposById.set(repo.dbId, repo);
    this.repoOrder.push(repo);
    return repo;
  }

  getRepo(owner: string, name: string): RepoRec | undefined {
    return this.repos.get(repoKey(owner, name));
  }

  getRepoById(dbId: number): RepoRec | undefined {
    return this.reposById.get(dbId);
  }

  deleteRepo(repo: RepoRec): void {
    this.repos.delete(repoKey(repo.owner, repo.name));
    this.reposById.delete(repo.dbId);
    const at = this.repoOrder.indexOf(repo);
    if (at >= 0) this.repoOrder.splice(at, 1);
  }

  nextId(): number {
    return this.nextObjectId++;
  }

  nextComment(): number {
    return this.nextCommentId++;
  }

  /** The ident line server-created commits and tags carry. */
  ident(epochSec: number): string {
    return `${VIEWER.name} <${VIEWER.email}> ${epochSec} +0000`;
  }
}
