// GitHub REST v3: repositories, branches, commits, contents, labels, issues, comments and
// pull requests, over the shared store. Every reply is JSON with X-GitHub-Request-Id (the
// router adds the header); errors carry a string `message`.

import type { IssueRec, PullRec, RepoRec, Store } from './store.ts';
import { VIEWER, gid } from './store.ts';
import {
  ZERO_OID,
  buildCommit,
  buildTreeFromMap,
  commitHistory,
  commitOf,
  diffFlatMaps,
  flattenTree,
  isOid,
  lineCounts,
  lookupPath,
  mergeBase,
  peelToCommit,
  putObject,
  threeWayMerge,
} from './gitobj.ts';

export interface RestRequest {
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  bodyMalformed: boolean;
  origin: string;
}

export interface RestReply {
  status: number;
  json: unknown;
  headers?: Record<string, string>;
  empty?: boolean;
}

function ok(status: number, json: unknown, headers?: Record<string, string>): RestReply {
  return { status, json, headers };
}

function err(status: number, message: string): RestReply {
  return { status, json: { message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function bodyObject(req: RestRequest): Record<string, unknown> | null {
  if (req.bodyMalformed) return null;
  if (req.body === undefined || req.body === null) return {};
  return isRecord(req.body) ? req.body : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

// --------------------------------------------------------------------------------------------
// serializers (shared with the GraphQL and MCP surfaces)
// --------------------------------------------------------------------------------------------

export function userJson(): Record<string, unknown> {
  return { login: VIEWER.login, id: VIEWER.id, type: 'User', name: VIEWER.name, email: VIEWER.email };
}

export function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.dbId,
    node_id: gid('Repository', repo.dbId),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

export function labelJson(repo: RepoRec, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return { name, color: label?.color ?? 'ededed', description: '' };
}

export function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: gid('Issue', repo.dbId, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: userJson(),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
  };
}

export function commentJson(comment: { id: number; body: string; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: userJson(),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

function refTip(repo: RepoRec, branch: string, fallback: string | null): string {
  const live = repo.refs.get(`refs/heads/${branch}`);
  if (live !== undefined) return live;
  if (fallback !== null) return fallback;
  return ZERO_OID;
}

export function pullJson(repo: RepoRec, pull: PullRec, stored?: { headSha: string; baseSha: string }): Record<string, unknown> {
  const headSha = refTip(repo, pull.head, stored?.headSha ?? null);
  const baseSha = refTip(repo, pull.base, stored?.baseSha ?? null);
  return {
    id: pull.id,
    node_id: gid('PullRequest', repo.dbId, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.head, sha: headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: baseSha, label: `${repo.owner}:${pull.base}` },
    user: userJson(),
    merged: pull.merged,
    mergeable: pull.state === 'open' ? prMergeable(repo, pull) : false,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
  };
}

/** Whether an open pull request merges cleanly (a three-way merge with no conflicts). */
export function prMergeable(repo: RepoRec, pull: PullRec): boolean {
  const outcome = mergePlan(repo, pull);
  return outcome !== null && outcome.conflicts.length === 0;
}

interface MergePlan {
  baseTip: string;
  headTip: string;
  baseTree: string;
  mergedTree: string;
  conflicts: string[];
}

export function mergePlan(repo: RepoRec, pull: PullRec): MergePlan | null {
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  if (baseTip === undefined || headTip === undefined) return null;
  const baseCommit = peelToCommit(repo, baseTip);
  const headCommit = peelToCommit(repo, headTip);
  if (baseCommit === null || headCommit === null) return null;
  const base = mergeBase(repo, baseCommit, headCommit);
  const baseView = commitOf(repo, baseCommit);
  const headView = commitOf(repo, headCommit);
  if (baseView === null || headView === null) return null;
  const baseTree = base === null ? new Map() : flattenTree(repo, (commitOf(repo, base) as { tree: string }).tree);
  const ours = flattenTree(repo, baseView.tree);
  const theirs = flattenTree(repo, headView.tree);
  const { merged, conflicts } = threeWayMerge(baseTree, ours, theirs);
  return { baseTip: baseCommit, headTip: headCommit, baseTree: baseView.tree, mergedTree: buildTreeFromMap(repo, merged), conflicts };
}

// --------------------------------------------------------------------------------------------
// pagination
// --------------------------------------------------------------------------------------------

function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
  const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
  const perPage = Number.isInteger(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  return { perPage, page };
}

function paginate<T>(items: readonly T[], req: RestRequest, path: string): { page: T[]; headers?: Record<string, string> } {
  const { perPage, page } = pageParams(req.query);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  if (page >= totalPages) return { page: slice };
  const linkFor = (p: number): string => {
    const params = new URLSearchParams(req.query);
    params.set('page', String(p));
    params.set('per_page', String(perPage));
    return `<${req.origin}${path}?${params.toString()}>`;
  };
  const links = [`${linkFor(page + 1)}; rel="next"`, `${linkFor(totalPages)}; rel="last"`];
  return { page: slice, headers: { link: links.join(', ') } };
}

// --------------------------------------------------------------------------------------------
// ref resolution and commits
// --------------------------------------------------------------------------------------------

/** Resolve a branch name, ref name or oid to a commit oid, or null. */
export function resolveRef(repo: RepoRec, refish: string): string | null {
  if (isOid(refish)) {
    if (repo.objects.has(refish)) return peelToCommit(repo, refish) ?? (commitOf(repo, refish) !== null ? refish : null);
    return null;
  }
  const candidates = [`refs/heads/${refish}`, refish, `refs/tags/${refish}`, `refs/heads/${refish.replace(/^refs\/heads\//, '')}`];
  for (const candidate of candidates) {
    const oid = repo.refs.get(candidate);
    if (oid !== undefined) return peelToCommit(repo, oid);
  }
  return null;
}

function splitIdent(line: string): { name: string; email: string; epoch: number } {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', epoch: 0 };
  return { name: match[1] as string, email: match[2] as string, epoch: Number(match[3]) };
}

function commitJson(repo: RepoRec, oid: string): Record<string, unknown> {
  const view = commitOf(repo, oid);
  const author = view !== null ? splitIdent(view.author) : { name: '', email: '', epoch: 0 };
  const committer = view !== null ? splitIdent(view.committer) : { name: '', email: '', epoch: 0 };
  const date = (epoch: number): string => new Date(epoch * 1000).toISOString();
  return {
    sha: oid,
    commit: {
      message: view?.message ?? '',
      author: { name: author.name, email: author.email, date: date(author.epoch) },
      committer: { name: committer.name, email: committer.email, date: date(committer.epoch) },
    },
    author: { login: VIEWER.login, id: VIEWER.id },
    committer: { login: VIEWER.login, id: VIEWER.id },
    parents: (view?.parents ?? []).map((sha) => ({ sha })),
  };
}

/** Create a commit on a branch from a flat tree map; returns the commit oid. */
export function commitTree(
  store: Store,
  repo: RepoRec,
  branch: string,
  treeOid: string,
  message: string,
  parents: readonly string[],
): string {
  const stamp = store.tick();
  const ident = store.ident(stamp.epochSec);
  const commit = buildCommit({ tree: treeOid, parents, message, author: ident, committer: ident });
  const oid = putObject(repo, 'commit', commit);
  repo.refs.set(`refs/heads/${branch}`, oid);
  return oid;
}

function shortBranch(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

function stripOwnerPrefix(ref: string, owner: string): string {
  const at = ref.indexOf(':');
  if (at > 0) {
    const maybeOwner = ref.slice(0, at);
    if (maybeOwner === owner) return ref.slice(at + 1);
  }
  return ref;
}

// --------------------------------------------------------------------------------------------
// the router
// --------------------------------------------------------------------------------------------

export function routeRest(store: Store, req: RestRequest): RestReply {
  const seg = req.segments;
  const method = req.method;

  // API root.
  if (seg.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  if (seg[0] === 'meta' && seg.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, { installed_version: '1.0.0' });
  }

  if (seg[0] === 'user' && seg.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, userJson());
  }

  if (seg[0] === 'user' && seg[1] === 'repos' && seg.length === 2) {
    if (method === 'GET') {
      const { page, headers } = paginate(store.repoOrder, req, '/api/v3/user/repos');
      return ok(200, page.map(repoJson), headers);
    }
    if (method === 'POST') {
      const body = bodyObject(req);
      if (body === null) return err(400, req.bodyMalformed ? 'malformed JSON body' : 'request body must be a JSON object');
      const name = asString(body.name);
      if (name === null || name === '' || name.includes('/')) return err(422, 'name is required');
      if (store.getRepo(VIEWER.login, name) !== undefined) return err(422, `Repository ${name} already exists`);
      const repo = store.createRepo(name, body.private === true, asString(body.description) ?? '');
      return ok(201, repoJson(repo));
    }
    return err(404, 'Not Found');
  }

  if (seg[0] !== 'repos' || seg.length < 3) return err(404, 'Not Found');
  const owner = seg[1] as string;
  const repoName = seg[2] as string;
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return err(404, 'Not Found');
  const rest = seg.slice(3);
  const repoPath = `/api/v3/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`;

  // /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') return ok(200, repoJson(repo));
    if (method === 'PATCH') {
      const body = bodyObject(req);
      if (body === null) return err(400, req.bodyMalformed ? 'malformed JSON body' : 'request body must be a JSON object');
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      repo.updatedAt = store.tick().iso;
      return ok(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo);
      return { status: 204, json: null, empty: true };
    }
    return err(404, 'Not Found');
  }

  const head = rest[0] as string;

  // Branches.
  if (head === 'branches') {
    if (rest.length === 1) {
      if (method !== 'GET') return err(404, 'Not Found');
      const names = [...repo.refs.keys()].filter((name) => name.startsWith('refs/heads/')).sort();
      return ok(200, names.map((name) => ({ name: name.slice('refs/heads/'.length), commit: { sha: repo.refs.get(name) }, protected: false })));
    }
    if (method !== 'GET') return err(404, 'Not Found');
    const branch = rest.slice(1).join('/');
    const oid = repo.refs.get(`refs/heads/${branch}`);
    if (oid === undefined) return err(404, 'Branch not found');
    return ok(200, { name: branch, commit: { sha: oid }, protected: false });
  }

  // Commits.
  if (head === 'commits' && rest.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    const refish = req.query.get('sha') ?? repo.defaultBranch;
    const tip = resolveRef(repo, refish);
    if (tip === null) {
      // An unborn default branch lists no commits; an unknown ref is a 404.
      const known = repo.refs.has(`refs/heads/${refish}`) || repo.refs.has(refish);
      if (!known && refish !== repo.defaultBranch) return err(404, 'Not Found');
      return ok(200, []);
    }
    const history = commitHistory(repo, tip);
    const { page, headers } = paginate(history, req, `${repoPath}/commits`);
    return ok(200, page.map((oid) => commitJson(repo, oid)), headers);
  }

  // Contents.
  if (head === 'contents') {
    return routeContents(store, repo, req, rest.slice(1));
  }

  // Git data: refs.
  if (head === 'git' && rest[1] === 'refs') {
    if (rest.length === 2) {
      if (method !== 'POST') return err(404, 'Not Found');
      const body = bodyObject(req);
      if (body === null) return err(400, req.bodyMalformed ? 'malformed JSON body' : 'request body must be a JSON object');
      const ref = asString(body.ref);
      const sha = asString(body.sha);
      if (ref === null || !ref.startsWith('refs/') || sha === null || !isOid(sha)) return err(422, 'ref and sha are required');
      if (!repo.objects.has(sha)) return err(422, 'sha does not name an object in this repository');
      if (repo.refs.has(ref)) return err(422, `Reference ${ref} already exists`);
      repo.refs.set(ref, sha);
      return ok(201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
    }
    if (method !== 'GET') return err(404, 'Not Found');
    const wanted = `refs/${rest.slice(2).join('/')}`;
    const exact = repo.refs.get(wanted);
    if (exact !== undefined) {
      return ok(200, { ref: wanted, object: { sha: exact, type: repo.objects.get(exact)?.type ?? 'commit' } });
    }
    const matches = [...repo.refs.entries()]
      .filter(([name]) => name.startsWith(`${wanted}/`) || name === wanted)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1));
    if (matches.length === 0) return err(404, 'Not Found');
    return ok(200, matches.map(([name, sha]) => ({ ref: name, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } })));
  }

  // Labels.
  if (head === 'labels' && rest.length === 1) {
    if (method === 'GET') return ok(200, [...repo.labels.values()].map((label) => ({ ...label, description: '' })));
    if (method === 'POST') {
      const body = bodyObject(req);
      if (body === null) return err(400, req.bodyMalformed ? 'malformed JSON body' : 'request body must be a JSON object');
      const name = asString(body.name);
      if (name === null || name === '') return err(422, 'name is required');
      const color = asString(body.color) ?? 'ededed';
      const existing = repo.labels.get(name);
      if (existing !== undefined) return ok(201, { name, color: existing.color, description: '' });
      repo.labels.set(name, { name, color });
      return ok(201, { name, color, description: '' });
    }
    return err(404, 'Not Found');
  }

  // Issues.
  if (head === 'issues') {
    return routeIssues(store, repo, req, rest.slice(1), repoPath);
  }

  // Pull requests.
  if (head === 'pulls') {
    return routePulls(store, repo, req, rest.slice(1), repoPath);
  }

  return err(404, 'Not Found');
}

// --------------------------------------------------------------------------------------------
// contents
// --------------------------------------------------------------------------------------------

function routeContents(store: Store, repo: RepoRec, req: RestRequest, parts: string[]): RestReply {
  const path = parts.join('/');
  if (path === '' || parts.some((part) => part === '..' || part === '')) {
    if (req.method === 'GET' && path === '') {
      // The repository root lists like a directory.
      return contentsGet(repo, '', req);
    }
    return err(422, 'invalid path');
  }
  if (req.method === 'GET') return contentsGet(repo, path, req);
  if (req.method === 'PUT') return contentsPut(store, repo, path, req);
  if (req.method === 'DELETE') return contentsDelete(store, repo, path, req);
  return err(404, 'Not Found');
}

function contentsGet(repo: RepoRec, path: string, req: RestRequest): RestReply {
  const refish = req.query.get('ref') ?? repo.defaultBranch;
  const tip = resolveRef(repo, refish);
  if (tip === null) return err(404, 'Not Found');
  const view = commitOf(repo, tip);
  if (view === null) return err(404, 'Not Found');
  const found = lookupPath(repo, view.tree, path);
  if (found === null) return err(404, 'Not Found');
  if (found.kind === 'file') {
    const object = repo.objects.get(found.entry.oid);
    if (object === undefined) return err(404, 'Not Found');
    const name = path.split('/').pop() as string;
    return ok(200, {
      type: 'file',
      name,
      path,
      sha: found.entry.oid,
      size: object.data.length,
      encoding: 'base64',
      content: object.data.toString('base64'),
    });
  }
  const entries = found.entries.map((entry) => {
    const childPath = path === '' ? entry.name : `${path}/${entry.name}`;
    const size = entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0);
    return { type: entry.mode === '40000' ? 'dir' : 'file', name: entry.name, path: childPath, sha: entry.oid, size };
  });
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  return ok(200, entries);
}

function contentsBranchTip(repo: RepoRec, branch: string): { tip: string | null; base: string | null } {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip !== undefined) return { tip: peelToCommit(repo, tip), base: tip };
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (defaultTip !== undefined) return { tip: null, base: peelToCommit(repo, defaultTip) };
  return { tip: null, base: null };
}

