// git.ts — git object store, pack files, pkt-lines, reachability, diff/merge.
// Node standard library only (node:crypto, node:zlib).

import { createHash, randomUUID } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { CommitInfo, GitObject, Repo } from './store.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const AGENT = 'makefun-forge/1.0';

export function isOid(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s);
}

export function hashObject(type: string, data: Buffer): string {
  const h = createHash('sha1');
  h.update(`${type} ${data.length}\0`, 'utf8');
  h.update(data);
  return h.digest('hex');
}

export function storeObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  let timestamp = 0;
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      author = line.slice(7);
      const m = author.match(/ (\d+) [+-]\d{4}$/);
      if (m) timestamp = Number(m[1]);
    } else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, message, author, committer, timestamp };
}

export function buildCommit(repo: Repo, info: CommitInfo): string {
  let head = `tree ${info.tree}\n`;
  for (const p of info.parents) head += `parent ${p}\n`;
  head += `author ${info.author}\n`;
  head += `committer ${info.committer}\n`;
  const data = Buffer.from(`${head}\n${info.message}`, 'utf8');
  return storeObject(repo, 'commit', data);
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, space + 1);
    const mode = data.subarray(off, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

export function buildTree(repo: Repo, entries: TreeEntry[]): string {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return storeObject(repo, 'tree', Buffer.concat(parts));
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string; message: string } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let object = '';
  let type = '';
  let tag = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
  }
  return { object, type, tag, message };
}

// ---------------------------------------------------------------- pkt-lines

export function pktLine(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'utf8');
  return Buffer.concat([head, payload]);
}

export const FLUSH = Buffer.from('0000', 'utf8');
export const DELIM = Buffer.from('0001', 'utf8');

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

export function decodePackets(buf: Buffer): Packet[] {
  const out: Packet[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line header');
    const head = buf.subarray(off, off + 4).toString('utf8');
    if (head === '0000') {
      out.push({ kind: 'flush' });
      off += 4;
      continue;
    }
    if (head === '0001') {
      out.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (head === '0002') {
      out.push({ kind: 'response-end' });
      off += 4;
      continue;
    }
    const len = parseInt(head, 16);
    if (Number.isNaN(len) || len < 4 || off + len > buf.length) {
      throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    }
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}

export function packetText(p: Packet): string | null {
  return p.kind === 'data' ? p.payload.toString('utf8') : null;
}

// ---------------------------------------------------------------- pack files

const PACK_TYPES: Record<number, GitObject['type']> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};
const TYPE_CODES: Record<GitObject['type'], number> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};

function readVarint(buf: Buffer, off: number): { value: number; next: number } {
  let value = buf[off] & 0x7f;
  let shift = 7;
  let i = off + 1;
  while (buf[i - 1] & 0x80) {
    value |= (buf[i] & 0x7f) << shift;
    shift += 7;
    i += 1;
  }
  return { value, next: i };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVar = (): number => {
    const r = readVarint(delta, off);
    off = r.next;
    return r.value;
  };
  const srcSize = readVar();
  const dstSize = readVar();
  if (srcSize !== base.length) throw new Error('delta source size mismatch');
  const chunks: Buffer[] = [];
  let written = 0;
  while (off < delta.length) {
    const op = delta[off];
    off += 1;
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let b = 0; b < 4; b += 1) {
        if (op & (1 << b)) {
          cpOff |= delta[off] << (8 * b);
          off += 1;
        }
      }
      for (let b = 0; b < 3; b += 1) {
        if (op & (0x10 << b)) {
          cpSize |= delta[off] << (8 * b);
          off += 1;
        }
      }
      if (cpSize === 0) cpSize = 0x10000;
      chunks.push(base.subarray(cpOff, cpOff + cpSize));
      written += cpSize;
    } else if (op !== 0) {
      chunks.push(delta.subarray(off, off + op));
      written += op;
      off += op;
    } else {
      throw new Error('delta op 0');
    }
  }
  const out = Buffer.concat(chunks);
  if (out.length !== dstSize || written !== dstSize) throw new Error('delta target size mismatch');
  return out;
}

