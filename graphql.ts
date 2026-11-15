// The GraphQL v4 surface: a small hand-rolled parser, validator and executor over a fixed
// schema — exactly the documents gh and github-mcp-server send (viewer, repository fields, the
// __type feature probes, issue/pull-request reads, the create/close/merge mutations, Relay
// node(id:) and cursor connections), plus GitHub's batching (a JSON array of operations in one
// body). An unknown field is a 200 with an `errors` array naming the field, never an HTTP 400;
// an unknown repository is data.repository = null with no errors.

import type { ServerResponse } from 'node:http';
import { globalId, parseGlobalId, type ItemRec, type PullRec, type RepoRec, type Store } from './store.ts';
import { mergePullRequest, pullFiles, pullMergeable, sendError, sendJson, type MergeMethod } from './rest.ts';
import { addCommentRec, createIssueRec, createPullRec, listIssues, listPulls, nowIso, VIEWER } from './store.ts';
import { branchTip } from './rest.ts';

// ---------------------------------------------------------------------------------------------
// Lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' }
  | { kind: 'eof' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '\ufeff') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('{}()[]:@$=!|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1]!;
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'b') value += '\b';
          else if (esc === 'f') value += '\f';
          else if (esc === '/') value += '/';
          else if (esc === '\\') value += '\\';
          else if (esc === '"') value += '"';
          else if (esc === 'u') {
            value += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else value += esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      const text = source.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number(text) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// Parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selectionSet: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'inline'; typeCondition: string | null; selectionSet: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  selectionSet: SelectionNode[];
}