function contentsPut(store: Store, repo: RepoRec, path: string, req: RestRequest): RestReply {
  const body = bodyObject(req);
  if (body === null) return err(400, req.bodyMalformed ? 'malformed JSON body' : 'request body must be a JSON object');
  const message = asString(body.message);
  const content = asString(body.content);
  if (message === null || message === '') return err(422, 'message is required');
  if (content === null) return err(422, 'content is required');
  const branch = shortBranch(asString(body.branch) ?? repo.defaultBranch);
  const { tip, base } = contentsBranchTip(repo, branch);
  const parent = tip ?? base;
  const parentView = parent !== null ? commitOf(repo, parent) : null;
  const flat = parentView !== null ? flattenTree(repo, parentView.tree) : new Map();
  const existing = flat.get(path);
  const sha = asString(body.sha);
  if (existing !== undefined) {
    if (sha === null || sha.toLowerCase() !== existing.oid.toLowerCase()) {
      return err(409, 'sha does not match the current file');
    }
  }
  const bytes = Buffer.from(content, 'base64');
  const blobOid = putObject(repo, 'blob', bytes);
  flat.set(path, { oid: blobOid, mode: existing?.mode ?? '100644' });
  const treeOid = buildTreeFromMap(repo, flat);
  // A branch that already exists commits on its own tip; a new branch forks from the
  // default tip; an unborn repository's first commit has no parent.
  const commitParents = repo.refs.has(`refs/heads/${branch}`) ? (tip !== null ? [tip] : []) : base !== null ? [base] : [];
  const commitOid = commitTree(store, repo, branch, treeOid, message, commitParents);
  const name = path.split('/').pop() as string;
  return ok(existing !== undefined ? 200 : 201, {
    content: { name, path, sha: blobOid, size: bytes.length, type: 'file', encoding: 'base64', content: bytes.toString('base64') },
    commit: { sha: commitOid, message },
  });
}

