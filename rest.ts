// The GitHub REST v3 surface: repositories, branches, commits, git refs, contents, labels,
// issues, comments and pull requests. The wire discipline the suite's protocol checks enforce
// lives here: every answer is application/json (errors included, always with a string
// `message`), unknown routes are 404 JSON, a malformed JSON body is 400, and a repository that
// belongs to another login is 404, never 403.

import type { ServerResponse } from 'node:http';
import {
  blobAtPath,
  buildCommitData,
  buildTreeFromFlat,
  diffCommits,
  flatTreeOf,
  formatIdentity,
  getCommit,
  isOid,
  listCommits,
  mergeBase,
  parseTree,
  peelToCommit,
  setTreePath,
  threeWayMerge,
  treeAtPath,
  writeObject,
  type FileChange,
} from './git.ts';
import {
  VIEWER,
  addCommentRec,
  createIssueRec,
  createPullRec,
  globalId,
  listIssues,
  listPulls,
  nowIso,
  type CommentRec,
  type IssueRec,
  type LabelRec,
  type PullRec,
  type RepoRec,
  type Store,
} from './store.ts';

export interface RestRequest {
  method: string;
  /** Path segments after /api/v3, each percent-decoded. */
  segments: string[];
  query: URLSearchParams;
  body: Buffer;
  host: string;
}

type Json = Record<string, unknown>;

export function sendJson(res: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'x-oauth-scopes': 'repo, read:org',
    'x-accepted-oauth-scopes': 'repo, read:org',
    ...extraHeaders,
  });
  res.end(body);
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message, documentation_url: 'https://docs.github.com/rest' });
}

export function parseBodyJson(body: Buffer): { ok: true; value: Json } | { ok: false } {
  if (body.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(body.toString('utf8')) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: true, value: {} };
    return { ok: true, value: value as Json };
  } catch {
    return { ok: false };
  }
}

function stringField(value: Json, key: string): string | undefined {
  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}

function boolField(value: Json, key: string): boolean | undefined {
  const field = value[key];
  return typeof field === 'boolean' ? field : undefined;
}

// ---------------------------------------------------------------------------------------------
// Serializers (one shape per object, shared by every handler and by the MCP tools)

export function userJson(login: string): Json {
  return {
    login,
    id: VIEWER.id,
    node_id: globalId('User', VIEWER.id),
    type: 'User',
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
  };
}

export function repoJson(repo: RepoRec): Json {
  let openIssues = 0;
  for (const item of repo.items.values()) if (item.state === 'open') openIssues += 1;
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner),
    private: repo.private,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: openIssues,
    has_issues: true,
    has_projects: false,
    has_downloads: false,
    has_wiki: false,
    has_pages: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

export function labelJson(label: LabelRec): Json {
  return {
    id: label.id,
    node_id: globalId('Label', label.id),
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
    url: '',
  };
}

export function labelsJson(repo: RepoRec, names: string[]): Json[] {
  const out: Json[] = [];
  for (const name of names) {
    const label = repo.labels.get(name);
    if (label !== undefined) out.push(labelJson(label));
    else out.push({ id: 0, node_id: '', name, color: 'ededed', description: '', default: false, url: '' });
  }
  return out;
}

export function commentJson(repo: RepoRec, item: { number: number }, comment: CommentRec): Json {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', comment.id),
    body: comment.body,
    user: userJson(comment.author),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/issues/${item.number}#issuecomment-${comment.id}`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${item.number}`,
    author_association: 'OWNER',
  };
}

export function issueJson(repo: RepoRec, issue: IssueRec): Json {
  return {
    id: issue.recId,
    node_id: globalId('Issue', issue.recId),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: labelsJson(repo, issue.labelNames),
    user: userJson(issue.author),
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    author_association: 'OWNER',
  };
}

/** A pull request rendered in the issue shape (GitHub serves PRs through the issues API too). */
export function pullAsIssueJson(repo: RepoRec, pull: PullRec): Json {
  const base = issueJson(repo, {
    kind: 'issue',
    recId: pull.recId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    labelNames: [],
    comments: pull.comments,
    author: pull.author,
    seq: pull.seq,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    closedAt: pull.closedAt,
  });
  base.pull_request = {
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    merged_at: pull.mergedAt,
  };
  return base;
}

