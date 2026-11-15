// Git smart-HTTP: the advertisement (v0 and protocol v2), ls-refs, upload-pack fetch (v2, with
// shallow/deepen) and receive-pack push (v0 with report-status). The wire shapes here are the
// ones the suite's own git client parses: v2 fetch answers in delimited sections
// (acknowledgments, shallow-info, packfile) with the pack sideband-framed in band 1, and a push
// answers its per-ref ok/ng report sideband-framed the same way.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  buildPack,
  getCommit,
  isAncestor,
  isOid,
  parsePktLines,
  peelToCommit,
  pktLine,
  readObject,
  selectFetchObjects,
  sha1Hex,
  unpackPack,
  type FetchRequestShape,
} from './git.ts';
import type { RepoRec } from './store.ts';

export const AGENT = 'asu-forge/1.0';

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-cache, max-age=0, must-revalidate',
    expires: 'Fri, 01 Jan 1980 00:00:00 GMT',
    pragma: 'no-cache',
  });
  res.end(body);
}

function sortedRefNames(repo: RepoRec): string[] {
  return [...repo.refs.keys()].sort();
}

/** The default branch's current tip, or null when the repository is still unborn. */
export function headTarget(repo: RepoRec): { ref: string; oid: string | null } {
  const ref = `refs/heads/${repo.defaultBranch}`;
  return { ref, oid: repo.refs.get(ref) ?? null };
}

// ---------------------------------------------------------------------------------------------
// Advertisements

function v0Advertisement(repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const preamble = pktLine(`# service=${service}\n`);
  const caps =
    service === 'git-upload-pack'
      ? `multi_ack_detailed no-done side-band-64k thin-pack ofs-delta agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const lines: Buffer[] = [];
  const names = sortedRefNames(repo);
  if (names.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}`));
  } else {
    let first = true;
    const head = headTarget(repo);
    if (head.oid !== null) {
      lines.push(pktLine(`${head.oid} HEAD\0${caps}`));
      first = false;
    }
    for (const name of names) {
      const oid = repo.refs.get(name)!;
      lines.push(pktLine(first ? `${oid} ${name}\0${caps}` : `${oid} ${name}`));
      first = false;
    }
  }
  return Buffer.concat([preamble, PKT_FLUSH, ...lines, PKT_FLUSH]);
}

function v2Advertisement(): Buffer {
  const lines = ['version 2', `agent=${AGENT}`, 'ls-refs=unborn', 'fetch=shallow', 'object-format=sha1'];
  return Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
}

export function handleInfoRefs(res: ServerResponse, repo: RepoRec, service: string, protocolV2: boolean): void {
  if (service === 'git-upload-pack') {
    if (protocolV2) {
      sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', v2Advertisement());
    } else {
      sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', v0Advertisement(repo, 'git-upload-pack'));
    }
    return;
  }
  if (service === 'git-receive-pack') {
    sendBuffer(res, 200, 'application/x-git-receive-pack-advertisement', v0Advertisement(repo, 'git-receive-pack'));
    return;
  }
  sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('unknown service\n'));
}

// ---------------------------------------------------------------------------------------------
// ls-refs (protocol v2)

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function handleLsRefs(res: ServerResponse, repo: RepoRec, args: LsRefsArgs): void {
  const matches = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const head = headTarget(repo);
  if (matches('HEAD')) {
    if (head.oid !== null) {
      lines.push(args.symrefs ? `${head.oid} HEAD symref-target:${head.ref}` : `${head.oid} HEAD`);
    } else if (args.unborn) {
      lines.push(args.symrefs ? `unborn HEAD symref-target:${head.ref}` : 'unborn HEAD');
    }
  }
  for (const name of sortedRefNames(repo)) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name)!;
    let line = `${oid} ${name}`;
    if (args.peel) {
      const object = readObject(repo, oid);
      if (object !== null && object.type === 'tag') {
        const peeled = peelFully(repo, oid);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
    }
    lines.push(line);
  }
  const body = Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', body);
}