export interface PackRead {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackRead {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a pack file');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const pending = new Map<string, { type: number; data: Buffer; baseOid?: string; baseOff?: number }>();
  const byOffset = new Map<number, string>();
  let deltaCount = 0;
  let off = 12;
  for (let n = 0; n < count; n += 1) {
    const start = off;
    const first = pack[off];
    const type = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    off += 1;
    while (pack[off - 1] & 0x80) {
      size |= (pack[off] & 0x7f) << shift;
      shift += 7;
      off += 1;
    }
    let baseOid: string | undefined;
    let baseOff: number | undefined;
    if (type === 6) {
      // OFS_DELTA: negative offset varint
      let b = pack[off];
      off += 1;
      let base = b & 0x7f;
      while (b & 0x80) {
        b = pack[off];
        off += 1;
        base = ((base + 1) << 7) | (b & 0x7f);
      }
      baseOff = start - base;
      deltaCount += 1;
    } else if (type === 7) {
      baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
      deltaCount += 1;
    }
    const raw = inflateSync(pack.subarray(off));
    // find consumed length: re-deflate is unreliable; instead use zlib stream length via a second pass
    const consumed = zlibConsumed(pack.subarray(off));
    off += consumed;
    if (type === 6 || type === 7) {
      pending.set(`__pending_${n}`, { type, data: raw, baseOid, baseOff });
      byOffset.set(start, `__pending_${n}`);
    } else {
      const objType = PACK_TYPES[type];
      if (!objType) throw new Error(`unknown pack object type ${type}`);
      const oid = hashObject(objType, raw);
      objects.set(oid, { type: objType, data: raw });
      byOffset.set(start, oid);
    }
  }
  // Resolve deltas (possibly chained): iterate until all resolved.
  const resolveOne = (key: string, seen: Set<string>): { oid: string; obj: GitObject } => {
    if (objects.has(key)) return { oid: key, obj: objects.get(key)! };
    if (seen.has(key)) throw new Error('delta cycle');
    seen.add(key);
    const entry = pending.get(key)!;
    let baseOid: string;
    let baseObj: GitObject;
    if (entry.baseOff !== undefined) {
      const baseKey = byOffset.get(entry.baseOff);
      if (!baseKey) throw new Error('ofs-delta base not found');
      const resolved = resolveOne(baseKey, seen);
      baseOid = resolved.oid;
      baseObj = resolved.obj;
    } else {
      baseOid = entry.baseOid!;
      if (objects.has(baseOid)) {
        baseObj = objects.get(baseOid)!;
      } else if (resolveBase) {
        const ext = resolveBase(baseOid);
        if (!ext) throw new Error(`ref-delta base ${baseOid} not available`);
        baseObj = ext;
      } else {
        throw new Error(`ref-delta base ${baseOid} not available`);
      }
    }
    const data = applyDelta(baseObj.data, entry.data);
    const oid = hashObject(baseObj.type, data);
    const obj: GitObject = { type: baseObj.type, data };
    objects.set(oid, obj);
    pending.delete(key);
    return { oid, obj };
  };
  for (const key of [...pending.keys()]) {
    if (pending.has(key)) resolveOne(key, new Set());
  }
  return { objects, deltaCount };
}

function zlibConsumed(buf: Buffer): number {
  // Node's inflateSync ignores trailing bytes and throws on truncation, so
  // binary-search the smallest prefix that inflates successfully.
  let lo = 1;
  let hi = buf.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buf.subarray(0, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return lo;
}

export function writePack(repo: Repo, oids: Iterable<string>): Buffer {
  const list = [...new Set(oids)].sort();
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(list.length, 8);
  parts.push(head);
  const body: Buffer[] = [];
  for (const oid of list) {
    const obj = repo.objects.get(oid);
    if (!obj) throw new Error(`pack: object ${oid} missing`);
    const typeCode = TYPE_CODES[obj.type];
    const size = obj.data.length;
    const headerBytes: number[] = [];
    let b = (typeCode << 4) | (size & 0x0f);
    let rest = size >> 4;
    if (rest > 0) b |= 0x80;
    headerBytes.push(b);
    while (rest > 0) {
      let nb = rest & 0x7f;
      rest >>= 7;
      if (rest > 0) nb |= 0x80;
      headerBytes.push(nb);
    }
    body.push(Buffer.from(headerBytes));
    body.push(deflateSync(obj.data, { level: 1 }));
  }
  const content = Buffer.concat([head, ...body]);
  const trailer = createHash('sha1').update(content).digest();
  return Buffer.concat([content, trailer]);
}

export function verifyPackChecksum(pack: Buffer): { ok: boolean; actual: string; expected: string } {
  const actual = pack.subarray(pack.length - 20).toString('hex');
  const expected = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  return { ok: actual === expected, actual, expected };
}

// ---------------------------------------------------------------- reachability

export function peelToCommit(repo: Repo, oid: string): string | null {
  let cur = oid;
  const seen = new Set<string>();
  while (true) {
    const obj = repo.objects.get(cur);
    if (!obj) return null;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') {
      if (seen.has(cur)) return null;
      seen.add(cur);
      cur = parseTag(obj.data).object;
      continue;
    }
    return null;
  }
}

export function reachableCommits(repo: Repo, starts: string[], maxDepth?: number): Set<string> {
  const out = new Set<string>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const s of starts) {
    const c = peelToCommit(repo, s);
    if (c) queue.push({ oid: c, depth: 0 });
  }
  while (queue.length > 0) {
    const { oid, depth } = queue.shift()!;
    if (out.has(oid)) continue;
    if (maxDepth !== undefined && depth > maxDepth - 1) continue;
    out.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const info = parseCommit(obj.data);
    for (const p of info.parents) {
      if (!out.has(p)) queue.push({ oid: p, depth: depth + 1 });
    }
  }
  return out;
}