export function branchTip(repo: RepoRec, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

export function pullJson(repo: RepoRec, pull: PullRec): Json {
  const headSha = branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseSha = branchTip(repo, pull.baseRef) ?? pull.baseSha;
  const repoRef = repoJson(repo);
  return {
    id: pull.recId,
    node_id: globalId('PullRequest', pull.recId),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userJson(pull.author),
    labels: [],
    draft: false,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    merged_at: pull.mergedAt,
    merged: pull.merged,
    merge_commit_sha: pull.mergeCommitSha,
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: headSha,
      user: userJson(repo.owner),
      repo: repoRef,
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: baseSha,
      user: userJson(repo.owner),
      repo: repoRef,
    },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    author_association: 'OWNER',
  };
}

export function commitJson(repo: RepoRec, sha: string): Json | null {
  const commit = getCommit(repo, sha);
  if (commit === null) return null;
  const dateOf = (time: number): string => new Date(time * 1000).toISOString();
  return {
    sha,
    node_id: globalId('Commit', 0) + sha,
    commit: {
      author: { name: commit.authorName, email: commit.authorEmail, date: dateOf(commit.authorTime) },
      committer: { name: commit.committerName, email: commit.committerEmail, date: dateOf(commit.committerTime) },
      message: commit.message,
      tree: { sha: commit.tree, url: '' },
      comment_count: 0,
    },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/commit/${sha}`,
    author: userJson(commit.authorName === VIEWER.name ? VIEWER.login : VIEWER.login),
    committer: userJson(VIEWER.login),
    parents: commit.parents.map((parent) => ({ sha: parent, url: '', html_url: '' })),
  };
}

// ---------------------------------------------------------------------------------------------
// Pagination (page/per_page with GitHub's Link header discipline)

interface Page<T> {
  items: T[];
  link: string | null;
}

function paginate<T>(req: RestRequest, path: string, all: T[]): Page<T> {
  const perPageRaw = Number(req.query.get('per_page'));
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(Math.trunc(perPageRaw), 100) : 30;
  const pageRaw = Number(req.query.get('page'));
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  const start = (page - 1) * perPage;
  const items = all.slice(start, start + perPage);
  const lastPage = Math.max(1, Math.ceil(all.length / perPage));
  const origin = `http://${req.host}`;
  const urlFor = (p: number): string => `${origin}${path}?page=${p}&per_page=${perPage}`;
  const links: string[] = [];
  if (page < lastPage) {
    links.push(`<${urlFor(page + 1)}>; rel="next"`);
    links.push(`<${urlFor(lastPage)}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${urlFor(1)}>; rel="first"`);
    links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  }
  return { items, link: links.length > 0 ? links.join(', ') : null };
}

function sendList<T>(res: ServerResponse, req: RestRequest, path: string, all: T[], map: (item: T) => Json): void {
  const page = paginate(req, path, all);
  const headers: Record<string, string> = {};
  if (page.link !== null) headers.link = page.link;
  sendJson(res, 200, page.items.map(map), headers);
}

// ---------------------------------------------------------------------------------------------
// Repositories and the viewer

function handleCreateRepo(store: Store, req: RestRequest, res: ServerResponse): void {
  const parsed = parseBodyJson(req.body);
  if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
  const name = stringField(parsed.value, 'name');
  if (name === undefined || name === '') return sendError(res, 422, 'Validation Failed: name is required');
  if (store.getRepo(VIEWER.login, name) !== null) {
    return sendError(res, 422, 'Validation Failed: name already exists on this account');
  }
  const repo = store.createRepo(VIEWER.login, name, {
    private: boolField(parsed.value, 'private') ?? false,
    description: stringField(parsed.value, 'description') ?? '',
  });
  const defaultBranch = stringField(parsed.value, 'default_branch');
  if (defaultBranch !== undefined && defaultBranch !== '') repo.defaultBranch = defaultBranch;
  return sendJson(res, 201, repoJson(repo));
}

function handleRepoItem(store: Store, req: RestRequest, res: ServerResponse, repo: RepoRec): void {
  if (req.method === 'GET') return sendJson(res, 200, repoJson(repo));
  if (req.method === 'DELETE') {
    store.deleteRepo(repo.owner, repo.name);
    res.writeHead(204, { 'x-oauth-scopes': 'repo, read:org' });
    res.end();
    return;
  }
  if (req.method === 'PATCH') {
    const parsed = parseBodyJson(req.body);
    if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
    const description = stringField(parsed.value, 'description');
    if (description !== undefined) repo.description = description;
    const priv = boolField(parsed.value, 'private');
    if (priv !== undefined) repo.private = priv;
    const defaultBranch = stringField(parsed.value, 'default_branch');
    if (defaultBranch !== undefined && defaultBranch !== '') repo.defaultBranch = defaultBranch;
    const newName = stringField(parsed.value, 'name');
    if (newName !== undefined && newName !== '' && newName !== repo.name) {
      store.repos.delete(`${repo.owner}/${repo.name}`);
      repo.name = newName;
      store.repos.set(`${repo.owner}/${repo.name}`, repo);
    }
    repo.updatedAt = nowIso();
    return sendJson(res, 200, repoJson(repo));
  }
  return sendError(res, 404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// Branches, commits, git refs

function handleBranches(req: RestRequest, res: ServerResponse, repo: RepoRec, rest: string[]): void {
  if (rest.length === 1 && req.method === 'GET') {
    const branches: Json[] = [];
    for (const [ref, sha] of repo.refs) {
      if (!ref.startsWith('refs/heads/')) continue;
      branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha, url: '' }, protected: false });
    }
    branches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return sendJson(res, 200, branches);
  }
  if (rest.length >= 2 && req.method === 'GET') {
    const name = rest.slice(1).join('/');
    const sha = branchTip(repo, name);
    if (sha === null) return sendError(res, 404, 'Branch not found');
    return sendJson(res, 200, { name, commit: { sha, url: '' }, protected: false, _links: {} });
  }
  return sendError(res, 404, 'Not Found');
}