function contentsDelete(store: Store, repo: RepoRec, path: string, req: RestRequest): RestReply {
  const body = bodyObject(req);
  if (body === null) return err(400, req.bodyMalformed ? 'malformed JSON body' : 'request body must be a JSON object');
  const message = asString(body.message);
  const sha = asString(body.sha);
  if (message === null || message === '') return err(422, 'message is required');
  if (sha === null) return err(422, 'sha is required');
  const branch = shortBranch(asString(body.branch) ?? repo.defaultBranch);
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const commit = tip !== undefined ? peelToCommit(repo, tip) : null;
  const view = commit !== null ? commitOf(repo, commit) : null;
  if (view === null) return err(404, 'Not Found');
  const flat = flattenTree(repo, view.tree);
  const existing = flat.get(path);
  if (existing === undefined) return err(404, 'Not Found');
  if (sha.toLowerCase() !== existing.oid.toLowerCase()) return err(409, 'sha does not match the current file');
  flat.delete(path);
  const treeOid = buildTreeFromMap(repo, flat);
  const commitOid = commitTree(store, repo, branch, treeOid, message, [commit]);
  return ok(200, { commit: { sha: commitOid, message }, content: null });
}

// --------------------------------------------------------------------------------------------
// issues
// --------------------------------------------------------------------------------------------