export function reachableObjects(repo: Repo, commitOids: Set<string>): Set<string> {
  const out = new Set<string>();
  const stack: string[] = [...commitOids];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    out.add(oid);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      stack.push(info.tree);
      for (const p of info.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return out;
}

/**
 * The objects a set of commits needs on their own: the commits, their trees
 * and blobs (and tag targets) — but NOT their parents. This is what a
 * depth-limited or incremental fetch sends: walking parents would leak
 * history the client already holds or was never asked for.
 */
export function objectsForCommits(repo: Repo, commitOids: Set<string>): Set<string> {
  const out = new Set<string>();
  const stack: string[] = [...commitOids];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    out.add(oid);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      stack.push(info.tree);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return out;
}

/** Flatten a tree to path -> {mode, oid}. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  const walk = (oid: string, pre: string): void => {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      const path = pre ? `${pre}/${e.name}` : e.name;
      if (e.mode === '40000') walk(e.oid, path);
      else out.set(path, { mode: e.mode, oid: e.oid });
    }
  };
  walk(treeOid, prefix);
  return out;
}

export function buildTreeFromPaths(repo: Repo, files: Map<string, { mode: string; oid: string }>): string {
  // Build nested tree structure bottom-up.
  const build = (paths: Map<string, { mode: string; oid: string }>): string => {
    const entries: TreeEntry[] = [];
    const dirs = new Map<string, Map<string, { mode: string; oid: string }>>();
    for (const [path, v] of paths) {
      const slash = path.indexOf('/');
      if (slash < 0) {
        entries.push({ mode: v.mode, name: path, oid: v.oid });
      } else {
        const dir = path.slice(0, slash);
        const rest = path.slice(slash + 1);
        if (!dirs.has(dir)) dirs.set(dir, new Map());
        dirs.get(dir)!.set(rest, v);
      }
    }
    for (const [dir, sub] of dirs) {
      entries.push({ mode: '40000', name: dir, oid: build(sub) });
    }
    return buildTree(repo, entries);
  };
  return build(files);
}

// ---------------------------------------------------------------- diff / merge

export interface FileDiff {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  oldOid: string | null;
  newOid: string | null;
}

function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

function diffLineCounts(oldBuf: Buffer | null, newBuf: Buffer | null): { additions: number; deletions: number } {
  const oldLines = oldBuf ? oldBuf.toString('utf8').split('\n') : [];
  const newLines = newBuf ? newBuf.toString('utf8').split('\n') : [];
  const strip = (arr: string[]): string[] => {
    if (arr.length > 0 && arr[arr.length - 1] === '') arr.pop();
    return arr;
  };
  const a = strip(oldLines);
  const b = strip(newLines);
  if (a.length > 2000 || b.length > 2000) {
    return { additions: b.length, deletions: a.length };
  }
  // DP LCS
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lcs = dp[0][0];
  return { additions: b.length - lcs, deletions: a.length - lcs };
}

export function diffTrees(repo: Repo, baseTreeOid: string | null, headTreeOid: string | null): FileDiff[] {
  const base = baseTreeOid ? flattenTree(repo, baseTreeOid) : new Map();
  const head = headTreeOid ? flattenTree(repo, headTreeOid) : new Map();
  const paths = new Set([...base.keys(), ...head.keys()]);
  const out: FileDiff[] = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) {
      const oldBuf = repo.objects.get(b.oid)?.data ?? null;
      const { deletions } = diffLineCounts(oldBuf, null);
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions, oldOid: b.oid, newOid: null });
    } else if (!b && h) {
      const newBuf = repo.objects.get(h.oid)?.data ?? null;
      const additions = countLines(newBuf ?? Buffer.alloc(0));
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions, oldOid: null, newOid: h.oid });
    } else if (b && h && b.oid !== h.oid) {
      const oldBuf = repo.objects.get(b.oid)?.data ?? null;
      const newBuf = repo.objects.get(h.oid)?.data ?? null;
      const { additions, deletions } = diffLineCounts(oldBuf, newBuf);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions, oldOid: b.oid, newOid: h.oid });
    }
  }
  return out;
}

/**
 * Three-way merge of trees: base -> head changes applied onto current.
 * Returns the merged tree oid, or null on conflict (same path changed
 * differently on both sides after the base).
 */
export function threeWayMerge(repo: Repo, baseTreeOid: string, headTreeOid: string, currentTreeOid: string): string | null {
  const base = flattenTree(repo, baseTreeOid);
  const head = flattenTree(repo, headTreeOid);
  const current = flattenTree(repo, currentTreeOid);
  const merged = new Map<string, { mode: string; oid: string }>(current);
  const paths = new Set([...base.keys(), ...head.keys(), ...current.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    const c = current.get(path);
    const same = (x?: { oid: string }, y?: { oid: string }): boolean =>
      (x?.oid ?? null) === (y?.oid ?? null);
    if (same(b, h)) {
      // unchanged on head side: keep current
      continue;
    }
    if (same(b, c)) {
      // unchanged on current side: take head (or delete if head removed it)
      if (h) merged.set(path, h);
      else merged.delete(path);
      continue;
    }
    if (same(h, c)) {
      // both sides made the same change: keep
      continue;
    }
    return null; // conflict
  }
  return buildTreeFromPaths(repo, merged);
}

export function randomId(): string {
  return randomUUID();
}
