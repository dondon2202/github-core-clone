// Git objects, packfiles and history walks: the whole object layer the smart-HTTP server
// and the REST contents/merge paths share. SHA-1 over `<type> <size>\0<bytes>`, zlib via
// node:zlib, no git binary. Written from the pack and object formats as the suite's own
// client exercises them; no deltas are ever emitted, but pushed packs with deltas resolve.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { CommitView, GitObjectRec, ObjectType, RepoRec, TagView, TreeEntry } from './store.ts';

export const ZERO_OID = '0'.repeat(40);

const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitError';
  }
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

export function hashObject(type: ObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export function putObject(repo: RepoRec, type: ObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isOid(tree)) throw new GitError('commit has no valid tree header');
  return { tree, parents, author, committer, message };
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new GitError('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new GitError('tree entry is truncated');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new GitError('tag header has no value');
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isOid(object)) throw new GitError('tag has no valid object header');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new GitError('tag has a bad type');
  }
  return {
    object,
    type: type as ObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`, `committer ${fields.committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

/** The parsed commit for `oid`, cached on the repo. Null when absent or not a commit. */
export function commitOf(repo: RepoRec, oid: string): CommitView | null {
  const cached = repo.commitCache.get(oid);
  if (cached !== undefined) return cached;
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return null;
  try {
    const view = parseCommit(object.data);
    repo.commitCache.set(oid, view);
    return view;
  } catch {
    return null;
  }
}

export function treeOf(repo: RepoRec, oid: string): TreeEntry[] | null {
  const cached = repo.treeCache.get(oid);
  if (cached !== undefined) return cached;
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'tree') return null;
  try {
    const entries = parseTree(object.data);
    repo.treeCache.set(oid, entries);
    return entries;
  } catch {
    return null;
  }
}

/** Peel tags to the commit they name (or null when the chain leaves commits). */
export function peelToCommit(repo: RepoRec, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 32; hops += 1) {
    const object = repo.objects.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    try {
      current = parseTag(object.data).object;
    } catch {
      return null;
    }
  }
  return null;
}

/** True when `ancestor` is reachable from `descendant` through parent links (or equal). */
export function isAncestor(repo: RepoRec, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = commitOf(repo, oid);
    if (commit === null) continue;
    for (const parent of commit.parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** A merge base of two commits: the first common ancestor found walking from `b`. */
export function mergeBase(repo: RepoRec, a: string, b: string): string | null {
  const ancestors = new Set<string>();
  const queue = [a];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (ancestors.has(oid)) continue;
    ancestors.add(oid);
    const commit = commitOf(repo, oid);
    if (commit === null) continue;
    for (const parent of commit.parents) queue.push(parent);
  }
  const seen = new Set<string>();
  const walk = [b];
  while (walk.length > 0) {
    const oid = walk.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestors.has(oid)) return oid;
    const commit = commitOf(repo, oid);
    if (commit === null) continue;
    for (const parent of commit.parents) walk.push(parent);
  }
  return null;
}

/** History from a tip, newest first, following every parent, deduplicated. */
export function commitHistory(repo: RepoRec, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = commitOf(repo, oid);
    if (commit === null) continue;
    out.push(oid);
    for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i] as string);
  }
  return out;
}

// --------------------------------------------------------------------------------------------
// packfiles
// --------------------------------------------------------------------------------------------