function parseLabels(body: Record<string, unknown>): string[] | null {
  const raw = body.labels;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const names: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') names.push(entry);
    else if (isRecord(entry) && typeof entry.name === 'string') names.push(entry.name);
    else return null;
  }
  return names;
}

export function createIssueRecord(
  store: Store,
  repo: RepoRec,
  title: string,
  body: string,
  labels: string[],
): IssueRec {
  const stamp = store.tick();
  const issue: IssueRec = {
    number: repo.nextNumber++,
    id: store.nextId(),
    title,
    body,
    state: 'open',
    labels: [...labels],
    seq: stamp.seq,
    createdAt: stamp.iso,
    updatedAt: stamp.iso,
    closedAt: null,
    comments: [],
  };
  repo.issues.set(issue.number, issue);
  return issue;
}

function routeIssues(store: Store, repo: RepoRec, req: RestRequest, parts: string[], repoPath: string): RestReply {
  if (parts.length === 0) {
    if (req.method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const direction = req.query.get('direction') ?? 'desc';
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((issue) => issue.state === state);
      list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      const { page, headers } = paginate(list, req, `${repoPath}/issues`);
      return ok(200, page.map((issue) => issueJson(repo, issue)), headers);
    }
    if (req.method === 'POST') {
      const body = bodyObject(req);
      if (body === null) return err(400, req.bodyMalformed ? 'malformed JSON body' : 'request body must be a JSON object');
      const title = asString(body.title);
      if (title === null || title === '') return err(422, 'title is required');
      const labels = parseLabels(body);
      if (labels === null) return err(422, 'labels must be an array of names');
      for (const name of labels) {
        if (!repo.labels.has(name)) return err(422, `label ${name} does not exist`);
      }
      const issue = createIssueRecord(store, repo, title, asString(body.body) ?? '', labels);
      return ok(201, issueJson(repo, issue));
    }
    return err(404, 'Not Found');
  }
  const number = Number(parts[0]);
  if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
  const issue = repo.issues.get(number);
  if (issue === undefined) return err(404, 'Not Found');
  if (parts.length === 1) {
    if (req.method === 'GET') return ok(200, issueJson(repo, issue));
    if (req.method === 'PATCH') {
      const body = bodyObject(req);
      if (body === null) return err(400, req.bodyMalformed ? 'malformed JSON body' : 'request body must be a JSON object');
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.labels !== undefined) {
        const labels = parseLabels(body);
        if (labels === null) return err(422, 'labels must be an array of names');
        for (const name of labels) {
          if (!repo.labels.has(name)) return err(422, `label ${name} does not exist`);
        }
        issue.labels = labels;
      }
      if (body.state === 'open' || body.state === 'closed') {
        issue.state = body.state;
        issue.closedAt = body.state === 'closed' ? store.tick().iso : null;
      }
      issue.updatedAt = store.tick().iso;
      return ok(200, issueJson(repo, issue));
    }
    return err(404, 'Not Found');
  }
  if (parts[1] === 'comments' && parts.length === 2) {
    if (req.method === 'GET') return ok(200, issue.comments.map(commentJson));
    if (req.method === 'POST') {
      const body = bodyObject(req);
      if (body === null) return err(400, req.bodyMalformed ? 'malformed JSON body' : 'request body must be a JSON object');
      const text = asString(body.body);
      if (text === null) return err(422, 'body is required');
      const stamp = store.tick();
      const comment = { id: store.nextComment(), body: text, seq: stamp.seq, createdAt: stamp.iso, updatedAt: stamp.iso };
      issue.comments.push(comment);
      return ok(201, commentJson(comment));
    }
    return err(404, 'Not Found');
  }
  return err(404, 'Not Found');
}