export function resolveRefToCommit(repo: RepoRec, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch !== undefined) return branch;
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag !== undefined) return tag;
  const anyRef = repo.refs.get(ref);
  if (anyRef !== undefined) return anyRef;
  if (isOid(ref)) {
    const object = repo.objects.get(ref);
    if (object !== undefined && (object.type === 'commit' || object.type === 'tag')) return ref;
  }
  return null;
}

function handleCommits(req: RestRequest, res: ServerResponse, repo: RepoRec, rest: string[]): void {
  if (rest.length === 1 && req.method === 'GET') {
    const shaParam = req.query.get('sha') ?? undefined;
    const tip = resolveRefToCommit(repo, shaParam);
    if (tip === null) return sendJson(res, 200, []);
    const start = peelToCommit(repo, tip);
    if (start === null) return sendJson(res, 200, []);
    const shas = listCommits(repo, start, 10_000);
    const mapped: Json[] = [];
    for (const sha of shas) {
      const json = commitJson(repo, sha);
      if (json !== null) mapped.push(json);
    }
    return sendList(res, req, `/api/v3/repos/${repo.owner}/${repo.name}/commits`, mapped, (item) => item);
  }
  if (rest.length === 2 && req.method === 'GET') {
    const json = commitJson(repo, rest[1]!);
    if (json === null) return sendError(res, 404, 'Not Found');
    return sendJson(res, 200, json);
  }
  return sendError(res, 404, 'Not Found');
}

