// The forge's in-memory store: users, repositories, git objects, refs, issues, pull requests,
// labels and comments. One process, one store, no persistence — every trial boots a fresh pod,
// and the four graded surfaces (git smart-HTTP, REST, GraphQL, MCP) all read and write here, so
// an object created over one surface is the same object over every other.

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObjectRec {
  type: GitObjectType;
  /** The object's raw content bytes (for a commit/tag: the text payload; for a tree: the binary entries). */
  data: Buffer;
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorTime: number;
  committerName: string;
  committerEmail: string;
  committerTime: number;
  message: string;
}

export interface LabelRec {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface CommentRec {
  id: number;
  body: string;
  author: string;
  createdAt: string;
  updatedAt: string;
}

export interface IssueRec {
  kind: 'issue';
  /** Global record id: stable across surfaces, backs the REST `id` and the GraphQL global id. */
  recId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labelNames: string[];
  comments: CommentRec[];
  author: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface PullRec {
  kind: 'pull';
  recId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  /** The branch tips captured when the pull request was opened (refreshed on read, like GitHub). */
  headSha: string;
  baseSha: string;
  author: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export type ItemRec = IssueRec | PullRec;

export interface RepoRec {
  /** The numeric database id (REST `id`, GraphQL `databaseId`). */
  id: number;
  owner: string;
  name: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  objects: Map<string, GitObjectRec>;
  /** Full ref name (`refs/heads/main`) to object id. HEAD is symbolic to the default branch. */
  refs: Map<string, string>;
  /** Issues and pull requests share one number space per repository, as on GitHub. */
  items: Map<number, ItemRec>;
  labels: Map<string, LabelRec>;
  nextNumber: number;
  createdAt: string;
  updatedAt: string;
  commitCache: Map<string, ParsedCommit>;
  /** Memoized fetch answers (pack + shallow info) by request signature: the clone workload
   *  asks for the same depth-1 pack fifty times concurrently. */
  fetchCache: Map<string, { pack: Buffer; shallow: string[]; unshallow: string[] }>;
}

/** The one identity the trial's bearer token names. */
export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export class Store {
  repos = new Map<string, RepoRec>();
  private repoSeq = 0;
  private recSeq = 0;
  private labelSeq = 0;
  private orderSeq = 0;

  nextRepoId(): number {
    this.repoSeq += 1;
    return this.repoSeq;
  }

  nextRecId(): number {
    this.recSeq += 1;
    return this.recSeq;
  }

  nextLabelId(): number {
    this.labelSeq += 1;
    return this.labelSeq;
  }

  nextSeq(): number {
    this.orderSeq += 1;
    return this.orderSeq;
  }

  createRepo(owner: string, name: string, init: { private: boolean; description: string }): RepoRec {
    const ts = nowIso();
    const repo: RepoRec = {
      id: this.nextRepoId(),
      owner,
      name,
      private: init.private,
      description: init.description,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      items: new Map(),
      labels: new Map(),
      nextNumber: 1,
      createdAt: ts,
      updatedAt: ts,
      commitCache: new Map(),
      fetchCache: new Map(),
    };
    this.repos.set(repoKey(owner, name), repo);
    return repo;
  }

  getRepo(owner: string, name: string): RepoRec | null {
    return this.repos.get(repoKey(owner, name)) ?? null;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(repoKey(owner, name));
  }

  listRepos(owner: string): RepoRec[] {
    const out: RepoRec[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  /** Find any record (repository, issue, pull request, comment) by its global record id. */
  findRepoById(id: number): RepoRec | null {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return null;
  }

  findItemByRecId(recId: number): { repo: RepoRec; item: ItemRec } | null {
    for (const repo of this.repos.values()) {
      for (const item of repo.items.values()) {
        if (item.recId === recId) return { repo, item };
      }
    }
    return null;
  }

  findCommentByRecId(recId: number): { repo: RepoRec; item: ItemRec; comment: CommentRec } | null {
    for (const repo of this.repos.values()) {
      for (const item of repo.items.values()) {
        for (const comment of item.comments) {
          if (comment.id === recId) return { repo, item, comment };
        }
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Global (Relay) ids: base64 of `<Type>:<numeric id>`. Opaque, stable across reads, and never the
// plain numeric id rendered as a string (the suite checks both properties).

/** Memoized: a global id is a pure function of (type, number) and serializers call it for
 *  the same ids on every read — the base64 round-trip is pure overhead after the first. */
const globalIdCache = new Map<string, string>();

export function globalId(type: string, numericId: number): string {
  const key = `${type}:${numericId}`;
  const cached = globalIdCache.get(key);
  if (cached !== undefined) return cached;
  const id = Buffer.from(key, 'utf8').toString('base64');
  globalIdCache.set(key, id);
  return id;
}

export function parseGlobalId(id: string): { type: string; numericId: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    const numericId = Number(text.slice(colon + 1));
    if (!Number.isInteger(numericId) || numericId <= 0) return null;
    return { type: text.slice(0, colon), numericId };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Issue / pull request creation, shared by REST, GraphQL and MCP so numbering and shapes agree.

export function createIssueRec(store: Store, repo: RepoRec, init: { title: string; body: string; labelNames?: string[] }): IssueRec {
  const ts = nowIso();
  const issue: IssueRec = {
    kind: 'issue',
    recId: store.nextRecId(),
    number: repo.nextNumber,
    title: init.title,
    body: init.body,
    state: 'open',
    labelNames: [...(init.labelNames ?? [])],
    comments: [],
    author: VIEWER.login,
    seq: store.nextSeq(),
    createdAt: ts,
    updatedAt: ts,
    closedAt: null,
  };
  repo.nextNumber += 1;
  repo.items.set(issue.number, issue);
  repo.updatedAt = ts;
  return issue;
}

export function createPullRec(
  store: Store,
  repo: RepoRec,
  init: { title: string; body: string; headRef: string; baseRef: string; headSha: string; baseSha: string },
): PullRec {
  const ts = nowIso();
  const pull: PullRec = {
    kind: 'pull',
    recId: store.nextRecId(),
    number: repo.nextNumber,
    title: init.title,
    body: init.body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: init.headRef,
    baseRef: init.baseRef,
    headSha: init.headSha,
    baseSha: init.baseSha,
    author: VIEWER.login,
    seq: store.nextSeq(),
    createdAt: ts,
    updatedAt: ts,
    closedAt: null,
  };
  repo.nextNumber += 1;
  repo.items.set(pull.number, pull);
  repo.updatedAt = ts;
  return pull;
}

export function addCommentRec(store: Store, repo: RepoRec, item: ItemRec, body: string): CommentRec {
  const ts = nowIso();
  const comment: CommentRec = { id: store.nextRecId(), body, author: VIEWER.login, createdAt: ts, updatedAt: ts };
  item.comments.push(comment);
  item.updatedAt = ts;
  repo.updatedAt = ts;
  return comment;
}

/** Issues only (pull requests live in the same map but are not issues). */
export function listIssues(repo: RepoRec): IssueRec[] {
  const out: IssueRec[] = [];
  for (const item of repo.items.values()) if (item.kind === 'issue') out.push(item);
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

export function listPulls(repo: RepoRec): PullRec[] {
  const out: PullRec[] = [];
  for (const item of repo.items.values()) if (item.kind === 'pull') out.push(item);
  out.sort((a, b) => a.seq - b.seq);
  return out;
}