interface GqlDocument {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): GqlDocument {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', name: null, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error('expected an operation');
      if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.expectName();
        if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseVariableDefinitions();
        this.skipDirectives();
        const selectionSet = this.parseSelectionSet();
        operations.push({ operation: token.value === 'mutation' ? 'mutation' : 'query', name, selectionSet });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const onToken = this.next();
        if (onToken.kind !== 'name' || onToken.value !== 'on') throw new Error('expected "on" in fragment');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected definition ${token.value}`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseTypeRef();
      if (this.skipPunct('=')) this.parseValue();
      this.skipDirectives();
    }
  }

  private parseTypeRef(): void {
    if (this.skipPunct('[')) {
      this.parseTypeRef();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  private parseArguments(): { name: string; value: ValueNode }[] {
    const args: { name: string; value: ValueNode }[] = [];
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.skipPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.skipPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value token');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) selections.push(this.parseSelection());
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'spread') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value !== 'on') {
        return { kind: 'spread', name: this.expectName() };
      }
      let typeCondition: string | null = null;
      if (this.peek().kind === 'name') {
        this.next(); // 'on'
        typeCondition = this.expectName();
      }
      this.skipDirectives();
      return { kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    let args: { name: string; value: ValueNode }[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') args = this.parseArguments();
    this.skipDirectives();
    let selectionSet: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selectionSet };
  }
}

// ---------------------------------------------------------------------------------------------
// Sources: the values resolvers pass around, each tagged with its GraphQL type.

interface Src {
  __typename: string;
  [key: string]: unknown;
}

interface Ctx {
  store: Store;
}

type Resolver = (source: Src, args: Record<string, unknown>, ctx: Ctx) => unknown;

interface FieldDef {
  type: string;
  args?: Record<string, string>;
  resolve: Resolver;
}

interface TypeDef {
  kind: 'OBJECT' | 'ENUM' | 'INPUT_OBJECT' | 'SCALAR' | 'INTERFACE';
  fields?: Record<string, FieldDef>;
  values?: string[];
  inputFields?: Record<string, string>;
}

const userSource = (login: string): Src => ({ __typename: 'User', login });
const repoSource = (repo: RepoRec): Src => ({ __typename: 'Repository', repo });
const issueSource = (repo: RepoRec, issue: ItemRec): Src => ({ __typename: 'Issue', repo, issue });
const pullSource = (repo: RepoRec, pull: PullRec): Src => ({ __typename: 'PullRequest', repo, pull });
const commentSource = (repo: RepoRec, item: ItemRec, comment: { id: number; body: string; author: string; createdAt: string; updatedAt: string }): Src => ({
  __typename: 'IssueComment',
  repo,
  item,
  comment,
});

function cursorFor(seq: number): string {
  return Buffer.from(`cursor:${seq}`, 'utf8').toString('base64');
}

interface ConnItem {
  cursor: string;
  node: Src;
}

/** Build a connection source from ordered items and first/after arguments. */
function connection(type: string, items: ConnItem[], args: Record<string, unknown>): Src {
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : items.length;
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    const index = items.findIndex((item) => item.cursor === args.after);
    if (index !== -1) start = index + 1;
  }
  const page = items.slice(start, start + first);
  return {
    __typename: type,
    nodes: page.map((item) => item.node),
    edges: page.map((item) => ({ __typename: type.replace('Connection', 'Edge'), node: item.node, cursor: item.cursor })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: start + first < items.length,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? page[0]!.cursor : null,
      endCursor: page.length > 0 ? page[page.length - 1]!.cursor : null,
    },
    totalCount: items.length,
  };
}

const connFields = (nodeType: string): Record<string, FieldDef> => ({
  nodes: { type: `[${nodeType}]`, resolve: (s) => s.nodes },
  edges: { type: '[Edge]', resolve: (s) => s.edges },
  pageInfo: { type: 'PageInfo', resolve: (s) => s.pageInfo },
  totalCount: { type: 'Int', resolve: (s) => s.totalCount },
});

function orderIssues(issues: ItemRec[], args: Record<string, unknown>): ItemRec[] {
  const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
  const direction = orderBy?.direction === 'ASC' ? 'ASC' : orderBy?.direction === 'DESC' ? 'DESC' : 'ASC';
  const sorted = [...issues];
  sorted.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
  return sorted;
}

function repoIssuesConnection(repo: RepoRec, args: Record<string, unknown>): Src {
  let issues = listIssues(repo) as ItemRec[];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const ordered = orderIssues(issues, args);
  return connection('IssueConnection', ordered.map((issue) => ({ cursor: cursorFor(issue.seq), node: issueSource(repo, issue) })), args);
}

function repoPullsConnection(repo: RepoRec, args: Record<string, unknown>): Src {
  let pulls = listPulls(repo) as ItemRec[];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state)));
    pulls = pulls.filter((pull) => {
      const p = pull as PullRec;
      const state = p.merged ? 'MERGED' : p.state === 'open' ? 'OPEN' : 'CLOSED';
      return wanted.has(state);
    });
  }
  const ordered = [...pulls].sort((a, b) => a.seq - b.seq);
  return connection('PullRequestConnection', ordered.map((pull) => ({ cursor: cursorFor(pull.seq), node: pullSource(repo, pull as PullRec) })), args);
}

const SCHEMA: Record<string, TypeDef> = {
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  Float: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
  ID: { kind: 'SCALAR' },
  URI: { kind: 'SCALAR' },
  DateTime: { kind: 'SCALAR' },
  GitObjectID: { kind: 'SCALAR' },
  HTML: { kind: 'SCALAR' },
  Base64String: { kind: 'SCALAR' },
  IssueState: { kind: 'ENUM', values: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', values: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', values: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  OrderDirection: { kind: 'ENUM', values: ['ASC', 'DESC'] },
  IssueOrderField: { kind: 'ENUM', values: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  PullRequestOrderField: { kind: 'ENUM', values: ['CREATED_AT', 'UPDATED_AT'] },
  PullRequestMergeMethod: { kind: 'ENUM', values: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', values: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  SearchType: { kind: 'ENUM', values: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  FileStatus: { kind: 'ENUM', values: ['ADDED', 'DELETED', 'MODIFIED', 'CHANGED', 'RENAMED'] },
  Node: { kind: 'INTERFACE', fields: { id: { type: 'ID!', resolve: (s) => s.__globalId } } },
  PageInfo: {
    kind: 'OBJECT',
    fields: {
      hasNextPage: { type: 'Boolean!', resolve: (s) => s.hasNextPage },
      hasPreviousPage: { type: 'Boolean!', resolve: (s) => s.hasPreviousPage },
      startCursor: { type: 'String', resolve: (s) => s.startCursor },
      endCursor: { type: 'String', resolve: (s) => s.endCursor },
    },
  },
  User: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!', resolve: () => globalId('User', VIEWER.id) },
      login: { type: 'String!', resolve: (s) => s.login },
      name: { type: 'String', resolve: () => VIEWER.name },
      email: { type: 'String', resolve: () => VIEWER.email },
      url: { type: 'URI!', resolve: (s) => `https://forge.invalid/${String(s.login)}` },
      avatarUrl: { type: 'URI!', resolve: () => 'https://forge.invalid/avatar.png' },
      isViewer: { type: 'Boolean!', resolve: () => true },
    },
  },
  Ref: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!', resolve: (s) => globalId('Ref', (s.repo as RepoRec).id) },
      name: { type: 'String!', resolve: (s) => s.name },
      prefix: { type: 'String!', resolve: (s) => s.prefix },
      target: { type: 'GitObject', resolve: (s) => ({ __typename: 'Commit', repo: s.repo, sha: s.oid }) },
    },
  },
  Commit: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!', resolve: (s) => globalId('Commit', 0) + String(s.sha) },
      oid: { type: 'GitObjectID!', resolve: (s) => s.sha },
      abbreviatedOid: { type: 'String!', resolve: (s) => String(s.sha).slice(0, 7) },
      message: { type: 'String!', resolve: (s) => '' },
      committedDate: { type: 'DateTime!', resolve: () => nowIso() },
      authoredDate: { type: 'DateTime!', resolve: () => nowIso() },
    },
  },
  Label: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!', resolve: (s) => globalId('Label', (s.label as { id: number }).id) },
      name: { type: 'String!', resolve: (s) => (s.label as { name: string }).name },
      color: { type: 'String!', resolve: (s) => (s.label as { color: string }).color },
      description: { type: 'String', resolve: (s) => (s.label as { description: string }).description },
    },
  },
  IssueComment: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!', resolve: (s) => globalId('IssueComment', (s.comment as { id: number }).id) },
      body: { type: 'String!', resolve: (s) => (s.comment as { body: string }).body },
      author: { type: 'User', resolve: (s) => userSource((s.comment as { author: string }).author) },
      createdAt: { type: 'DateTime!', resolve: (s) => (s.comment as { createdAt: string }).createdAt },
      updatedAt: { type: 'DateTime!', resolve: (s) => (s.comment as { updatedAt: string }).updatedAt },
      url: { type: 'URI!', resolve: () => 'https://forge.invalid/comment' },
    },
  },
};

