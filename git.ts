// The git object model in pure Node (node:crypto for SHA-1, node:zlib for pack compression):
// object hashing, commit/tree/tag parsing and formatting, tree path surgery for the contents
// API, ancestry walks, packfile reading (push) and writing (fetch). No git binary anywhere —
// the rules forbid shelling out, and an in-memory object map keeps the timed workloads fast.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObjectRec, GitObjectType, ParsedCommit, RepoRec } from './store.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const OID_RE = /^[0-9a-f]{40}$/;

export function isOid(value: string): boolean {
  return OID_RE.test(value);
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

// ---------------------------------------------------------------------------------------------
// pkt-line framing

export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export interface PktPacket {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/** Parse a whole buffer of pkt-lines; throws on a malformed length prefix. */
export function parsePktLines(buffer: Buffer, offset = 0): { packets: PktPacket[]; end: number } {
  const packets: PktPacket[] = [];
  let pos = offset;
  while (pos < buffer.length) {
    if (pos + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const header = buffer.subarray(pos, pos + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`bad pkt-line header ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      pos += 4;
      break;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (length < 4 || pos + length > buffer.length) throw new Error('truncated pkt-line payload');
    packets.push({ kind: 'data', payload: buffer.subarray(pos + 4, pos + length) });
    pos += length;
  }
  return { packets, end: pos };
}

// ---------------------------------------------------------------------------------------------
// Objects

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export function writeObject(repo: RepoRec, type: GitObjectType, data: Buffer): string {
  const sha = hashObject(type, data);
  if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
  return sha;
}

export function readObject(repo: RepoRec, sha: string): GitObjectRec | null {
  return repo.objects.get(sha) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Commits

interface IdentityParts {
  name: string;
  email: string;
  time: number;
  tz: string;
}

function parseIdentity(text: string): IdentityParts {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(text);
  if (match === null) return { name: text, email: '', time: 0, tz: '+0000' };
  return { name: match[1]!, email: match[2]!, time: Number(match[3]), tz: match[4]! };
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const headerText = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = ZERO_OID;
  const parents: string[] = [];
  let author: IdentityParts = { name: '', email: '', time: 0, tz: '+0000' };
  let committer: IdentityParts = { name: '', email: '', time: 0, tz: '+0000' };
  let lastKey = '';
  for (const line of headerText.split('\n')) {
    if (line.startsWith(' ')) continue; // a header continuation (gpgsig, mergetag bodies)
    const space = line.indexOf(' ');
    if (space === -1) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    lastKey = key;
    if (key === 'tree') tree = value.trim();
    else if (key === 'parent') parents.push(value.trim());
    else if (key === 'author') author = parseIdentity(value);
    else if (key === 'committer') committer = parseIdentity(value);
    void lastKey;
  }
  return {
    tree,
    parents,
    authorName: author.name,
    authorEmail: author.email,
    authorTime: author.time,
    committerName: committer.name,
    committerEmail: committer.email,
    committerTime: committer.time,
    message,
  };
}

export function getCommit(repo: RepoRec, sha: string): ParsedCommit | null {
  const cached = repo.commitCache.get(sha);
  if (cached !== undefined) return cached;
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'commit') return null;
  const parsed = parseCommit(object.data);
  repo.commitCache.set(sha, parsed);
  return parsed;
}

export function formatIdentity(name: string, email: string, timeSec: number): string {
  return `${name} <${email}> ${timeSec} +0000`;
}

export function buildCommitData(init: {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${init.tree}`];
  for (const parent of init.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${init.author}`);
  lines.push(`committer ${init.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${init.message}`, 'utf8');
}

// ---------------------------------------------------------------------------------------------
// Tags

export interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const headerText = split === -1 ? text : text.slice(0, split);
  const out: ParsedTag = { object: ZERO_OID, type: 'commit', tag: '', tagger: '', message: split === -1 ? '' : text.slice(split + 2) };
  for (const line of headerText.split('\n')) {
    const space = line.indexOf(' ');
    if (space === -1) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'object') out.object = value.trim();
    else if (key === 'type') out.type = value.trim();
    else if (key === 'tag') out.tag = value.trim();
    else if (key === 'tagger') out.tagger = value;
  }
  return out;
}

/** Follow tag objects to the commit they ultimately name (null when the chain breaks). */
export function peelToCommit(repo: RepoRec, sha: string): string | null {
  let current = sha;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = repo.objects.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** The commit a tag object points at directly, peeled one level (for ls-refs `peeled:`). */
export function peelTagOnce(repo: RepoRec, sha: string): string | null {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'tag') return null;
  return parseTag(object.data).object;
}

// ---------------------------------------------------------------------------------------------
// Trees

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space === -1) break;
    const mode = data.subarray(pos, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > data.length) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    pos = nul + 21;
  }
  return entries;
}

/** Git's tree order: by name, with directories compared as if they ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' || entry.mode === '040000' ? `${entry.name}/` : entry.name;
}

export function formatTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export function isTreeMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

/** Flatten a tree into path -> blob entry, recursing into subtrees. */
export function flattenTree(repo: RepoRec, treeSha: string, prefix = '', out = new Map<string, { sha: string; mode: string }>()): Map<string, { sha: string; mode: string }> {
  const object = repo.objects.get(treeSha);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (isTreeMode(entry.mode)) flattenTree(repo, entry.sha, path, out);
    else out.set(path, { sha: entry.sha, mode: entry.mode });
  }
  return out;
}

/** The blob sha at a path inside a commit's tree, or null. */
export function blobAtPath(repo: RepoRec, treeSha: string, path: string): { sha: string; mode: string } | null {
  const parts = path.split('/');
  let current = treeSha;
  for (let i = 0; i < parts.length; i += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === parts[i]);
    if (entry === undefined) return null;
    if (i === parts.length - 1) return isTreeMode(entry.mode) ? null : { sha: entry.sha, mode: entry.mode };
    if (!isTreeMode(entry.mode)) return null;
    current = entry.sha;
  }
  return null;
}

/** The tree sha at a directory path ('' is the root), or null. */
export function treeAtPath(repo: RepoRec, treeSha: string, path: string): string | null {
  if (path === '') return treeSha;
  const parts = path.split('/');
  let current = treeSha;
  for (const part of parts) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === part);
    if (entry === undefined || !isTreeMode(entry.mode)) return null;
    current = entry.sha;
  }
  return current;
}

/**
 * Return a new tree sha with `path` set to the given blob (or removed when blobSha is null),
 * creating intermediate trees. Existing tree objects are never mutated.
 */
export function setTreePath(repo: RepoRec, treeSha: string | null, path: string, blob: { sha: string; mode: string } | null): string {
  const parts = path.split('/');
  const build = (currentTree: string | null, depth: number): string => {
    const entries: TreeEntry[] = currentTree === null ? [] : [...parseTree(repo.objects.get(currentTree)?.data ?? Buffer.alloc(0))];
    const name = parts[depth]!;
    const index = entries.findIndex((entry) => entry.name === name);
    if (depth === parts.length - 1) {
      if (blob === null) {
        if (index !== -1) entries.splice(index, 1);
      } else if (index === -1) {
        entries.push({ mode: blob.mode, name, sha: blob.sha });
      } else {
        entries[index] = { mode: blob.mode, name, sha: blob.sha };
      }
    } else {
      const childTree = index !== -1 && isTreeMode(entries[index]!.mode) ? entries[index]!.sha : null;
      const newChild = build(childTree, depth + 1);
      const childObject = repo.objects.get(newChild);
      const childEmpty = childObject !== undefined && childObject.type === 'tree' && parseTree(childObject.data).length === 0;
      if (childEmpty) {
        if (index !== -1) entries.splice(index, 1);
      } else if (index === -1) {
        entries.push({ mode: '40000', name, sha: newChild });
      } else {
        entries[index] = { mode: '40000', name, sha: newChild };
      }
    }
    return writeObject(repo, 'tree', formatTree(entries));
  };
  return build(treeSha, 0);
}

// ---------------------------------------------------------------------------------------------
// Ancestry

/** Every commit reachable from `tip` (inclusive), following all parents. */
export function ancestorSet(repo: RepoRec, tip: string): Set<string> {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (seen.has(sha)) continue;
    const commit = getCommit(repo, sha);
    if (commit === null) continue;
    seen.add(sha);
    for (const parent of commit.parents) stack.push(parent);
  }
  return seen;
}

export function isAncestor(repo: RepoRec, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  return ancestorSet(repo, tip).has(ancestor);
}

/** A common ancestor of two commits (the one with the newest committer time), or null. */
export function mergeBase(repo: RepoRec, a: string, b: string): string | null {
  const ancestorsA = ancestorSet(repo, a);
  let best: string | null = null;
  let bestTime = -1;
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const commit = getCommit(repo, sha);
    if (commit === null) continue;
    if (ancestorsA.has(sha) && commit.committerTime >= bestTime) {
      best = sha;
      bestTime = commit.committerTime;
    }
    for (const parent of commit.parents) queue.push(parent);
  }
  return best;
}

/** Commits reachable from `tip`, newest first (committer time, then discovery order). */
export function listCommits(repo: RepoRec, tip: string, limit = 100): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const queue = [tip];
  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (seen.has(sha)) continue;
    const commit = getCommit(repo, sha);
    if (commit === null) continue;
    seen.add(sha);
    order.push(sha);
    for (const parent of commit.parents) queue.push(parent);
  }
  order.sort((x, y) => (getCommit(repo, y)?.committerTime ?? 0) - (getCommit(repo, x)?.committerTime ?? 0));
  return order.slice(0, limit);
}

// ---------------------------------------------------------------------------------------------
// Packfiles

const TYPE_TO_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TO_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export interface PackEntryObject {
  sha: string;
  type: GitObjectType;
  data: Buffer;
}

function packEntryHeader(type: GitObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let first = (TYPE_TO_CODE[type] << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Serialize objects into a complete packfile (header, plain entries, SHA-1 trailer). No deltas. */
export function buildPack(objects: readonly PackEntryObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packEntryHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1Hex(body), 'hex')]);
}

/**
 * Inflate one pack object starting at `offset`, learning exactly how many compressed bytes it
 * occupies. zlib ignores trailing bytes past a deflate stream's end, so "inflates to the
 * expected size" is a monotonic predicate in the slice length and a binary search finds the
 * exact end — synchronously, with no stream round-trips on the push hot path.
 */
function inflateExact(buffer: Buffer, offset: number, expectedSize: number): { data: Buffer; consumed: number } {
  const remaining = buffer.length - offset;
  let lo = 1;
  let hi = remaining;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    let ok = false;
    try {
      ok = inflateSync(buffer.subarray(offset, offset + mid)).length === expectedSize;
    } catch {
      ok = false;
    }
    if (ok) {
      best = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (best === -1) throw new Error('corrupt deflate stream in pack');
  return { data: inflateSync(buffer.subarray(offset, offset + best)), consumed: best };
}

/** Apply a git delta to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos]!;
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const opcode = delta[pos]!;
    pos += 1;
    if (opcode & 0x80) {
      let offset = 0;
      let size = 0;
      if (opcode & 0x01) { offset = delta[pos]!; pos += 1; }
      if (opcode & 0x02) { offset |= delta[pos]! << 8; pos += 1; }
      if (opcode & 0x04) { offset |= delta[pos]! << 16; pos += 1; }
      if (opcode & 0x08) { offset |= delta[pos]! << 24; pos += 1; }
      if (opcode & 0x10) { size = delta[pos]!; pos += 1; }
      if (opcode & 0x20) { size |= delta[pos]! << 8; pos += 1; }
      if (opcode & 0x40) { size |= delta[pos]! << 16; pos += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (opcode > 0) {
      out.push(delta.subarray(pos, pos + opcode));
      pos += opcode;
      produced += opcode;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== targetSize || result.length !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

/**
 * Read a packfile into the repository store (resolving ofs/ref deltas against the pack itself or
 * objects the repository already holds). Returns the object ids the pack carried.
 */
export function unpackPack(repo: RepoRec, pack: Buffer): string[] {
  if (pack.length < 12 + 20 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  let pos = 12;
  interface RawEntry { type: GitObjectType | 'ofs-delta' | 'ref-delta'; data: Buffer; baseOffset?: number; baseSha?: string; start: number }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, PackEntryObject>();
  for (let i = 0; i < count; i += 1) {
    const start = pos;
    let byte = pack[pos]!;
    pos += 1;
    const code = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[pos]!;
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseSha: string | undefined;
    if (code === 6) {
      let back = pack[pos]!;
      pos += 1;
      let backValue = back & 0x7f;
      while (back & 0x80) {
        back = pack[pos]!;
        pos += 1;
        backValue = ((backValue + 1) << 7) | (back & 0x7f);
      }
      baseOffset = start - backValue;
    } else if (code === 7) {
      baseSha = pack.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    }
    const inflated = inflateExact(pack, pos, size);
    pos += inflated.consumed;
    if (code === 6) raw.push({ type: 'ofs-delta', data: inflated.data, baseOffset, start });
    else if (code === 7) raw.push({ type: 'ref-delta', data: inflated.data, baseSha, start });
    else {
      const type = CODE_TO_TYPE[code];
      if (type === undefined) throw new Error(`unknown pack object type ${code}`);
      raw.push({ type, data: inflated.data, start });
    }
  }
  const trailer = pack.subarray(pack.length - 20).toString('hex');
  if (sha1Hex(pack.subarray(0, pack.length - 20)) !== trailer) throw new Error('pack checksum mismatch');
  const resolveEntry = (entry: RawEntry): PackEntryObject => {
    if (entry.type !== 'ofs-delta' && entry.type !== 'ref-delta') {
      return { sha: hashObject(entry.type, entry.data), type: entry.type, data: entry.data };
    }
    let base: PackEntryObject | undefined;
    if (entry.type === 'ofs-delta') {
      base = byOffset.get(entry.baseOffset!);
      if (base === undefined) {
        const baseRaw = raw.find((candidate) => candidate.start === entry.baseOffset);
        if (baseRaw === undefined) throw new Error('ofs-delta base missing');
        base = resolveEntry(baseRaw);
      }
    } else {
      const existing = repo.objects.get(entry.baseSha!);
      if (existing !== undefined) base = { sha: entry.baseSha!, type: existing.type, data: existing.data };
      else {
        const baseRaw = raw.find((candidate) => candidate.type !== 'ofs-delta' && candidate.type !== 'ref-delta' && hashObject(candidate.type, candidate.data) === entry.baseSha);
        if (baseRaw === undefined) throw new Error('ref-delta base missing');
        base = resolveEntry(baseRaw);
      }
    }
    const data = applyDelta(base.data, entry.data);
    return { sha: hashObject(base.type, data), type: base.type, data };
  };
  const written: string[] = [];
  for (const entry of raw) {
    const resolved = resolveEntry(entry);
    byOffset.set(entry.start, resolved);
    if (!repo.objects.has(resolved.sha)) repo.objects.set(resolved.sha, { type: resolved.type, data: resolved.data });
    written.push(resolved.sha);
  }
  return written;
}

// ---------------------------------------------------------------------------------------------
// Fetch object selection: closure(wants) minus closure(haves), with shallow/deepen semantics.

export interface FetchSelection {
  objects: PackEntryObject[];
  shallow: string[];
  unshallow: string[];
}

/** Add a tree and everything under it to the set. */
function addTreeClosure(repo: RepoRec, treeSha: string, into: Map<string, PackEntryObject>): void {
  if (into.has(treeSha)) return;
  const object = repo.objects.get(treeSha);
  if (object === undefined || object.type !== 'tree') return;
  into.set(treeSha, { sha: treeSha, type: 'tree', data: object.data });
  for (const entry of parseTree(object.data)) {
    if (isTreeMode(entry.mode)) addTreeClosure(repo, entry.sha, into);
    else if (!into.has(entry.sha)) {
      const blob = repo.objects.get(entry.sha);
      if (blob !== undefined) into.set(entry.sha, { sha: entry.sha, type: blob.type, data: blob.data });
    }
  }
}

/**
 * The object closure of a set of tip objects. When `boundaries` names commits, those commits are
 * included with their trees but their parents are not followed (a shallow client's holdings).
 */
function closureOf(repo: RepoRec, tips: readonly string[], boundaries: ReadonlySet<string>): Map<string, PackEntryObject> {
  const out = new Map<string, PackEntryObject>();
  const stack: string[] = [...tips];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (out.has(sha)) continue;
    const object = repo.objects.get(sha);
    if (object === undefined) continue;
    out.set(sha, { sha, type: object.type, data: object.data });
    if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    } else if (object.type === 'commit') {
      const commit = getCommit(repo, sha);
      if (commit === null) continue;
      addTreeClosure(repo, commit.tree, out);
      if (!boundaries.has(sha)) for (const parent of commit.parents) stack.push(parent);
    }
  }
  return out;
}

export interface FetchRequestShape {
  wants: string[];
  haves: string[];
  clientShallows: string[];
  deepen: number | null;
  deepenSince: number | null;
  deepenNot: string[];
}

export function selectFetchObjects(repo: RepoRec, request: FetchRequestShape): FetchSelection {
  const shallowBoundary = new Set(request.clientShallows);
  const haveObjects = closureOf(repo, request.haves, shallowBoundary);
  // A shallow client's own boundary commits: it already holds the commit and its tree.
  for (const boundary of request.clientShallows) {
    for (const [sha, object] of closureOf(repo, [boundary], new Set([boundary]))) {
      if (!haveObjects.has(sha)) haveObjects.set(sha, object);
    }
  }

  const excluded = new Set<string>();
  for (const not of request.deepenNot) {
    for (const sha of ancestorSet(repo, not)) excluded.add(sha);
  }

  let wantObjects: Map<string, PackEntryObject>;
  const shallow: string[] = [];
  const unshallow: string[] = [];

  if (request.deepen === null && request.deepenSince === null) {
    wantObjects = closureOf(repo, request.wants, new Set());
  } else {
    // Breadth-first by generation from the want commits (tags peel to commits first).
    wantObjects = new Map();
    const generation = new Map<string, number>();
    const queue: string[] = [];
    for (const want of request.wants) {
      const object = repo.objects.get(want);
      if (object === undefined) continue;
      if (object.type === 'tag') {
        wantObjects.set(want, { sha: want, type: 'tag', data: object.data });
        const commit = peelToCommit(repo, want);
        if (commit !== null && !generation.has(commit)) {
          generation.set(commit, 1);
          queue.push(commit);
        }
      } else if (object.type === 'commit') {
        if (!generation.has(want)) {
          generation.set(want, 1);
          queue.push(want);
        }
      }
    }
    const included = new Set<string>();
    while (queue.length > 0) {
      const sha = queue.shift()!;
      const gen = generation.get(sha)!;
      const commit = getCommit(repo, sha);
      if (commit === null) continue;
      if (request.deepenSince !== null && included.size > 0 && commit.committerTime <= request.deepenSince && !request.wants.includes(sha)) {
        continue;
      }
      included.add(sha);
      const mayDescend = request.deepen === null || gen < request.deepen;
      for (const parent of commit.parents) {
        if (excluded.has(parent)) continue;
        if (mayDescend && !generation.has(parent)) {
          generation.set(parent, gen + 1);
          queue.push(parent);
        }
      }
    }
    for (const sha of included) {
      const object = repo.objects.get(sha);
      if (object === undefined) continue;
      wantObjects.set(sha, { sha, type: 'commit', data: object.data });
      const commit = getCommit(repo, sha);
      if (commit !== null) addTreeClosure(repo, commit.tree, wantObjects);
    }
    // Boundary: an included commit with a parent that exists but was not included.
    for (const sha of included) {
      const commit = getCommit(repo, sha);
      if (commit === null) continue;
      const hasParentInStore = commit.parents.some((parent) => repo.objects.has(parent));
      const hasParentIncluded = commit.parents.some((parent) => included.has(parent));
      if (hasParentInStore && !hasParentIncluded) {
        if (shallowBoundary.has(sha)) continue;
        shallow.push(sha);
      }
      if (shallowBoundary.has(sha) && hasParentIncluded) unshallow.push(sha);
    }
  }

  for (const sha of excluded) wantObjects.delete(sha);
  const objects: PackEntryObject[] = [];
  const kindOrder: Record<GitObjectType, number> = { commit: 0, tree: 1, blob: 2, tag: 3 };
  const selected = [...wantObjects.values()].filter((object) => !haveObjects.has(object.sha));
  selected.sort((a, b) => kindOrder[a.type] - kindOrder[b.type]);
  objects.push(...selected);
  return { objects, shallow, unshallow };
}

// ---------------------------------------------------------------------------------------------
// Three-way tree merge (squash and merge commits) and tree diffs (pull request files).

export type FlatTree = Map<string, { sha: string; mode: string }>;

export function flatTreeOf(repo: RepoRec, commitSha: string | null): FlatTree {
  if (commitSha === null) return new Map();
  const commit = getCommit(repo, commitSha);
  if (commit === null) return new Map();
  return flattenTree(repo, commit.tree);
}

/**
 * File-level three-way merge: for each path, the side that changed it relative to the base wins;
 * both sides changing it differently is a conflict. Returns the merged flat tree or the first
 * conflicting path.
 */
export function threeWayMerge(base: FlatTree, head: FlatTree, current: FlatTree): { merged: FlatTree } | { conflict: string } {
  const merged: FlatTree = new Map();
  const paths = new Set<string>([...base.keys(), ...head.keys(), ...current.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    const c = current.get(path);
    const same = (x: { sha: string; mode: string } | undefined, y: { sha: string; mode: string } | undefined): boolean =>
      x === undefined && y === undefined ? true : x !== undefined && y !== undefined && x.sha === y.sha && x.mode === y.mode;
    if (same(h, c)) {
      if (h !== undefined) merged.set(path, h);
    } else if (same(b, h)) {
      if (c !== undefined) merged.set(path, c);
    } else if (same(b, c)) {
      if (h !== undefined) merged.set(path, h);
    } else {
      return { conflict: path };
    }
  }
  return { merged };
}

/** Materialize a flat path map into real tree objects; returns the root tree sha. */
export function buildTreeFromFlat(repo: RepoRec, flat: FlatTree): string {
  const build = (entries: [string, { sha: string; mode: string }][]): string => {
    const direct: TreeEntry[] = [];
    const dirs = new Map<string, [string, { sha: string; mode: string }][]>();
    for (const [path, blob] of entries) {
      const slash = path.indexOf('/');
      if (slash === -1) {
        direct.push({ mode: blob.mode, name: path, sha: blob.sha });
      } else {
        const dir = path.slice(0, slash);
        const rest = path.slice(slash + 1);
        const list = dirs.get(dir) ?? [];
        list.push([rest, blob]);
        dirs.set(dir, list);
      }
    }
    for (const [dir, list] of dirs) direct.push({ mode: '40000', name: dir, sha: build(list) });
    return writeObject(repo, 'tree', formatTree(direct));
  };
  return build([...flat.entries()]);
}

export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line-level additions/deletions between two texts via a longest-common-subsequence count. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length === 0) return { additions: b.length, deletions: 0 };
  if (b.length === 0) return { additions: 0, deletions: a.length };
  if (a.length * b.length > 4_000_000) {
    // Oversized fallback: multiset difference (exact enough for a stat line).
    const counts = new Map<string, number>();
    for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
    let common = 0;
    for (const line of b) {
      const left = counts.get(line) ?? 0;
      if (left > 0) {
        counts.set(line, left - 1);
        common += 1;
      }
    }
    return { additions: b.length - common, deletions: a.length - common };
  }
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const above = dp[j]!;
      if (a[i - 1] === b[j - 1]) dp[j] = diagonal + 1;
      else dp[j] = Math.max(dp[j]!, dp[j - 1]!);
      diagonal = above;
    }
  }
  const lcs = dp[b.length]!;
  return { additions: b.length - lcs, deletions: a.length - lcs };
}

/** The changed files between two commits' trees (either may be null for an empty tree). */
export function diffCommits(repo: RepoRec, fromCommit: string | null, toCommit: string | null): FileChange[] {
  const from = flatTreeOf(repo, fromCommit);
  const to = flatTreeOf(repo, toCommit);
  const changes: FileChange[] = [];
  const paths = new Set<string>([...from.keys(), ...to.keys()]);
  const blobText = (sha: string): string => repo.objects.get(sha)?.data.toString('utf8') ?? '';
  for (const path of [...paths].sort()) {
    const f = from.get(path);
    const t = to.get(path);
    if (f !== undefined && t !== undefined && f.sha === t.sha) continue;
    if (f === undefined && t !== undefined) {
      const { additions } = lineDiff('', blobText(t.sha));
      changes.push({ path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (f !== undefined && t === undefined) {
      const { deletions } = lineDiff(blobText(f.sha), '');
      changes.push({ path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (f !== undefined && t !== undefined) {
      const { additions, deletions } = lineDiff(blobText(f.sha), blobText(t.sha));
      changes.push({ path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return changes;
}