function handleGitRefs(store: Store, req: RestRequest, res: ServerResponse, repo: RepoRec, rest: string[]): void {
  void store;
  // rest: ['git', 'refs', ...refParts]
  if (rest.length === 2 && req.method === 'GET') {
    const refs: Json[] = [];
    for (const [ref, sha] of repo.refs) {
      const object = repo.objects.get(sha);
      refs.push({ ref, node_id: globalId('Ref', repo.id), object: { sha, type: object?.type ?? 'commit', url: '' } });
    }
    refs.sort((a, b) => String(a.ref).localeCompare(String(b.ref)));
    return sendJson(res, 200, refs);
  }
  if (rest.length === 2 && req.method === 'POST') {
    const parsed = parseBodyJson(req.body);
    if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
    const ref = stringField(parsed.value, 'ref');
    const sha = stringField(parsed.value, 'sha');
    if (ref === undefined || sha === undefined || !ref.startsWith('refs/') || !isOid(sha)) {
      return sendError(res, 422, 'Validation Failed: ref and sha are required');
    }
    const object = repo.objects.get(sha);
    if (object === undefined) return sendError(res, 422, 'Validation Failed: object does not exist');
    if (ref.startsWith('refs/heads/') && object.type !== 'commit') return sendError(res, 422, 'Validation Failed: not a commit');
    repo.refs.set(ref, sha);
    repo.updatedAt = nowIso();
    return sendJson(res, 201, { ref, node_id: globalId('Ref', repo.id), object: { sha, type: object.type, url: '' } });
  }
  if (rest.length >= 3) {
    const ref = rest.slice(2).join('/');
    const fullRef = ref.startsWith('refs/') ? ref : `refs/${ref}`;
    if (req.method === 'GET') {
      const sha = repo.refs.get(fullRef);
      if (sha === undefined) return sendError(res, 404, 'Reference not found');
      const object = repo.objects.get(sha);
      return sendJson(res, 200, { ref: fullRef, node_id: globalId('Ref', repo.id), object: { sha, type: object?.type ?? 'commit', url: '' } });
    }
    if (req.method === 'DELETE') {
      if (!repo.refs.delete(fullRef)) return sendError(res, 422, 'Validation Failed: reference does not exist');
      res.writeHead(204, { 'x-oauth-scopes': 'repo, read:org' });
      res.end();
      return;
    }
  }
  return sendError(res, 404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// Contents

function serverCommit(
  repo: RepoRec,
  init: { tree: string; parents: string[]; message: string },
): string {
  const identity = formatIdentity(VIEWER.name, VIEWER.email, Math.floor(Date.now() / 1000));
  const data = buildCommitData({ tree: init.tree, parents: init.parents, author: identity, committer: identity, message: init.message });
  return writeObject(repo, 'commit', data);
}

/** The tip commit a contents write targets, creating the branch when the rules call for it. */
function contentsBranchTip(repo: RepoRec, branch: string): { tip: string | null; exists: boolean } {
  const tip = branchTip(repo, branch);
  if (tip !== null) return { tip, exists: true };
  return { tip: null, exists: false };
}

function handleContents(req: RestRequest, res: ServerResponse, repo: RepoRec, rest: string[]): void {
  const path = rest.slice(1).join('/');
  if (req.method === 'GET') {
    const commitSha = resolveRefToCommit(repo, req.query.get('ref') ?? undefined);
    if (commitSha === null) return sendError(res, 404, 'Not Found');
    const commit = getCommit(repo, peelToCommit(repo, commitSha) ?? commitSha);
    if (commit === null) return sendError(res, 404, 'Not Found');
    if (path === '') {
      const entries = parseTree(repo.objects.get(commit.tree)?.data ?? Buffer.alloc(0));
      return sendJson(res, 200, entries.map((entry) => contentEntryJson(repo, entry, entry.name)));
    }
    const dirTree = treeAtPath(repo, commit.tree, path);
    if (dirTree !== null) {
      const entries = parseTree(repo.objects.get(dirTree)?.data ?? Buffer.alloc(0));
      return sendJson(res, 200, entries.map((entry) => contentEntryJson(repo, entry, `${path}/${entry.name}`)));
    }
    const blob = blobAtPath(repo, commit.tree, path);
    if (blob === null) return sendError(res, 404, 'Not Found');
    const data = repo.objects.get(blob.sha)?.data ?? Buffer.alloc(0);
    return sendJson(res, 200, {
      type: 'file',
      encoding: 'base64',
      size: data.length,
      name: path.split('/').pop() ?? path,
      path,
      sha: blob.sha,
      content: data.toString('base64'),
      url: '',
      git_url: '',
      html_url: '',
      download_url: '',
      _links: {},
    });
  }
  if (req.method === 'PUT' || req.method === 'DELETE') {
    const parsed = parseBodyJson(req.body);
    if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
    const message = stringField(parsed.value, 'message') ?? (req.method === 'PUT' ? 'Create file' : 'Delete file');
    const branch = stringField(parsed.value, 'branch') ?? repo.defaultBranch;
    const { tip } = contentsBranchTip(repo, branch);
    const parentCommit = tip === null ? null : getCommit(repo, tip);
    const parentTree = parentCommit?.tree ?? null;
    const existing = parentTree === null ? null : blobAtPath(repo, parentTree, path);
    const givenSha = stringField(parsed.value, 'sha');
    if (req.method === 'PUT') {
      const contentB64 = stringField(parsed.value, 'content');
      if (contentB64 === undefined) return sendError(res, 422, 'Validation Failed: content is required');
      if (existing !== null) {
        if (givenSha === undefined) return sendError(res, 422, 'Validation Failed: sha must be supplied when updating');
        if (givenSha !== existing.sha) return sendError(res, 409, `${path} does not match ${givenSha}`);
      } else if (givenSha !== undefined && parentTree !== null) {
        return sendError(res, 404, 'Not Found');
      }
      const data = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
      const blobSha = writeObject(repo, 'blob', data);
      const newTree = setTreePath(repo, parentTree, path, { sha: blobSha, mode: existing?.mode ?? '100644' });
      const commitSha = serverCommit(repo, { tree: newTree, parents: tip === null ? [] : [tip], message });
      repo.refs.set(`refs/heads/${branch}`, commitSha);
      repo.updatedAt = nowIso();
      const status = existing !== null ? 200 : 201;
      return sendJson(res, status, {
        content: {
          name: path.split('/').pop() ?? path,
          path,
          sha: blobSha,
          size: data.length,
          type: 'file',
          encoding: 'base64',
          url: '',
          git_url: '',
          html_url: '',
          download_url: '',
          _links: {},
        },
        commit: commitJson(repo, commitSha)?.commit ? { sha: commitSha, ...pickCommitFields(repo, commitSha) } : { sha: commitSha },
      });
    }
    // DELETE
    if (existing === null) return sendError(res, 404, 'Not Found');
    if (givenSha !== undefined && givenSha !== existing.sha) return sendError(res, 409, `${path} does not match ${givenSha}`);
    const newTree = setTreePath(repo, parentTree, path, null);
    const commitSha = serverCommit(repo, { tree: newTree, parents: tip === null ? [] : [tip], message });
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    repo.updatedAt = nowIso();
    return sendJson(res, 200, { content: null, commit: { sha: commitSha, ...pickCommitFields(repo, commitSha) } });
  }
  return sendError(res, 404, 'Not Found');
}

function pickCommitFields(repo: RepoRec, sha: string): Json {
  const full = commitJson(repo, sha);
  if (full === null) return {};
  return { message: (full.commit as Json).message, author: (full.commit as Json).author, committer: (full.commit as Json).committer, tree: (full.commit as Json).tree, parents: full.parents };
}

function contentEntryJson(repo: RepoRec, entry: { mode: string; name: string; sha: string }, fullPath: string): Json {
  const isDir = entry.mode === '40000' || entry.mode === '040000';
  const object = repo.objects.get(entry.sha);
  return {
    type: isDir ? 'dir' : 'file',
    name: entry.name,
    path: fullPath,
    sha: entry.sha,
    size: isDir ? 0 : (object?.data.length ?? 0),
    url: '',
    git_url: '',
    html_url: '',
    download_url: null,
    _links: {},
  };
}

// ---------------------------------------------------------------------------------------------
// Labels

function handleLabels(store: Store, req: RestRequest, res: ServerResponse, repo: RepoRec, rest: string[]): void {
  if (rest.length === 1 && req.method === 'GET') {
    return sendJson(res, 200, [...repo.labels.values()].map(labelJson));
  }
  if (rest.length === 1 && req.method === 'POST') {
    const parsed = parseBodyJson(req.body);
    if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
    const name = stringField(parsed.value, 'name');
    if (name === undefined || name === '') return sendError(res, 422, 'Validation Failed: name is required');
    if (repo.labels.has(name)) return sendError(res, 422, 'Validation Failed: name already exists');
    const color = (stringField(parsed.value, 'color') ?? 'ededed').replace(/^#/, '');
    const label: LabelRec = { id: store.nextLabelId(), name, color, description: stringField(parsed.value, 'description') ?? '' };
    repo.labels.set(name, label);
    return sendJson(res, 201, labelJson(label));
  }
  if (rest.length === 2) {
    const label = repo.labels.get(rest[1]!);
    if (req.method === 'GET') {
      if (label === undefined) return sendError(res, 404, 'Label not found');
      return sendJson(res, 200, labelJson(label));
    }
    if (req.method === 'DELETE') {
      if (label === undefined) return sendError(res, 404, 'Label not found');
      repo.labels.delete(rest[1]!);
      res.writeHead(204, { 'x-oauth-scopes': 'repo, read:org' });
      res.end();
      return;
    }
    if (req.method === 'PATCH' && label !== undefined) {
      const parsed = parseBodyJson(req.body);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
      const color = stringField(parsed.value, 'color');
      if (color !== undefined) label.color = color.replace(/^#/, '');
      const description = stringField(parsed.value, 'description');
      if (description !== undefined) label.description = description;
      return sendJson(res, 200, labelJson(label));
    }
  }
  return sendError(res, 404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// Issues and comments

function labelNamesFromBody(repo: RepoRec, value: Json): { names: string[] } | { error: string } {
  const raw = value.labels;
  if (raw === undefined) return { names: [] };
  if (!Array.isArray(raw)) return { error: 'labels must be an array' };
  const names: string[] = [];
  for (const entry of raw) {
    const name = typeof entry === 'string' ? entry : entry !== null && typeof entry === 'object' ? stringField(entry as Json, 'name') : undefined;
    if (name === undefined) return { error: 'labels must name labels' };
    if (!repo.labels.has(name)) return { error: `label "${name}" does not exist` };
    names.push(name);
  }
  return { names };
}

function sortItems<T extends { seq: number }>(items: T[], req: RestRequest): T[] {
  const direction = req.query.get('direction') ?? 'desc';
  const sorted = [...items];
  sorted.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  return sorted;
}

function handleIssues(store: Store, req: RestRequest, res: ServerResponse, repo: RepoRec, rest: string[]): void {
  if (rest.length === 1 && req.method === 'GET') {
    const state = req.query.get('state') ?? 'open';
    let issues = listIssues(repo);
    if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
    else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
    const labelFilter = req.query.get('labels');
    if (labelFilter !== null && labelFilter !== '') {
      const wanted = labelFilter.split(',');
      issues = issues.filter((issue) => wanted.every((name) => issue.labelNames.includes(name)));
    }
    return sendList(res, req, `/api/v3/repos/${repo.owner}/${repo.name}/issues`, sortItems(issues, req), (issue) => issueJson(repo, issue));
  }
  if (rest.length === 1 && req.method === 'POST') {
    const parsed = parseBodyJson(req.body);
    if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
    const title = stringField(parsed.value, 'title');
    if (title === undefined) return sendError(res, 422, 'Validation Failed: title is required');
    const labels = labelNamesFromBody(repo, parsed.value);
    if ('error' in labels) return sendError(res, 422, `Validation Failed: ${labels.error}`);
    const issue = createIssueRec(store, repo, { title, body: stringField(parsed.value, 'body') ?? '', labelNames: labels.names });
    return sendJson(res, 201, issueJson(repo, issue));
  }
  if (rest.length >= 2) {
    const number = Number(rest[1]);
    const item = Number.isInteger(number) ? repo.items.get(number) : undefined;
    if (item === undefined) return sendError(res, 404, 'Not Found');
    if (rest.length === 2 && req.method === 'GET') {
      return sendJson(res, 200, item.kind === 'issue' ? issueJson(repo, item) : pullAsIssueJson(repo, item));
    }
    if (rest.length === 2 && req.method === 'PATCH') {
      const parsed = parseBodyJson(req.body);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
      const title = stringField(parsed.value, 'title');
      if (title !== undefined) item.title = title;
      const body = stringField(parsed.value, 'body');
      if (body !== undefined) item.body = body;
      const state = stringField(parsed.value, 'state');
      if (state === 'closed' || state === 'open') {
        item.state = state;
        item.closedAt = state === 'closed' ? nowIso() : null;
      }
      if (item.kind === 'issue' && parsed.value.labels !== undefined) {
        const labels = labelNamesFromBody(repo, parsed.value);
        if ('error' in labels) return sendError(res, 422, `Validation Failed: ${labels.error}`);
        item.labelNames = labels.names;
      }
      item.updatedAt = nowIso();
      return sendJson(res, 200, item.kind === 'issue' ? issueJson(repo, item) : pullAsIssueJson(repo, item));
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (req.method === 'GET') {
        return sendList(res, req, `/api/v3/repos/${repo.owner}/${repo.name}/issues/${item.number}/comments`, item.comments, (comment) => commentJson(repo, item, comment));
      }
      if (req.method === 'POST') {
        const parsed = parseBodyJson(req.body);
        if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
        const body = stringField(parsed.value, 'body');
        if (body === undefined) return sendError(res, 422, 'Validation Failed: body is required');
        const comment = addCommentRec(store, repo, item, body);
        return sendJson(res, 201, commentJson(repo, item, comment));
      }
    }
  }
  return sendError(res, 404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// Pull requests and merging (the merge itself is shared with GraphQL and MCP)

export type MergeMethod = 'merge' | 'squash' | 'rebase';

export type MergeOutcome =
  | { ok: true; sha: string }
  | { ok: false; reason: 'conflict' | 'not-mergeable' | 'already-merged' };

/** Whether a pull request would merge cleanly right now (GraphQL's `mergeable`). */
export function pullMergeable(repo: RepoRec, pull: PullRec): boolean {
  if (pull.state !== 'open') return false;
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return false;
  const base = mergeBase(repo, headTip, baseTip);
  const result = threeWayMerge(flatTreeOf(repo, base), flatTreeOf(repo, headTip), flatTreeOf(repo, baseTip));
  return 'merged' in result;
}

/** The files a pull request changes, measured from its merge base (REST /files, GraphQL files). */
export function pullFiles(repo: RepoRec, pull: PullRec): FileChange[] {
  const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseTip = branchTip(repo, pull.baseRef) ?? pull.baseSha;
  const base = mergeBase(repo, headTip, baseTip);
  return diffCommits(repo, base, headTip);
}

export function mergePullRequest(repo: RepoRec, pull: PullRec, method: MergeMethod): MergeOutcome {
  if (pull.merged) return { ok: false, reason: 'already-merged' };
  if (pull.state !== 'open') return { ok: false, reason: 'not-mergeable' };
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return { ok: false, reason: 'not-mergeable' };
  const base = mergeBase(repo, headTip, baseTip);
  const result = threeWayMerge(flatTreeOf(repo, base), flatTreeOf(repo, headTip), flatTreeOf(repo, baseTip));
  if ('conflict' in result) return { ok: false, reason: 'conflict' };
  const tree = buildTreeFromFlat(repo, result.merged);
  let sha: string;
  if (method === 'merge') {
    sha = serverCommit(repo, {
      tree,
      parents: [baseTip, headTip],
      message: `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`,
    });
  } else if (method === 'rebase') {
    const headCommit = getCommit(repo, headTip);
    sha = serverCommit(repo, { tree, parents: [baseTip], message: headCommit?.message ?? pull.title });
  } else {
    const body = pull.body === '' ? '' : `\n\n${pull.body}`;
    sha = serverCommit(repo, { tree, parents: [baseTip], message: `${pull.title}${body}` });
  }
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  const ts = nowIso();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = ts;
  pull.closedAt = ts;
  pull.mergeCommitSha = sha;
  pull.updatedAt = ts;
  repo.updatedAt = ts;
  return { ok: true, sha };
}

function handlePulls(store: Store, req: RestRequest, res: ServerResponse, repo: RepoRec, rest: string[]): void {
  if (rest.length === 1 && req.method === 'GET') {
    const state = req.query.get('state') ?? 'open';
    let pulls = listPulls(repo);
    if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
    else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
    return sendList(res, req, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`, sortItems(pulls, req), (pull) => pullJson(repo, pull));
  }
  if (rest.length === 1 && req.method === 'POST') {
    const parsed = parseBodyJson(req.body);
    if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
    const title = stringField(parsed.value, 'title');
    const headRaw = stringField(parsed.value, 'head');
    const base = stringField(parsed.value, 'base');
    if (title === undefined || headRaw === undefined || base === undefined) {
      return sendError(res, 422, 'Validation Failed: title, head and base are required');
    }
    const head = headRaw.includes(':') ? headRaw.slice(headRaw.indexOf(':') + 1) : headRaw;
    const headSha = branchTip(repo, head);
    const baseSha = branchTip(repo, base);
    if (headSha === null) return sendError(res, 422, `Validation Failed: head branch "${head}" does not exist`);
    if (baseSha === null) return sendError(res, 422, `Validation Failed: base branch "${base}" does not exist`);
    const existing = listPulls(repo).find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
    if (existing !== undefined) return sendError(res, 422, `Validation Failed: a pull request already exists for ${head} into ${base}`);
    const pull = createPullRec(store, repo, {
      title,
      body: stringField(parsed.value, 'body') ?? '',
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
    });
    return sendJson(res, 201, pullJson(repo, pull));
  }
  if (rest.length >= 2) {
    const number = Number(rest[1]);
    const item = Number.isInteger(number) ? repo.items.get(number) : undefined;
    const pull = item !== undefined && item.kind === 'pull' ? item : undefined;
    if (rest.length === 2 && req.method === 'GET') {
      if (pull === undefined) return sendError(res, 404, 'Not Found');
      return sendJson(res, 200, pullJson(repo, pull));
    }
    if (rest.length === 3 && rest[2] === 'files' && req.method === 'GET') {
      if (pull === undefined) return sendError(res, 404, 'Not Found');
      const files = pullFiles(repo, pull).map((change) => ({
        sha: '',
        filename: change.path,
        status: change.status,
        additions: change.additions,
        deletions: change.deletions,
        changes: change.changes,
      }));
      return sendJson(res, 200, files);
    }
    if (rest.length === 3 && rest[2] === 'merge' && req.method === 'PUT') {
      if (pull === undefined) return sendError(res, 404, 'Not Found');
      const parsed = parseBodyJson(req.body);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
      const methodRaw = stringField(parsed.value, 'merge_method') ?? 'merge';
      const method: MergeMethod = methodRaw === 'squash' ? 'squash' : methodRaw === 'rebase' ? 'rebase' : 'merge';
      const outcome = mergePullRequest(repo, pull, method);
      if (!outcome.ok) return sendError(res, 405, 'Pull Request is not mergeable');
      return sendJson(res, 200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
    }
  }
  return sendError(res, 404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// The router

export function handleRest(store: Store, req: RestRequest, res: ServerResponse): void {
  const segments = req.segments;
  if (segments.length === 0) {
    if (req.method === 'GET') {
      return sendJson(res, 200, {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_search_url: '/api/v3/search/issues',
        emojis_url: '/api/v3/emojis',
        label_search_url: '/api/v3/search/labels',
      });
    }
    return sendError(res, 404, 'Not Found');
  }
  if (segments[0] === 'meta' && segments.length === 1 && req.method === 'GET') {
    return sendJson(res, 200, {
      hook_id: 0,
      hook_config: {},
      github_pages: {},
      importer: {},
      actions: {},
      dependabot: {},
      installed_version: '1.0.0',
      verifiable_password_authentication: false,
    });
  }
  if (segments[0] === 'user' && segments.length === 1 && req.method === 'GET') {
    return sendJson(res, 200, userJson(VIEWER.login));
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (req.method === 'POST') return handleCreateRepo(store, req, res);
    if (req.method === 'GET') {
      return sendList(res, req, '/api/v3/user/repos', store.listRepos(VIEWER.login), (repo) => repoJson(repo));
    }
    return sendError(res, 404, 'Not Found');
  }
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1]!;
    const name = segments[2]!;
    const repo = store.getRepo(owner, name);
    if (repo === null) return sendError(res, 404, 'Not Found');
    const rest = segments.slice(3);
    if (rest.length === 0) return handleRepoItem(store, req, res, repo);
    switch (rest[0]) {
      case 'branches':
        return handleBranches(req, res, repo, rest);
      case 'commits':
        return handleCommits(req, res, repo, rest);
      case 'git':
        if (rest[1] === 'refs') return handleGitRefs(store, req, res, repo, rest);
        return sendError(res, 404, 'Not Found');
      case 'contents':
        return handleContents(req, res, repo, rest);
      case 'labels':
        return handleLabels(store, req, res, repo, rest);
      case 'issues':
        return handleIssues(store, req, res, repo, rest);
      case 'pulls':
        return handlePulls(store, req, res, repo, rest);
      default:
        return sendError(res, 404, 'Not Found');
    }
  }
  return sendError(res, 404, 'Not Found');
}