// ---------------------------------------------------------------------------------------------
// The domain types: Repository, Issue, PullRequest and their connections.

SCHEMA.Repository = {
  kind: 'OBJECT',
  fields: {
    id: { type: 'ID!', resolve: (s) => globalId('Repository', (s.repo as RepoRec).id) },
    databaseId: { type: 'Int!', resolve: (s) => (s.repo as RepoRec).id },
    name: { type: 'String!', resolve: (s) => (s.repo as RepoRec).name },
    nameWithOwner: { type: 'String!', resolve: (s) => `${(s.repo as RepoRec).owner}/${(s.repo as RepoRec).name}` },
    owner: { type: 'User!', resolve: (s) => userSource((s.repo as RepoRec).owner) },
    description: { type: 'String', resolve: (s) => (s.repo as RepoRec).description },
    isPrivate: { type: 'Boolean!', resolve: (s) => (s.repo as RepoRec).private },
    isFork: { type: 'Boolean!', resolve: () => false },
    isArchived: { type: 'Boolean!', resolve: () => false },
    url: { type: 'URI!', resolve: (s) => `https://forge.invalid/${(s.repo as RepoRec).owner}/${(s.repo as RepoRec).name}` },
    createdAt: { type: 'DateTime!', resolve: (s) => (s.repo as RepoRec).createdAt },
    updatedAt: { type: 'DateTime!', resolve: (s) => (s.repo as RepoRec).updatedAt },
    pushedAt: { type: 'DateTime', resolve: (s) => (s.repo as RepoRec).updatedAt },
    stargazerCount: { type: 'Int!', resolve: () => 0 },
    forkCount: { type: 'Int!', resolve: () => 0 },
    viewerPermission: { type: 'RepositoryPermission', resolve: () => 'ADMIN' },
    viewerCanAdminister: { type: 'Boolean!', resolve: () => true },
    hasIssuesEnabled: { type: 'Boolean!', resolve: () => true },
    hasProjectsEnabled: { type: 'Boolean!', resolve: () => false },
    hasWikiEnabled: { type: 'Boolean!', resolve: () => false },
    defaultBranchRef: {
      type: 'Ref',
      resolve: (s) => {
        const repo = s.repo as RepoRec;
        const tip = branchTip(repo, repo.defaultBranch);
        if (tip === null) return null;
        return { __typename: 'Ref', repo, name: repo.defaultBranch, prefix: 'refs/heads/', oid: tip };
      },
    },
    issue: {
      type: 'Issue',
      args: { number: 'Int!' },
      resolve: (s, args) => {
        const repo = s.repo as RepoRec;
        const item = repo.items.get(Number(args.number));
        return item !== undefined && item.kind === 'issue' ? issueSource(repo, item) : null;
      },
    },
    issues: {
      type: 'IssueConnection!',
      args: { first: 'Int', after: 'String', states: '[IssueState!]', orderBy: 'IssueOrder' },
      resolve: (s, args) => repoIssuesConnection(s.repo as RepoRec, args),
    },
    pullRequest: {
      type: 'PullRequest',
      args: { number: 'Int!' },
      resolve: (s, args) => {
        const repo = s.repo as RepoRec;
        const item = repo.items.get(Number(args.number));
        return item !== undefined && item.kind === 'pull' ? pullSource(repo, item) : null;
      },
    },
    pullRequests: {
      type: 'PullRequestConnection!',
      args: { first: 'Int', after: 'String', states: '[PullRequestState!]', orderBy: 'PullRequestOrder' },
      resolve: (s, args) => repoPullsConnection(s.repo as RepoRec, args),
    },
  },
};