function readPackSizeHeader(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new GitError('pack entry has no size header');
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new GitError('pack entry size varint is truncated');
    byte = buffer[offset] as number;
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new GitError('ofs-delta has no base offset');
  let byte = buffer[start] as number;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new GitError('ofs-delta base offset is truncated');
    byte = buffer[offset] as number;
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past it. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: Buffer;
  let consumed: number;
  try {
    const out = inflateSync(view, { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    result = out.buffer;
    consumed = out.engine.bytesWritten;
  } catch (err) {
    throw new GitError(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  if (!consumed || consumed <= 0) throw new GitError(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result, next: offset + consumed };
}

/** Apply a git delta instruction stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new GitError('delta size varint is truncated');
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new GitError('delta expects a different base size');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new GitError('delta copy offset is truncated');
          copyOffset += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new GitError('delta copy size is truncated');
          copySize += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new GitError('delta copy is out of the base');
      if (written + copySize > targetSize) throw new GitError('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new GitError('delta insert is truncated');
      if (written + literal > targetSize) throw new GitError('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new GitError('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new GitError('delta produced the wrong size');
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  resolvedType?: ObjectType;
  resolved?: Buffer;
  oid?: string;
}

/** Read a packfile (version 2 or 3), resolving OFS/REF deltas. Thin-pack bases come from `resolveBase`. */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObjectRec | undefined): Map<string, GitObjectRec> {
  if (pack.length < 32) throw new GitError('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new GitError('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new GitError(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new GitError('pack trailer checksum mismatch');

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readPackSizeHeader(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) throw new GitError('ofs-delta names an invalid base offset');
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new GitError('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (CODE_TYPE[typeCode] === undefined) {
      throw new GitError(`pack entry has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new GitError('pack entry size mismatch after inflate');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new GitError('pack has stray bytes before its trailer');

  const objects = new Map<string, GitObjectRec>();
  const resolvedByOid = new Map<string, RawPackEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): { type: ObjectType; data: Buffer; oid: string } => {
    if (entry.resolved !== undefined && entry.resolvedType !== undefined && entry.oid !== undefined) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new GitError('delta cycle in pack');
    resolving.add(entry.offset);
    let type: ObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (baseEntry === undefined) throw new GitError('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry !== undefined) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (external === undefined) throw new GitError('ref-delta base is neither in the pack nor supplied');
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode] as ObjectType;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

function packObjectHeader(type: ObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects, no deltas. Order is the caller's. */
export function writePack(objects: Iterable<GitObjectRec>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// --------------------------------------------------------------------------------------------
// fetch selection
// --------------------------------------------------------------------------------------------

export interface FetchSelection {
  objects: Map<string, GitObjectRec>;
  shallow: string[];
  unshallow: string[];
}

/**
 * The objects a fetch must carry: everything reachable from `wants` (commits limited to
 * depths 0..depthCutoff-1 when a limit is set), minus everything reachable from `haves`.
 * Held commits stop the walk, except a shallow boundary being deepened. `oldShallow` holds
 * the client's current shallow boundary; commits there whose parents this fetch completes
 * are reported unshallow, and commits at the depth boundary are reported shallow.
 */
export function selectFetchObjects(
  repo: RepoRec,
  wants: readonly string[],
  haves: readonly string[],
  depthCutoff: number | null,
  oldShallow: readonly string[],
): FetchSelection {
  const oldShallowSet = new Set(oldShallow);
  // Everything the client already holds: the closure of the haves, except that the walk
  // stops at a shallow boundary — the client holds the boundary commit and its tree, but
  // not the history below it, which is exactly what a deepen fetch extends into.
  const held = new Set<string>();
  {
    const queue = [...haves];
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (held.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      held.add(oid);
      if (object.type === 'commit') {
        const commit = commitOf(repo, oid);
        if (commit !== null) {
          queue.push(commit.tree);
          if (!oldShallowSet.has(oid)) {
            for (const parent of commit.parents) queue.push(parent);
          }
        }
      } else if (object.type === 'tag') {
        try {
          queue.push(parseTag(object.data).object);
        } catch {
          // a malformed tag names nothing further
        }
      } else if (object.type === 'tree') {
        const entries = treeOf(repo, oid);
        if (entries !== null) for (const entry of entries) if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }

  const included = new Set<string>();
  const shallowSet = new Set<string>();
  const commitDepth = new Map<string, number>();
  // BFS over commits from the wants, tracking the shallowest depth each is seen at.
  // Non-commit wants (tags, trees, blobs) join the same queue and fan out from there.
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const want of wants) queue.push({ oid: want, depth: 0 });
  let head = 0;
  const includeTreeClosure = (treeOid: string): void => {
    const treeQueue = [treeOid];
    while (treeQueue.length > 0) {
      const oid = treeQueue.pop() as string;
      if (included.has(oid) || held.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      included.add(oid);
      if (object.type !== 'tree') continue;
      const entries = treeOf(repo, oid);
      if (entries !== null) {
        for (const entry of entries) {
          if (entry.mode !== '160000') treeQueue.push(entry.oid);
        }
      }
    }
  };
  while (head < queue.length) {
    const { oid, depth } = queue[head] as { oid: string; depth: number };
    head += 1;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    if (object.type === 'commit') {
      // A depth limit counts commits from the wants: depth D includes depths 0..D-1.
      if (depthCutoff !== null && depth >= depthCutoff) continue;
      const prev = commitDepth.get(oid);
      if (prev !== undefined && prev <= depth) continue;
      commitDepth.set(oid, depth);
      if (held.has(oid)) {
        // Held commits stop the walk — except a shallow boundary being deepened, whose
        // parents the client does not have and this fetch extends toward.
        if (depthCutoff !== null && oldShallowSet.has(oid)) {
          const commit = commitOf(repo, oid);
          if (commit !== null) for (const parent of commit.parents) queue.push({ oid: parent, depth: depth + 1 });
        }
        continue;
      }
      included.add(oid);
      const commit = commitOf(repo, oid);
      if (commit === null) continue;
      includeTreeClosure(commit.tree);
      const atBoundary = depthCutoff !== null && depth >= depthCutoff - 1;
      if (atBoundary) {
        if (commit.parents.length > 0) shallowSet.add(oid);
        continue;
      }
      for (const parent of commit.parents) queue.push({ oid: parent, depth: depth + 1 });
    } else if (object.type === 'tag') {
      if (held.has(oid) || included.has(oid)) continue;
      included.add(oid);
      try {
        queue.push({ oid: parseTag(object.data).object, depth });
      } catch {
        // malformed tag: nothing further
      }
    } else {
      if (object.type === 'tree') includeTreeClosure(oid);
      else if (!held.has(oid)) included.add(oid);
    }
  }

  // Boundary commits the client already held are not shallow: it has their parents or the
  // boundary is unchanged. Commits cut by depth whose parents the client holds are not
  // shallow either (the client can already walk past them).
  const shallow: string[] = [];
  for (const oid of shallowSet) {
    if (held.has(oid)) continue;
    const commit = commitOf(repo, oid);
    if (commit === null) continue;
    const cutParents = commit.parents.filter((p) => !included.has(p) && !held.has(p));
    if (cutParents.length > 0) shallow.push(oid);
  }

  // Unshallow: an old boundary commit in this fetch's graph is complete when every
  // parent is now included or held.
  const unshallow: string[] = [];
  for (const oid of oldShallow) {
    if (!commitDepth.has(oid)) continue;
    const commit = commitOf(repo, oid);
    if (commit === null) continue;
    if (commit.parents.length === 0) {
      if (wants.includes(oid)) unshallow.push(oid);
      continue;
    }
    const complete = commit.parents.every((p) => included.has(p) || held.has(p));
    if (complete) unshallow.push(oid);
  }

  const objects = new Map<string, GitObjectRec>();
  for (const oid of included) {
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.set(oid, object);
  }
  return { objects, shallow: [...shallow].sort(), unshallow: [...unshallow].sort() };
}

// --------------------------------------------------------------------------------------------
// trees as flat maps, diffs and merges
// --------------------------------------------------------------------------------------------

export interface FlatEntry {
  oid: string;
  mode: string;
}

/** Flatten a tree (recursively) to path -> entry. */
export function flattenTree(repo: RepoRec, treeOid: string): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  const walk = (oid: string, prefix: string): void => {
    const entries = treeOf(repo, oid);
    if (entries === null) return;
    for (const entry of entries) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** Build nested trees from a flat map, storing every tree object; returns the root tree oid. */
export function buildTreeFromMap(repo: RepoRec, flat: ReadonlyMap<string, FlatEntry>): string {
  interface Node {
    files: Map<string, FlatEntry>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i] as string;
      let child = node.dirs.get(part);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1] as string, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** Look one path up in a tree; returns the blob entry or the directory's entries. */
export function lookupPath(
  repo: RepoRec,
  treeOid: string,
  path: string,
): { kind: 'file'; entry: FlatEntry } | { kind: 'dir'; entries: TreeEntry[] } | null {
  const parts = path.split('/').filter((part) => part !== '');
  if (parts.length === 0) {
    const entries = treeOf(repo, treeOid);
    return entries === null ? null : { kind: 'dir', entries };
  }
  let current = treeOid;
  for (let i = 0; i < parts.length; i += 1) {
    const entries = treeOf(repo, current);
    if (entries === null) return null;
    const found = entries.find((entry) => entry.name === parts[i]);
    if (found === undefined) return null;
    if (i === parts.length - 1) {
      if (found.mode === '40000') {
        const children = treeOf(repo, found.oid);
        return children === null ? null : { kind: 'dir', entries: children };
      }
      return { kind: 'file', entry: { oid: found.oid, mode: found.mode } };
    }
    if (found.mode !== '40000') return null;
    current = found.oid;
  }
  return null;
}

export interface DiffEntry {
  path: string;
  status: 'added' | 'removed' | 'modified';
  oldOid: string | null;
  newOid: string | null;
}

export function diffFlatMaps(
  oldMap: ReadonlyMap<string, FlatEntry>,
  newMap: ReadonlyMap<string, FlatEntry>,
): DiffEntry[] {
  const paths = new Set<string>([...oldMap.keys(), ...newMap.keys()]);
  const out: DiffEntry[] = [];
  for (const path of paths) {
    const oldEntry = oldMap.get(path);
    const newEntry = newMap.get(path);
    if (oldEntry === undefined && newEntry !== undefined) {
      out.push({ path, status: 'added', oldOid: null, newOid: newEntry.oid });
    } else if (oldEntry !== undefined && newEntry === undefined) {
      out.push({ path, status: 'removed', oldOid: oldEntry.oid, newOid: null });
    } else if (oldEntry !== undefined && newEntry !== undefined && (oldEntry.oid !== newEntry.oid || oldEntry.mode !== newEntry.mode)) {
      out.push({ path, status: 'modified', oldOid: oldEntry.oid, newOid: newEntry.oid });
    }
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

function splitLines(data: Buffer): string[] {
  const text = data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line additions/deletions between two blob versions, via LCS (capped for large files). */
export function lineCounts(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  if (oldData === null && newData === null) return { additions: 0, deletions: 0 };
  if (oldData === null) return { additions: splitLines(newData as Buffer).length, deletions: 0 };
  if (newData === null) return { additions: 0, deletions: splitLines(oldData).length };
  const a = splitLines(oldData);
  const b = splitLines(newData);
  if (a.length * b.length > 400_000) {
    // Too large for the quadratic table: count whole-file churn instead.
    return { additions: b.length, deletions: a.length };
  }
  // LCS lengths, two rows.
  let prev = new Array<number>(b.length + 1).fill(0);
  let curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = 0;
    for (let j = 1; j <= b.length; j += 1) {
      curr[j] = a[i - 1] === b[j - 1] ? (prev[j - 1] as number) + 1 : Math.max(prev[j] as number, curr[j - 1] as number);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  const lcs = prev[b.length] as number;
  return { additions: b.length - lcs, deletions: a.length - lcs };
}

export interface MergeOutcome {
  merged: Map<string, FlatEntry>;
  conflicts: string[];
}

/** Three-way merge of flat trees: base, ours, theirs. A path both sides changed differently conflicts. */
export function threeWayMerge(
  base: ReadonlyMap<string, FlatEntry>,
  ours: ReadonlyMap<string, FlatEntry>,
  theirs: ReadonlyMap<string, FlatEntry>,
): MergeOutcome {
  const same = (x: FlatEntry | undefined, y: FlatEntry | undefined): boolean =>
    x === undefined ? y === undefined : y !== undefined && x.oid === y.oid && x.mode === y.mode;
  const merged = new Map<string, FlatEntry>();
  const conflicts: string[] = [];
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    if (same(o, t)) {
      if (o !== undefined) merged.set(path, o);
    } else if (same(o, b)) {
      if (t !== undefined) merged.set(path, t);
    } else if (same(t, b)) {
      if (o !== undefined) merged.set(path, o);
    } else {
      conflicts.push(path);
    }
  }
  conflicts.sort();
  return { merged, conflicts };
}