function peelFully(repo: RepoRec, sha: string): string | null {
  return peelToCommit(repo, sha);
}

// ---------------------------------------------------------------------------------------------
// upload-pack (protocol v2): fetch

interface FetchArgs extends FetchRequestShape {
  done: boolean;
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  // A pkt-line's length field (header included) must stay <= 65520: 4 header bytes + 1 band
  // byte leaves 65515 bytes of pack per packet.
  const CHUNK = 65515;
  if (pack.length === 0) {
    packets.push(pktLine(Buffer.concat([Buffer.from([1])])));
    return packets;
  }
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(offset + CHUNK, pack.length));
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return packets;
}

function handleFetch(res: ServerResponse, repo: RepoRec, args: FetchArgs): void {
  for (const want of args.wants) {
    if (!isOid(want) || readObject(repo, want) === null) {
      sendBuffer(res, 200, 'application/x-git-upload-pack-result', pktLine(`ERR no such object ${want}\n`));
      return;
    }
  }
  const havesInStore = args.haves.filter((have) => readObject(repo, have) !== null);
  const parts: Buffer[] = [];
  if (!args.done) {
    // A negotiation round: only the acknowledgments section (git's own upload-pack sends no
    // acknowledgments at all once the client says done, and real git refuses them then).
    parts.push(pktLine('acknowledgments\n'));
    if (havesInStore.length === 0) {
      parts.push(pktLine('NAK\n'));
    } else {
      for (const have of havesInStore) parts.push(pktLine(`ACK ${have}\n`));
    }
    parts.push(PKT_FLUSH);
    sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
    return;
  }
  const signature = sha1Hex(
    Buffer.from(
      JSON.stringify([
        [...args.wants].sort(),
        [...args.haves].sort(),
        [...args.clientShallows].sort(),
        args.deepen,
        args.deepenSince,
        [...args.deepenNot].sort(),
      ]),
      'utf8',
    ),
  );
  let cached = repo.fetchCache.get(signature);
  if (cached === undefined) {
    const selection = selectFetchObjects(repo, args);
    cached = { pack: buildPack(selection.objects), shallow: selection.shallow, unshallow: selection.unshallow };
    if (repo.fetchCache.size > 128) repo.fetchCache.clear();
    repo.fetchCache.set(signature, cached);
  }
  if (cached.shallow.length > 0 || cached.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const sha of cached.shallow) parts.push(pktLine(`shallow ${sha}\n`));
    for (const sha of cached.unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(cached.pack));
  parts.push(PKT_FLUSH);
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

/** POST /git-upload-pack: dispatch on the v2 command in the first pkt-line. */
export function handleUploadPack(res: ServerResponse, repo: RepoRec, body: Buffer): void {
  let packets;
  try {
    packets = parsePktLines(body).packets;
  } catch {
    sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('malformed pkt-line request\n'));
    return;
  }
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  const commandLine = lines[0] ?? '';
  if (commandLine === 'command=ls-refs') {
    const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    for (const line of lines.slice(1)) {
      if (line === 'peel') args.peel = true;
      else if (line === 'symrefs') args.symrefs = true;
      else if (line === 'unborn') args.unborn = true;
      else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
    }
    handleLsRefs(res, repo, args);
    return;
  }
  if (commandLine === 'command=fetch') {
    const args: FetchArgs = { wants: [], haves: [], clientShallows: [], deepen: null, deepenSince: null, deepenNot: [], done: false };
    for (const line of lines.slice(1)) {
      if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) args.clientShallows.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) args.deepen = Number(line.slice(7).trim());
      else if (line.startsWith('deepen-since ')) args.deepenSince = Number(line.slice(13).trim());
      else if (line.startsWith('deepen-not ')) args.deepenNot.push(line.slice(11).trim());
      else if (line === 'done') args.done = true;
    }
    handleFetch(res, repo, args);
    return;
  }
  sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('unknown command\n'));
}