SCHEMA.Issue = {
  kind: 'OBJECT',
  fields: {
    id: { type: 'ID!', resolve: (s) => globalId('Issue', (s.issue as ItemRec).recId) },
    number: { type: 'Int!', resolve: (s) => (s.issue as ItemRec).number },
    title: { type: 'String!', resolve: (s) => (s.issue as ItemRec).title },
    body: { type: 'String!', resolve: (s) => (s.issue as ItemRec).body },
    state: { type: 'IssueState!', resolve: (s) => ((s.issue as ItemRec).state === 'open' ? 'OPEN' : 'CLOSED') },
    closed: { type: 'Boolean!', resolve: (s) => (s.issue as ItemRec).state === 'closed' },
    author: { type: 'User', resolve: (s) => userSource((s.issue as ItemRec).author) },
    repository: { type: 'Repository!', resolve: (s) => repoSource(s.repo as RepoRec) },
    url: { type: 'URI!', resolve: (s) => `https://forge.invalid/${(s.repo as RepoRec).owner}/${(s.repo as RepoRec).name}/issues/${(s.issue as ItemRec).number}` },
    createdAt: { type: 'DateTime!', resolve: (s) => (s.issue as ItemRec).createdAt },
    updatedAt: { type: 'DateTime!', resolve: (s) => (s.issue as ItemRec).updatedAt },
    closedAt: { type: 'DateTime', resolve: (s) => (s.issue as ItemRec).closedAt },
    labels: {
      type: 'LabelConnection',
      args: { first: 'Int' },
      resolve: (s, args) => {
        const repo = s.repo as RepoRec;
        const issue = s.issue as ItemRec;
        const names = issue.kind === 'issue' ? issue.labelNames : [];
        const items = names
          .map((name) => repo.labels.get(name))
          .filter((label) => label !== undefined)
          .map((label, index) => ({ cursor: cursorFor(index + 1), node: { __typename: 'Label', repo, label } as Src }));
        return connection('LabelConnection', items, args);
      },
    },
    comments: {
      type: 'IssueCommentConnection',
      args: { first: 'Int' },
      resolve: (s, args) => {
        const repo = s.repo as RepoRec;
        const issue = s.issue as ItemRec;
        const items = issue.comments.map((comment, index) => ({ cursor: cursorFor(index + 1), node: commentSource(repo, issue, comment) }));
        return connection('IssueCommentConnection', items, args);
      },
    },
  },
};

SCHEMA.PullRequest = {
  kind: 'OBJECT',
  fields: {
    id: { type: 'ID!', resolve: (s) => globalId('PullRequest', (s.pull as PullRec).recId) },
    number: { type: 'Int!', resolve: (s) => (s.pull as PullRec).number },
    title: { type: 'String!', resolve: (s) => (s.pull as PullRec).title },
    body: { type: 'String!', resolve: (s) => (s.pull as PullRec).body },
    state: {
      type: 'PullRequestState!',
      resolve: (s) => {
        const pull = s.pull as PullRec;
        return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      },
    },
    merged: { type: 'Boolean!', resolve: (s) => (s.pull as PullRec).merged },
    mergedAt: { type: 'DateTime', resolve: (s) => (s.pull as PullRec).mergedAt },
    mergeCommit: {
      type: 'Commit',
      resolve: (s) => {
        const pull = s.pull as PullRec;
        return pull.mergeCommitSha === null ? null : { __typename: 'Commit', repo: s.repo, sha: pull.mergeCommitSha };
      },
    },
    headRefName: { type: 'String!', resolve: (s) => (s.pull as PullRec).headRef },
    baseRefName: { type: 'String!', resolve: (s) => (s.pull as PullRec).baseRef },
    headRefOid: {
      type: 'GitObjectID!',
      resolve: (s) => {
        const pull = s.pull as PullRec;
        return branchTip(s.repo as RepoRec, pull.headRef) ?? pull.headSha;
      },
    },
    baseRefOid: {
      type: 'GitObjectID!',
      resolve: (s) => {
        const pull = s.pull as PullRec;
        return branchTip(s.repo as RepoRec, pull.baseRef) ?? pull.baseSha;
      },
    },
    mergeable: {
      type: 'MergeableState!',
      resolve: (s) => {
        const pull = s.pull as PullRec;
        if (pull.state !== 'open') return 'UNKNOWN';
        return pullMergeable(s.repo as RepoRec, pull) ? 'MERGEABLE' : 'CONFLICTING';
      },
    },
    author: { type: 'User', resolve: (s) => userSource((s.pull as PullRec).author) },
    repository: { type: 'Repository!', resolve: (s) => repoSource(s.repo as RepoRec) },
    url: { type: 'URI!', resolve: (s) => `https://forge.invalid/${(s.repo as RepoRec).owner}/${(s.repo as RepoRec).name}/pull/${(s.pull as PullRec).number}` },
    createdAt: { type: 'DateTime!', resolve: (s) => (s.pull as PullRec).createdAt },
    updatedAt: { type: 'DateTime!', resolve: (s) => (s.pull as PullRec).updatedAt },
    closedAt: { type: 'DateTime', resolve: (s) => (s.pull as PullRec).closedAt },
    additions: { type: 'Int!', resolve: (s) => pullFiles(s.repo as RepoRec, s.pull as PullRec).reduce((sum, f) => sum + f.additions, 0) },
    deletions: { type: 'Int!', resolve: (s) => pullFiles(s.repo as RepoRec, s.pull as PullRec).reduce((sum, f) => sum + f.deletions, 0) },
    changedFiles: { type: 'Int!', resolve: (s) => pullFiles(s.repo as RepoRec, s.pull as PullRec).length },
    files: {
      type: 'PullRequestChangedFileConnection',
      args: { first: 'Int' },
      resolve: (s, args) => {
        const files = pullFiles(s.repo as RepoRec, s.pull as PullRec);
        const items = files.map((file, index) => ({
          cursor: cursorFor(index + 1),
          node: {
            __typename: 'PullRequestChangedFile',
            path: file.path,
            additions: file.additions,
            deletions: file.deletions,
            changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
          } as Src,
        }));
        return connection('PullRequestChangedFileConnection', items, args);
      },
    },
    comments: {
      type: 'IssueCommentConnection',
      args: { first: 'Int' },
      resolve: (s, args) => {
        const repo = s.repo as RepoRec;
        const pull = s.pull as PullRec;
        const items = pull.comments.map((comment, index) => ({ cursor: cursorFor(index + 1), node: commentSource(repo, pull, comment) }));
        return connection('IssueCommentConnection', items, args);
      },
    },
  },
};