// --------------------------------------------------------------------------------------------
// pull requests
// --------------------------------------------------------------------------------------------

export function createPullRecord(
  store: Store,
  repo: RepoRec,
  title: string,
  body: string,
  head: string,
  base: string,
): PullRec {
  const stamp = store.tick();
  const pull: PullRec = {
    number: repo.nextNumber++,
    id: store.nextId(),
    title,
    body,
    state: 'open',
    head,
    base,
    seq: stamp.seq,
    createdAt: stamp.iso,
    updatedAt: stamp.iso,
    closedAt: null,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
  };
  repo.pulls.set(pull.number, pull);
  return pull;
}

function routePulls(store: Store, repo: RepoRec, req: RestRequest, parts: string[], repoPath: string): RestReply {
  if (parts.length === 0) {
    if (req.method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state !== 'all') list = list.filter((pull) => pull.state === state);
      list.sort((a, b) => b.seq - a.seq);
      const { page, headers } = paginate(list, req, `${repoPath}/pulls`);
      return ok(200, page.map((pull) => pullJson(repo, pull)), headers);
    }
    if (req.method === 'POST') {
      const body = bodyObject(req);
      if (body === null) return err(400, req.bodyMalformed ? 'malformed JSON body' : 'request body must be a JSON object');
      const title = asString(body.title);
      const headRaw = asString(body.head);
      const baseRaw = asString(body.base);
      if (title === null || title === '') return err(422, 'title is required');
      if (headRaw === null || baseRaw === null) return err(422, 'head and base are required');
      const head = shortBranch(stripOwnerPrefix(headRaw, repo.owner));
      const base = shortBranch(stripOwnerPrefix(baseRaw, repo.owner));
      if (repo.refs.get(`refs/heads/${head}`) === undefined) return err(422, `head branch ${head} does not exist`);
      if (repo.refs.get(`refs/heads/${base}`) === undefined) return err(422, `base branch ${base} does not exist`);
      for (const pull of repo.pulls.values()) {
        if (pull.state === 'open' && pull.head === head && pull.base === base) {
          return err(422, 'a pull request is already open for this head and base');
        }
      }
      const pull = createPullRecord(store, repo, title, asString(body.body) ?? '', head, base);
      return ok(201, pullJson(repo, pull));
    }
    return err(404, 'Not Found');
  }
  const number = Number(parts[0]);
  if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
  const pull = repo.pulls.get(number);
  if (pull === undefined) return err(404, 'Not Found');
  if (parts.length === 1) {
    if (req.method === 'GET') return ok(200, pullJson(repo, pull));
    return err(404, 'Not Found');
  }
  if (parts[1] === 'files' && parts.length === 2) {
    if (req.method !== 'GET') return err(404, 'Not Found');
    const files = pullFiles(repo, pull);
    if (files === null) return err(404, 'Not Found');
    return ok(200, files);
  }
  if (parts[1] === 'merge' && parts.length === 2) {
    if (req.method !== 'PUT') return err(404, 'Not Found');
    return mergePull(store, repo, pull, req);
  }
  return err(404, 'Not Found');
}

