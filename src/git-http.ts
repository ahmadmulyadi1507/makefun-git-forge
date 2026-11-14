// git-http.ts — git smart HTTP: info/refs advertisement, upload-pack v2/v0,
// receive-pack v0. Responses are pkt-line framed as the git client expects.

import {
  AGENT,
  DELIM,
  FLUSH,
  decodePackets,
  isOid,
  objectsForCommits,
  parseCommit,
  parseTag,
  peelToCommit,
  pktLine,
  readPack,
  reachableCommits,
  reachableObjects,
  verifyPackChecksum,
  writePack,
  ZERO_OID,
} from './git.ts';
import { Store, VIEWER_LOGIN, type Repo } from './store.ts';

export interface GitHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

function allRefs(repo: Repo): Array<{ oid: string; name: string; peeled?: string }> {
  const out: Array<{ oid: string; name: string; peeled?: string }> = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const obj = repo.objects.get(oid);
    if (obj?.type === 'tag') {
      const peeled = peelToCommit(repo, oid);
      out.push({ oid, name, peeled: peeled ?? undefined });
    } else {
      out.push({ oid, name });
    }
  }
  return out;
}

function headTip(repo: Repo): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

function advertiseV0Upload(repo: Repo): Buffer {
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), FLUSH];
  const caps =
    'multi_ack thin-pack side-band side-band-64k ofs-delta shallow no-progress include-tag multi_ack_detailed ' +
    `agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch} object-format=sha1`;
  const tip = headTip(repo);
  if (!tip) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${tip} HEAD\0${caps}\n`));
    for (const ref of allRefs(repo)) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function advertiseV0Receive(repo: Repo): Buffer {
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), FLUSH];
  const caps =
    'report-status side-band-64k delete-refs ofs-delta ' +
    `agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch} object-format=sha1`;
  const tip = headTip(repo);
  if (!tip) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${tip} HEAD\0${caps}\n`));
    for (const ref of allRefs(repo)) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function advertiseV2(): Buffer {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    FLUSH,
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    FLUSH,
  ]);
}