SCHEMA.PullRequestChangedFile = {
  kind: 'OBJECT',
  fields: {
    path: { type: 'String!', resolve: (s) => s.path },
    additions: { type: 'Int!', resolve: (s) => s.additions },
    deletions: { type: 'Int!', resolve: (s) => s.deletions },
    changeType: { type: 'FileStatus!', resolve: (s) => s.changeType },
  },
};

SCHEMA.IssueConnection = { kind: 'OBJECT', fields: connFields('Issue') };
SCHEMA.PullRequestConnection = { kind: 'OBJECT', fields: connFields('PullRequest') };
SCHEMA.PullRequestChangedFileConnection = { kind: 'OBJECT', fields: connFields('PullRequestChangedFile') };
SCHEMA.LabelConnection = { kind: 'OBJECT', fields: connFields('Label') };
SCHEMA.IssueCommentConnection = { kind: 'OBJECT', fields: connFields('IssueComment') };
SCHEMA.IssueEdge = { kind: 'OBJECT', fields: { node: { type: 'Issue', resolve: (s) => s.node }, cursor: { type: 'String!', resolve: (s) => s.cursor } } };
SCHEMA.PullRequestEdge = { kind: 'OBJECT', fields: { node: { type: 'PullRequest', resolve: (s) => s.node }, cursor: { type: 'String!', resolve: (s) => s.cursor } } };
SCHEMA.PullRequestChangedFileEdge = { kind: 'OBJECT', fields: { node: { type: 'PullRequestChangedFile', resolve: (s) => s.node }, cursor: { type: 'String!', resolve: (s) => s.cursor } } };
SCHEMA.LabelEdge = { kind: 'OBJECT', fields: { node: { type: 'Label', resolve: (s) => s.node }, cursor: { type: 'String!', resolve: (s) => s.cursor } } };
SCHEMA.IssueCommentEdge = { kind: 'OBJECT', fields: { node: { type: 'IssueComment', resolve: (s) => s.node }, cursor: { type: 'String!', resolve: (s) => s.cursor } } };

// ---------------------------------------------------------------------------------------------
// Query, Mutation, payloads and introspection.

function findRepoByGlobalId(store: Store, id: unknown): RepoRec | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.type !== 'Repository') return null;
  return store.findRepoById(parsed.numericId);
}

SCHEMA.Query = {
  kind: 'OBJECT',
  fields: {
    viewer: { type: 'User!', resolve: () => userSource(VIEWER.login) },
    repository: {
      type: 'Repository',
      args: { owner: 'String!', name: 'String!' },
      resolve: (s, args, ctx) => {
        const repo = ctx.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo === null ? null : repoSource(repo);
      },
    },
    node: {
      type: 'Node',
      args: { id: 'ID!' },
      resolve: (s, args, ctx) => {
        const parsed = typeof args.id === 'string' ? parseGlobalId(args.id) : null;
        if (parsed === null) return null;
        if (parsed.type === 'Repository') {
          const repo = ctx.store.findRepoById(parsed.numericId);
          return repo === null ? null : repoSource(repo);
        }
        if (parsed.type === 'User') return userSource(VIEWER.login);
        if (parsed.type === 'Issue' || parsed.type === 'PullRequest') {
          const found = ctx.store.findItemByRecId(parsed.numericId);
          if (found === null) return null;
          return found.item.kind === 'issue' ? issueSource(found.repo, found.item) : pullSource(found.repo, found.item);
        }
        if (parsed.type === 'IssueComment') {
          const found = ctx.store.findCommentByRecId(parsed.numericId);
          if (found === null) return null;
          return commentSource(found.repo, found.item, found.comment);
        }
        return null;
      },
    },
    __type: {
      type: '__Type',
      args: { name: 'String!' },
      resolve: (s, args) => {
        const name = String(args.name ?? '');
        return SCHEMA[name] === undefined ? null : { __typename: '__Type', name };
      },
    },
    __schema: {
      type: '__Schema',
      resolve: () => ({ __typename: '__Schema' }),
    },
  },
};

SCHEMA.__Schema = {
  kind: 'OBJECT',
  fields: {
    types: {
      type: '[__Type!]!',
      resolve: () => Object.keys(SCHEMA).map((name) => ({ __typename: '__Type', name })),
    },
    queryType: { type: '__Type!', resolve: () => ({ __typename: '__Type', name: 'Query' }) },
    mutationType: { type: '__Type', resolve: () => ({ __typename: '__Type', name: 'Mutation' }) },
    directives: { type: '[__Directive!]!', resolve: () => [] },
  },
};

function baseTypeName(typeRef: string): string {
  return typeRef.replace(/[[\]!]/g, '');
}