// ---------------------------------------------------------------------------------------------
// receive-pack (protocol v0): push

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function validatePush(repo: RepoRec, command: PushCommand): string | null {
  const { oldOid, newOid, ref } = command;
  if (!ref.startsWith('refs/') || ref.includes('..') || ref.includes('//')) return 'invalid ref name';
  const current = repo.refs.get(ref) ?? null;
  if (newOid === ZERO_OID) {
    // delete
    if (current === null) return 'reference does not exist';
    if (oldOid !== ZERO_OID && current !== oldOid) return 'stale info';
    return null;
  }
  const object = readObject(repo, newOid);
  if (object === null) return 'missing object';
  if (oldOid === ZERO_OID) {
    if (current !== null && current !== newOid) return 'reference already exists';
    if (ref.startsWith('refs/heads/') && object.type !== 'commit') return 'not a commit';
    return null;
  }
  if (current === null) return 'reference does not exist';
  if (current !== oldOid) return 'stale info';
  if (ref.startsWith('refs/heads/')) {
    if (object.type !== 'commit') return 'not a commit';
    if (!isAncestor(repo, oldOid, newOid)) return 'non-fast-forward';
  }
  return null;
}

function applyPush(repo: RepoRec, command: PushCommand): void {
  if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
  else repo.refs.set(command.ref, command.newOid);
}

export async function handleReceivePack(res: ServerResponse, repo: RepoRec, body: Buffer): Promise<void> {
  let parsed;
  try {
    parsed = parsePktLines(body);
  } catch {
    sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('malformed pkt-line request\n'));
    return;
  }
  const commands: PushCommand[] = [];
  let capabilities = new Set<string>();
  let first = true;
  for (const packet of parsed.packets) {
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (first) {
      first = false;
      const nul = text.indexOf('\0');
      if (nul !== -1) {
        capabilities = new Set(text.slice(nul + 1).split(' ').filter(Boolean));
        text = text.slice(0, nul);
      }
    }
    const parts = text.split(' ');
    if (parts.length !== 3 || !isOid(parts[0]!) || !isOid(parts[1]!)) {
      sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('malformed ref command\n'));
      return;
    }
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  const rest = body.subarray(parsed.end);
  const wantsPack = commands.some((command) => command.newOid !== ZERO_OID);
  let unpackError: string | null = null;
  if (wantsPack) {
    if (rest.length === 0) {
      unpackError = 'no packfile sent';
    } else {
      try {
        unpackPack(repo, rest);
      } catch (error) {
        unpackError = error instanceof Error ? error.message : 'unpack failed';
      }
    }
  }
  const reportLines: string[] = [unpackError === null ? 'unpack ok' : `unpack ${unpackError}`];
  for (const command of commands) {
    if (unpackError !== null) {
      reportLines.push(`ng ${command.ref} unpacker error`);
      continue;
    }
    const problem = validatePush(repo, command);
    if (problem !== null) {
      reportLines.push(`ng ${command.ref} ${problem}`);
    } else {
      applyPush(repo, command);
      reportLines.push(`ok ${command.ref}`);
    }
  }
  if (!capabilities.has('report-status') && !capabilities.has('report-status-v2')) {
    sendBuffer(res, 200, 'application/x-git-receive-pack-result', Buffer.alloc(0));
    return;
  }
  const inner = Buffer.concat(reportLines.map((line) => pktLine(`${line}\n`)));
  if (capabilities.has('side-band-64k')) {
    // The report stream inside band 1 is itself pkt-line framed and ends with its own flush,
    // which real git waits for before it trusts the report.
    const framed = Buffer.concat([
      pktLine(Buffer.concat([Buffer.from([1]), inner, PKT_FLUSH])),
      PKT_FLUSH,
    ]);
    sendBuffer(res, 200, 'application/x-git-receive-pack-result', framed);
  } else {
    sendBuffer(res, 200, 'application/x-git-receive-pack-result', Buffer.concat([inner, PKT_FLUSH]));
  }
}

export type { IncomingMessage };