function lsRefsV2(repo: Repo, prefixes: string[], wantPeel: boolean, wantSymrefs: boolean, wantUnborn: boolean): Buffer {
  const parts: Buffer[] = [];
  const refs = allRefs(repo);
  const tip = headTip(repo);
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  if (!tip) {
    if (wantUnborn && keep('HEAD')) {
      parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
  } else {
    if (keep('HEAD')) {
      parts.push(pktLine(`${tip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (wantPeel && ref.peeled) line += ` peeled:${ref.peeled}`;
      parts.push(pktLine(`${line}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

interface FetchPlan {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function planFetch(repo: Repo, plan: FetchPlan): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  // Pack cache: the clone workload fires 50 identical shallow fetches, and
  // the pack for a given (state, wants, haves, shallow, depth) is identical.
  // The key names the repo state (tip + object count) so a mutation can
  // never serve a stale pack.
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? '';
  const cacheKey = `${repo.databaseId}|${tip}|${repo.objects.size}|${[...plan.wants].sort().join(',')}|${[...plan.haves].sort().join(',')}|${[...plan.shallow].sort().join(',')}|${plan.depth ?? ''}`;
  const cached = repo.packCache.get(cacheKey);
  if (cached) return cached;
  const result = computeFetch(repo, plan);
  if (repo.packCache.size >= 64) {
    const first = repo.packCache.keys().next().value;
    if (first !== undefined) repo.packCache.delete(first);
  }
  repo.packCache.set(cacheKey, result);
  return result;
}

function computeFetch(repo: Repo, plan: FetchPlan): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const wants = [...new Set(plan.wants)].filter((w) => repo.objects.has(w));
  const depth = plan.depth;
  const included = reachableCommits(repo, wants, depth ?? undefined);
  // Held commits: a full have carries its whole history; a shallow boundary
  // carries only itself (its tree and blobs) — its parents are NOT held.
  const heldFull = new Set<string>();
  const heldBoundary = new Set<string>();
  for (const have of plan.haves) {
    if (plan.shallow.includes(have)) {
      const c = peelToCommit(repo, have);
      if (c) heldBoundary.add(c);
    } else {
      for (const c of reachableCommits(repo, [have])) heldFull.add(c);
    }
  }
  const heldObjects = reachableObjects(repo, heldFull);
  for (const o of objectsForCommits(repo, heldBoundary)) heldObjects.add(o);
  const sendCommits = new Set([...included].filter((c) => !heldFull.has(c) && !heldBoundary.has(c)));
  const sendObjects = objectsForCommits(repo, sendCommits);
  // Tag objects named by wants must be sent even if the peeled commit is held.
  for (const w of wants) {
    const obj = repo.objects.get(w);
    if (obj?.type === 'tag' && !heldObjects.has(w)) sendObjects.add(w);
  }
  for (const h of heldObjects) sendObjects.delete(h);
  const pack = writePack(repo, sendObjects);
  // New shallow boundaries: included commits whose parent is not included.
  let shallow: string[] = [];
  if (depth !== null) {
    for (const c of included) {
      const info = parseCommit(repo.objects.get(c)!.data);
      for (const p of info.parents) {
        if (!included.has(p) && repo.objects.has(p)) {
          shallow.push(c);
          break;
        }
      }
    }
  }
  shallow = [...new Set(shallow)];
  // Unshallow: previously shallow commits now included with all parents included.
  const unshallow: string[] = [];
  for (const s of plan.shallow) {
    const c = peelToCommit(repo, s);
    if (c && included.has(c) && !shallow.includes(c)) unshallow.push(c);
  }
  return { pack, shallow, unshallow };
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65500;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    const head = Buffer.from((payload.length + 4).toString(16).padStart(4, '0'), 'utf8');
    out.push(Buffer.concat([head, payload]));
  }
  if (out.length === 0) {
    const payload = Buffer.from([1]);
    const head = Buffer.from((payload.length + 4).toString(16).padStart(4, '0'), 'utf8');
    out.push(Buffer.concat([head, payload]));
  }
  return out;
}

function fetchV2(repo: Repo, plan: FetchPlan): Buffer {
  const { pack, shallow, unshallow } = planFetch(repo, plan);
  const parts: Buffer[] = [
    pktLine('acknowledgments\n'),
    pktLine('NAK\n'),
    pktLine('ready\n'),
    DELIM,
    pktLine('shallow-info\n'),
  ];
  for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  parts.push(DELIM, pktLine('packfile\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function fetchV0(repo: Repo, plan: FetchPlan): Buffer {
  const { pack, shallow, unshallow } = planFetch(repo, plan);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  parts.push(...sidebandPackets(pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function isFastForward(repo: Repo, oldOid: string, newOid: string): boolean {
  if (oldOid === ZERO_OID) return true;
  // Walk back from the new tip and stop as soon as the old tip is found;
  // a push's new tip is usually one commit ahead, so this is O(distance),
  // not O(history).
  const stack = [newOid];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === oldOid) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return false;
}

export function handleGit(
  store: Store,
  method: string,
  path: string,
  query: URLSearchParams,
  headers: Record<string, string>,
  body: Buffer,
): GitHttpResponse {
  const notFound = (): GitHttpResponse => ({
    status: 404,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ message: 'Not Found' })),
  });
  const badRequest = (message: string): GitHttpResponse => ({
    status: 400,
    headers: { 'content-type': 'text/plain' },
    body: Buffer.from(message),
  });

  const m = path.match(/^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/);
  if (!m) return notFound();
  const owner = decodeURIComponent(m[1]);
  const name = decodeURIComponent(m[2]);
  const endpoint = m[3];
  if (owner !== VIEWER_LOGIN) return notFound();
  const repo = store.getRepo(owner, name);
  if (!repo) return notFound();

  // ---- info/refs ----
  if (method === 'GET' && endpoint === 'info/refs') {
    const service = query.get('service');
    if (service === 'git-upload-pack') {
      const v2 = (headers['git-protocol'] ?? '').trim() === 'version=2';
      return {
        status: 200,
        headers: { 'content-type': UPLOAD_AD, 'cache-control': 'no-cache' },
        body: v2 ? advertiseV2() : advertiseV0Upload(repo),
      };
    }
    if (service === 'git-receive-pack') {
      return { status: 200, headers: { 'content-type': RECEIVE_AD, 'cache-control': 'no-cache' }, body: advertiseV0Receive(repo) };
    }
    return badRequest('service required');
  }

  // ---- upload-pack ----
  if (method === 'POST' && endpoint === 'git-upload-pack') {
    const v2 = (headers['git-protocol'] ?? '').trim() === 'version=2';
    let packets;
    try {
      packets = decodePackets(body);
    } catch (e) {
      return badRequest(`bad pkt-line stream: ${(e as Error).message}`);
    }
    if (v2) {
      const command = packets
        .map((p) => (p.kind === 'data' ? p.payload.toString('utf8').replace(/\n$/, '') : null))
        .find((t) => t !== null && t.startsWith('command=')) as string | undefined;
      if (command === 'command=ls-refs') {
        const args: string[] = [];
        let afterDelim = false;
        for (const p of packets) {
          if (p.kind === 'delim') {
            afterDelim = true;
            continue;
          }
          if (afterDelim && p.kind === 'data') args.push(p.payload.toString('utf8').replace(/\n$/, ''));
        }
        const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
        return {
          status: 200,
          headers: { 'content-type': UPLOAD_RESULT },
          body: lsRefsV2(repo, prefixes, args.includes('peel'), args.includes('symrefs'), args.includes('unborn')),
        };
      }
      if (command === 'command=fetch') {
        const args: string[] = [];
        let afterDelim = false;
        for (const p of packets) {
          if (p.kind === 'delim') {
            afterDelim = true;
            continue;
          }
          if (afterDelim && p.kind === 'data') args.push(p.payload.toString('utf8').replace(/\n$/, ''));
        }
        const plan: FetchPlan = { wants: [], haves: [], shallow: [], depth: null };
        for (const a of args) {
          if (a.startsWith('want ')) plan.wants.push(a.slice(5).split(' ')[0]);
          else if (a.startsWith('have ')) plan.haves.push(a.slice(5).trim());
          else if (a.startsWith('shallow ')) plan.shallow.push(a.slice(8).trim());
          else if (a.startsWith('deepen ')) plan.depth = Number(a.slice(7).trim());
        }
        return { status: 200, headers: { 'content-type': UPLOAD_RESULT }, body: fetchV2(repo, plan) };
      }
      return badRequest('unknown v2 command');
    }
    // v0 fetch: wants + shallow + deepen, flush, haves + done, flush
    const plan: FetchPlan = { wants: [], haves: [], shallow: [], depth: null };
    for (const p of packets) {
      if (p.kind !== 'data') continue;
      const line = p.payload.toString('utf8').replace(/\n$/, '');
      if (line.startsWith('want ')) plan.wants.push(line.slice(5).split(' ')[0]);
      else if (line.startsWith('have ')) plan.haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) plan.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) plan.depth = Number(line.slice(7).trim());
    }
    if (plan.wants.length === 0) return badRequest('no wants');
    return { status: 200, headers: { 'content-type': UPLOAD_RESULT }, body: fetchV0(repo, plan) };
  }

  // ---- receive-pack ----
  if (method === 'POST' && endpoint === 'git-receive-pack') {
    // Parse command pkt-lines until the first flush; the rest is the pack.
    let off = 0;
    const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
    try {
      while (off < body.length) {
        const head = body.subarray(off, off + 4).toString('utf8');
        if (head === '0000') {
          off += 4;
          break;
        }
        const len = parseInt(head, 16);
        if (Number.isNaN(len) || len < 4 || off + len > body.length) return badRequest('bad pkt-line in push');
        const line = body.subarray(off + 4, off + len).toString('utf8').replace(/\n$/, '');
        const nul = line.indexOf('\0');
        const cmd = nul >= 0 ? line.slice(0, nul) : line;
        const parts = cmd.split(' ');
        if (parts.length !== 3 || !isOid(parts[0]) || !isOid(parts[1]) || !parts[2].startsWith('refs/')) {
          return badRequest(`bad push command: ${JSON.stringify(cmd.slice(0, 60))}`);
        }
        commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
        off += len;
      }
    } catch (e) {
      return badRequest(`bad push stream: ${(e as Error).message}`);
    }
    if (commands.length === 0) return badRequest('no push commands');
    const updatesRef = commands.some((c) => c.newOid !== ZERO_OID);
    const packBytes = body.subarray(off);
    const report: string[] = [];
    if (updatesRef) {
      if (packBytes.length < 12) {
        report.push('unpack error');
      } else {
        try {
          const checksum = verifyPackChecksum(packBytes);
          if (!checksum.ok) throw new Error('pack checksum mismatch');
          const read = readPack(packBytes, (oid) => repo.objects.get(oid));
          for (const [oid, obj] of read.objects) {
            if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
          }
          report.push('unpack ok');
        } catch (e) {
          report.push(`unpack error: ${(e as Error).message}`);
        }
      }
    } else {
      report.push('unpack ok');
    }
    const unpackOk = report[0] === 'unpack ok';
    for (const cmd of commands) {
      if (!unpackOk) {
        report.push(`ng ${cmd.ref} unpack failed`);
        continue;
      }
      if (cmd.newOid === ZERO_OID) {
        // delete
        const current = repo.refs.get(cmd.ref);
        if (current === undefined) {
          report.push(`ng ${cmd.ref} ref does not exist`);
        } else if (current !== cmd.oldOid) {
          report.push(`ng ${cmd.ref} non-fast-forward`);
        } else {
          repo.refs.delete(cmd.ref);
          report.push(`ok ${cmd.ref}`);
        }
        continue;
      }
      const newObj = repo.objects.get(cmd.newOid);
      if (!newObj) {
        report.push(`ng ${cmd.ref} object not found`);
        continue;
      }
      const current = repo.refs.get(cmd.ref);
      if (current === undefined) {
        if (cmd.oldOid !== ZERO_OID) {
          report.push(`ng ${cmd.ref} non-fast-forward`);
          continue;
        }
        repo.refs.set(cmd.ref, cmd.newOid);
        report.push(`ok ${cmd.ref}`);
      } else if (current !== cmd.oldOid) {
        report.push(`ng ${cmd.ref} non-fast-forward`);
      } else if (!isFastForward(repo, cmd.oldOid, cmd.newOid)) {
        report.push(`ng ${cmd.ref} non-fast-forward`);
      } else {
        repo.refs.set(cmd.ref, cmd.newOid);
        report.push(`ok ${cmd.ref}`);
      }
    }
    const reportText = report.map((r) => `${r}\n`).join('');
    const payload = Buffer.concat([Buffer.from([1]), Buffer.from(reportText, 'utf8')]);
    const head = Buffer.from((payload.length + 4).toString(16).padStart(4, '0'), 'utf8');
    return {
      status: 200,
      headers: { 'content-type': RECEIVE_RESULT },
      body: Buffer.concat([head, payload, FLUSH]),
    };
  }

  return notFound();
}