SCHEMA.__Type = {
  kind: 'OBJECT',
  fields: {
    name: { type: 'String', resolve: (s) => s.name },
    kind: {
      type: 'String!',
      resolve: (s) => {
        const def = SCHEMA[String(s.name)];
        if (def === undefined) return 'SCALAR';
        return def.kind === 'INPUT_OBJECT' ? 'INPUT_OBJECT' : def.kind;
      },
    },
    description: { type: 'String', resolve: () => null },
    fields: {
      type: '[__Field!]',
      args: { includeDeprecated: 'Boolean' },
      resolve: (s) => {
        const def = SCHEMA[String(s.name)];
        if (def === undefined || def.fields === undefined) return null;
        return Object.keys(def.fields).map((fieldName) => ({ __typename: '__Field', name: fieldName, parentType: String(s.name) }));
      },
    },
    enumValues: {
      type: '[__EnumValue!]',
      args: { includeDeprecated: 'Boolean' },
      resolve: (s) => {
        const def = SCHEMA[String(s.name)];
        if (def === undefined || def.values === undefined) return null;
        return def.values.map((value) => ({ __typename: '__EnumValue', name: value }));
      },
    },
    inputFields: {
      type: '[__InputValue!]',
      resolve: (s) => {
        const def = SCHEMA[String(s.name)];
        if (def === undefined || def.inputFields === undefined) return null;
        return Object.entries(def.inputFields).map(([fieldName, type]) => ({ __typename: '__InputValue', name: fieldName, typeRef: type }));
      },
    },
    possibleTypes: { type: '[__Type!]', resolve: () => null },
    interfaces: { type: '[__Type!]!', resolve: () => [] },
    specifiedByURL: { type: 'String', resolve: () => null },
  },
};

SCHEMA.__Field = {
  kind: 'OBJECT',
  fields: {
    name: { type: 'String!', resolve: (s) => s.name },
    description: { type: 'String', resolve: () => null },
    args: { type: '[__InputValue!]!', resolve: (s) => {
      const def = SCHEMA[String(s.parentType)]?.fields?.[String(s.name)];
      if (def?.args === undefined) return [];
      return Object.entries(def.args).map(([argName, type]) => ({ __typename: '__InputValue', name: argName, typeRef: type }));
    } },
    type: {
      type: '__Type!',
      resolve: (s) => {
        const def = SCHEMA[String(s.parentType)]?.fields?.[String(s.name)];
        return { __typename: '__Type', name: def === undefined ? 'String' : baseTypeName(def.type) };
      },
    },
    isDeprecated: { type: 'Boolean!', resolve: () => false },
    deprecationReason: { type: 'String', resolve: () => null },
  },
};

SCHEMA.__EnumValue = {
  kind: 'OBJECT',
  fields: {
    name: { type: 'String!', resolve: (s) => s.name },
    description: { type: 'String', resolve: () => null },
    isDeprecated: { type: 'Boolean!', resolve: () => false },
    deprecationReason: { type: 'String', resolve: () => null },
  },
};

SCHEMA.__InputValue = {
  kind: 'OBJECT',
  fields: {
    name: { type: 'String!', resolve: (s) => s.name },
    description: { type: 'String', resolve: () => null },
    type: { type: '__Type!', resolve: (s) => ({ __typename: '__Type', name: baseTypeName(String(s.typeRef ?? 'String')) }) },
    defaultValue: { type: 'String', resolve: () => null },
  },
};

SCHEMA.CreateIssueInput = { kind: 'INPUT_OBJECT', inputFields: { repositoryId: 'ID!', title: 'String!', body: 'String', clientMutationId: 'String' } };
SCHEMA.CloseIssueInput = { kind: 'INPUT_OBJECT', inputFields: { issueId: 'ID!', stateReason: 'String', clientMutationId: 'String' } };
SCHEMA.CreatePullRequestInput = { kind: 'INPUT_OBJECT', inputFields: { repositoryId: 'ID!', baseRefName: 'String!', headRefName: 'String!', title: 'String!', body: 'String', clientMutationId: 'String' } };
SCHEMA.MergePullRequestInput = { kind: 'INPUT_OBJECT', inputFields: { pullRequestId: 'ID!', mergeMethod: 'PullRequestMergeMethod', clientMutationId: 'String' } };
SCHEMA.AddCommentInput = { kind: 'INPUT_OBJECT', inputFields: { subjectId: 'ID!', body: 'String!', clientMutationId: 'String' } };
SCHEMA.IssueOrder = { kind: 'INPUT_OBJECT', inputFields: { field: 'IssueOrderField!', direction: 'OrderDirection!' } };
SCHEMA.PullRequestOrder = { kind: 'INPUT_OBJECT', inputFields: { field: 'PullRequestOrderField!', direction: 'OrderDirection!' } };

const payloadFields = (field: string, type: string): Record<string, FieldDef> => ({
  [field]: { type, resolve: (s) => s.payload },
  clientMutationId: { type: 'String', resolve: (s) => s.clientMutationId ?? null },
});
SCHEMA.CreateIssuePayload = { kind: 'OBJECT', fields: payloadFields('issue', 'Issue') };
SCHEMA.CloseIssuePayload = { kind: 'OBJECT', fields: payloadFields('issue', 'Issue') };
SCHEMA.CreatePullRequestPayload = { kind: 'OBJECT', fields: payloadFields('pullRequest', 'PullRequest') };
SCHEMA.MergePullRequestPayload = { kind: 'OBJECT', fields: payloadFields('pullRequest', 'PullRequest') };
SCHEMA.AddCommentPayload = {
  kind: 'OBJECT',
  fields: {
    commentEdge: { type: 'IssueCommentEdge', resolve: (s) => s.payload },
    subject: { type: 'Node', resolve: (s) => s.subject ?? null },
    clientMutationId: { type: 'String', resolve: (s) => s.clientMutationId ?? null },
  },
};