export function pullFiles(repo: RepoRec, pull: PullRec): Array<Record<string, unknown>> | null {
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  if (baseTip === undefined || headTip === undefined) return null;
  const baseCommit = peelToCommit(repo, baseTip);
  const headCommit = peelToCommit(repo, headTip);
  if (baseCommit === null || headCommit === null) return null;
  const base = mergeBase(repo, baseCommit, headCommit);
  const headView = commitOf(repo, headCommit);
  if (headView === null) return null;
  const oldMap = base === null ? new Map() : flattenTree(repo, (commitOf(repo, base) as { tree: string }).tree);
  const newMap = flattenTree(repo, headView.tree);
  const diffs = diffFlatMaps(oldMap, newMap);
  return diffs.map((diff) => {
    const oldData = diff.oldOid !== null ? (repo.objects.get(diff.oldOid)?.data ?? null) : null;
    const newData = diff.newOid !== null ? (repo.objects.get(diff.newOid)?.data ?? null) : null;
    const counts = lineCounts(oldData, newData);
    return {
      filename: diff.path,
      status: diff.status,
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
      sha: diff.newOid ?? diff.oldOid,
    };
  });
}

export function mergePull(store: Store, repo: RepoRec, pull: PullRec, req?: RestRequest): RestReply {
  if (pull.state !== 'open' || pull.merged) return err(405, 'pull request is not open');
  const plan = mergePlan(repo, pull);
  if (plan === null) return err(405, 'pull request cannot be merged');
  if (plan.conflicts.length > 0) return err(405, `merge conflict in ${plan.conflicts.join(', ')}`);
  let method = 'squash';
  if (req !== undefined) {
    const body = bodyObject(req);
    if (body !== null && typeof body.merge_method === 'string') method = body.merge_method;
  }
  const parents = method === 'merge' ? [plan.baseTip, plan.headTip] : [plan.baseTip];
  const commitOid = commitTree(store, repo, pull.base, plan.mergedTree, pull.title, parents);
  const stamp = store.tick();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = stamp.iso;
  pull.mergeCommitSha = commitOid;
  pull.closedAt = stamp.iso;
  pull.updatedAt = stamp.iso;
  return ok(200, { merged: true, sha: commitOid, message: `Pull request #${pull.number} successfully merged` });
}