class GqlInputError extends Error {}

SCHEMA.Mutation = {
  kind: 'OBJECT',
  fields: {
    createIssue: {
      type: 'CreateIssuePayload',
      args: { input: 'CreateIssueInput!' },
      resolve: (s, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = findRepoByGlobalId(ctx.store, input.repositoryId);
        if (repo === null) throw new GqlInputError('repository not found');
        const issue = createIssueRec(ctx.store, repo, {
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
        });
        return { __typename: 'CreateIssuePayload', payload: issueSource(repo, issue), clientMutationId: input.clientMutationId ?? null };
      },
    },
    closeIssue: {
      type: 'CloseIssuePayload',
      args: { input: 'CloseIssueInput!' },
      resolve: (s, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = typeof input.issueId === 'string' ? parseGlobalId(input.issueId) : null;
        const found = parsed === null ? null : ctx.store.findItemByRecId(parsed.numericId);
        if (found === null || found.item.kind !== 'issue') throw new GqlInputError('issue not found');
        found.item.state = 'closed';
        found.item.closedAt = nowIso();
        found.item.updatedAt = nowIso();
        return { __typename: 'CloseIssuePayload', payload: issueSource(found.repo, found.item), clientMutationId: input.clientMutationId ?? null };
      },
    },
    createPullRequest: {
      type: 'CreatePullRequestPayload',
      args: { input: 'CreatePullRequestInput!' },
      resolve: (s, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = findRepoByGlobalId(ctx.store, input.repositoryId);
        if (repo === null) throw new GqlInputError('repository not found');
        const headRef = String(input.headRefName ?? '');
        const baseRef = String(input.baseRefName ?? '');
        const headSha = branchTip(repo, headRef);
        const baseSha = branchTip(repo, baseRef);
        if (headSha === null || baseSha === null) throw new GqlInputError('head or base branch does not exist');
        const pull = createPullRec(ctx.store, repo, {
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
          headRef,
          baseRef,
          headSha,
          baseSha,
        });
        return { __typename: 'CreatePullRequestPayload', payload: pullSource(repo, pull), clientMutationId: input.clientMutationId ?? null };
      },
    },
    mergePullRequest: {
      type: 'MergePullRequestPayload',
      args: { input: 'MergePullRequestInput!' },
      resolve: (s, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = typeof input.pullRequestId === 'string' ? parseGlobalId(input.pullRequestId) : null;
        const found = parsed === null ? null : ctx.store.findItemByRecId(parsed.numericId);
        if (found === null || found.item.kind !== 'pull') throw new GqlInputError('pull request not found');
        const methodRaw = typeof input.mergeMethod === 'string' ? input.mergeMethod : 'MERGE';
        const method: MergeMethod = methodRaw === 'SQUASH' ? 'squash' : methodRaw === 'REBASE' ? 'rebase' : 'merge';
        const outcome = mergePullRequest(found.repo, found.item, method);
        if (!outcome.ok) throw new GqlInputError(`pull request is not mergeable (${outcome.reason})`);
        return { __typename: 'MergePullRequestPayload', payload: pullSource(found.repo, found.item), clientMutationId: input.clientMutationId ?? null };
      },
    },
    addComment: {
      type: 'AddCommentPayload',
      args: { input: 'AddCommentInput!' },
      resolve: (s, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = typeof input.subjectId === 'string' ? parseGlobalId(input.subjectId) : null;
        const found = parsed === null ? null : ctx.store.findItemByRecId(parsed.numericId);
        if (found === null) throw new GqlInputError('subject not found');
        const comment = addCommentRec(ctx.store, found.repo, found.item, String(input.body ?? ''));
        const node = commentSource(found.repo, found.item, comment);
        const subject = found.item.kind === 'issue' ? issueSource(found.repo, found.item) : pullSource(found.repo, found.item);
        return {
          __typename: 'AddCommentPayload',
          payload: { __typename: 'IssueCommentEdge', node, cursor: cursorFor(comment.id) },
          subject,
          clientMutationId: input.clientMutationId ?? null,
        };
      },
    },
  },
};

// ---------------------------------------------------------------------------------------------
// Evaluation, validation, execution

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((value) => evalValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

function evalArgs(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = evalValue(arg.value, variables);
  return out;
}

type TypeRef = { kind: 'named'; name: string } | { kind: 'list'; of: TypeRef } | { kind: 'nonnull'; of: TypeRef };

function parseTypeRef(ref: string): TypeRef {
  let i = 0;
  const parse = (): TypeRef => {
    let node: TypeRef;
    if (ref[i] === '[') {
      i += 1;
      const inner = parse();
      i += 1; // ']'
      node = { kind: 'list', of: inner };
    } else {
      let name = '';
      while (i < ref.length && /[A-Za-z0-9_]/.test(ref[i]!)) {
        name += ref[i];
        i += 1;
      }
      node = { kind: 'named', name };
    }
    if (ref[i] === '!') {
      i += 1;
      return { kind: 'nonnull', of: node };
    }
    return node;
  };
  return parse();
}

/** Expand a selection set into the concrete fields it asks of `typeName` (fragments resolved). */
function collectFields(doc: GqlDocument, typeName: string, selections: SelectionNode[]): FieldNode[] {
  const out: FieldNode[] = [];
  for (const selection of selections) {
    if (selection.kind === 'field') {
      out.push(selection);
    } else if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName || SCHEMA[selection.typeCondition]?.kind === 'INTERFACE') {
        out.push(...collectFields(doc, typeName, selection.selectionSet));
      }
    } else {
      const fragment = doc.fragments.get(selection.name);
      if (fragment !== undefined && (fragment.typeCondition === null || fragment.typeCondition === typeName || SCHEMA[fragment.typeCondition]?.kind === 'INTERFACE')) {
        out.push(...collectFields(doc, typeName, fragment.selectionSet));
      }
    }
  }
  return out;
}

function validateSelections(doc: GqlDocument, typeName: string, selections: SelectionNode[], errors: { message: string }[]): void {
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      validateSelections(doc, selection.typeCondition ?? typeName, selection.selectionSet, errors);
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = doc.fragments.get(selection.name);
      if (fragment !== undefined) validateSelections(doc, fragment.typeCondition ?? typeName, fragment.selectionSet, errors);
      continue;
    }
    if (selection.name === '__typename') continue;
    const def = SCHEMA[typeName];
    const fieldDef = def?.fields?.[selection.name];
    if (fieldDef === undefined) {
      errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName}'` });
      continue;
    }
    if (selection.selectionSet !== null) {
      validateSelections(doc, baseTypeName(fieldDef.type), selection.selectionSet, errors);
    }
  }
}

interface ExecState {
  ctx: Ctx;
  doc: GqlDocument;
  variables: Record<string, unknown>;
  errors: { message: string }[];
}

function executeSelectionSet(state: ExecState, typeName: string, source: Src, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of collectFields(state.doc, typeName, selections)) {
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const fieldDef = SCHEMA[typeName]?.fields?.[field.name];
    if (fieldDef === undefined) {
      out[key] = null;
      state.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
      continue;
    }
    let value: unknown;
    try {
      value = fieldDef.resolve(source, evalArgs(field, state.variables), state.ctx);
    } catch (error) {
      out[key] = null;
      state.errors.push({ message: error instanceof Error ? error.message : String(error) });
      continue;
    }
    out[key] = completeValue(state, parseTypeRef(fieldDef.type), value, field.selectionSet);
  }
  return out;
}

function completeValue(state: ExecState, typeRef: TypeRef, value: unknown, selectionSet: SelectionNode[] | null): unknown {
  if (typeRef.kind === 'nonnull') {
    return completeValue(state, typeRef.of, value, selectionSet);
  }
  if (value === null || value === undefined) return null;
  if (typeRef.kind === 'list') {
    if (!Array.isArray(value)) return null;
    return value.map((item) => completeValue(state, typeRef.of, item, selectionSet));
  }
  const def = SCHEMA[typeRef.name];
  if (def === undefined || def.kind === 'SCALAR' || def.kind === 'ENUM') return value;
  const source = value as Src;
  const concrete = typeof source.__typename === 'string' ? source.__typename : typeRef.name;
  return executeSelectionSet(state, concrete, source, selectionSet ?? []);
}

function runOperation(store: Store, body: Record<string, unknown>): Record<string, unknown> {
  const queryText = typeof body.query === 'string' ? body.query : '';
  const variables = (body.variables !== null && typeof body.variables === 'object' ? body.variables : {}) as Record<string, unknown>;
  let doc: GqlDocument;
  try {
    doc = new Parser(queryText).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : 'syntax error' }] };
  }
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  const operation = doc.operations.find((op) => operationName === null || op.name === operationName) ?? doc.operations[0];
  if (operation === undefined) return { errors: [{ message: 'no operation in document' }] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const validationErrors: { message: string }[] = [];
  validateSelections(doc, rootType, operation.selectionSet, validationErrors);
  if (validationErrors.length > 0) return { data: null, errors: validationErrors };
  const state: ExecState = { ctx: { store }, doc, variables, errors: [] };
  const data = executeSelectionSet(state, rootType, { __typename: rootType }, operation.selectionSet);
  const result: Record<string, unknown> = { data };
  if (state.errors.length > 0) result.errors = state.errors;
  return result;
}

/** POST /api/graphql — one operation, or a JSON array of them (GitHub's operation batching). */
export function handleGraphQL(store: Store, body: Buffer, res: ServerResponse): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'request body is not JSON' }] });
    return;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => runOperation(store, (entry ?? {}) as Record<string, unknown>));
    sendJson(res, 200, results);
    return;
  }
  if (parsed === null || typeof parsed !== 'object') {
    sendJson(res, 400, { errors: [{ message: 'request body must be an object' }] });
    return;
  }
  sendJson(res, 200, runOperation(store, parsed as Record<string, unknown>));
}

export { sendError };
