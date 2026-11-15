// The MCP surface: JSON-RPC 2.0 over Streamable HTTP at /mcp, speaking the current revision
// (2026-07-28, negotiated through server/discover) and the handshake era (initialize) for older
// clients. The tools are github-mcp-server's core set over the same store as REST and GraphQL —
// a repository or issue created here is the same object there, with the same ids. tools/list is
// a fixed literal, so two calls answer byte-for-byte identical lists.

import type { ServerResponse } from 'node:http';
import { addCommentRec, createIssueRec, createPullRec, listIssues, listPulls, VIEWER, type RepoRec, type Store } from './store.ts';
import { branchTip, commentJson, issueJson, mergePullRequest, pullJson, repoJson, sendJson, type MergeMethod } from './rest.ts';

const SERVER_INFO = { name: 'asu-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  run: (store: Store, args: Record<string, unknown>) => unknown;
}

class ToolError extends Error {}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function numberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function requireRepo(store: Store, args: Record<string, unknown>): RepoRec {
  const owner = stringArg(args, 'owner') ?? VIEWER.login;
  const name = stringArg(args, 'repo');
  if (name === undefined) throw new ToolError('repo is required');
  const repo = store.getRepo(owner, name);
  if (repo === null) throw new ToolError(`repository ${owner}/${name} not found`);
  return repo;
}

const ownerRepoProps = {
  owner: { type: 'string', description: 'The repository owner login.' },
  repo: { type: 'string', description: 'The repository name.' },
};

export const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
    run: (store, args) => {
      const name = stringArg(args, 'name');
      if (name === undefined) throw new ToolError('name is required');
      if (store.getRepo(VIEWER.login, name) !== null) throw new ToolError(`repository ${VIEWER.login}/${name} already exists`);
      const repo = store.createRepo(VIEWER.login, name, {
        private: args.private === true,
        description: stringArg(args, 'description') ?? '',
      });
      return repoJson(repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: { type: 'object', properties: { ...ownerRepoProps }, required: ['owner', 'repo'] },
    run: (store, args) => repoJson(requireRepo(store, args)),
  },
  {
    name: 'list_repos',
    description: 'List the repositories owned by the authenticated user.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    run: (store) => store.listRepos(VIEWER.login).map((repo) => repoJson(repo)),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        ...ownerRepoProps,
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
        labels: { type: 'array', description: 'Label names to apply; each must already exist.' },
      },
      required: ['owner', 'repo', 'title'],
    },
    run: (store, args) => {
      const repo = requireRepo(store, args);
      const title = stringArg(args, 'title');
      if (title === undefined) throw new ToolError('title is required');
      const labelNames: string[] = [];
      if (Array.isArray(args.labels)) {
        for (const label of args.labels) {
          if (typeof label !== 'string' || !repo.labels.has(label)) throw new ToolError(`label "${String(label)}" does not exist`);
          labelNames.push(label);
        }
      }
      const issue = createIssueRec(store, repo, { title, body: stringArg(args, 'body') ?? '', labelNames });
      return issueJson(repo, issue);
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by its number.',
    inputSchema: {
      type: 'object',
      properties: { ...ownerRepoProps, issue_number: { type: 'number', description: 'The issue number.' } },
      required: ['owner', 'repo', 'issue_number'],
    },
    run: (store, args) => {
      const repo = requireRepo(store, args);
      const number = numberArg(args, 'issue_number');
      const item = number === undefined ? undefined : repo.items.get(number);
      if (item === undefined || item.kind !== 'issue') throw new ToolError('issue not found');
      return issueJson(repo, item);
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state (open, closed, all).',
    inputSchema: {
      type: 'object',
      properties: { ...ownerRepoProps, state: { type: 'string', description: 'Filter by state: open, closed or all.' } },
      required: ['owner', 'repo'],
    },
    run: (store, args) => {
      const repo = requireRepo(store, args);
      const state = stringArg(args, 'state') ?? 'open';
      let issues = listIssues(repo);
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      return issues.map((issue) => issueJson(repo, issue));
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        ...ownerRepoProps,
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    run: (store, args) => {
      const repo = requireRepo(store, args);
      const title = stringArg(args, 'title');
      const head = stringArg(args, 'head');
      const base = stringArg(args, 'base');
      if (title === undefined || head === undefined || base === undefined) throw new ToolError('title, head and base are required');
      const headSha = branchTip(repo, head);
      const baseSha = branchTip(repo, base);
      if (headSha === null) throw new ToolError(`head branch "${head}" does not exist`);
      if (baseSha === null) throw new ToolError(`base branch "${base}" does not exist`);
      const pull = createPullRec(store, repo, { title, body: stringArg(args, 'body') ?? '', headRef: head, baseRef: base, headSha, baseSha });
      return pullJson(repo, pull);
    },
  },
  {
    name: 'get_pull_request',
    description: 'Get one pull request by its number.',
    inputSchema: {
      type: 'object',
      properties: { ...ownerRepoProps, pull_number: { type: 'number', description: 'The pull request number.' } },
      required: ['owner', 'repo', 'pull_number'],
    },
    run: (store, args) => {
      const repo = requireRepo(store, args);
      const number = numberArg(args, 'pull_number');
      const item = number === undefined ? undefined : repo.items.get(number);
      if (item === undefined || item.kind !== 'pull') throw new ToolError('pull request not found');
      return pullJson(repo, item);
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: { ...ownerRepoProps, state: { type: 'string', description: 'Filter by state: open, closed or all.' } },
      required: ['owner', 'repo'],
    },
    run: (store, args) => {
      const repo = requireRepo(store, args);
      const state = stringArg(args, 'state') ?? 'open';
      let pulls = listPulls(repo);
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      return pulls.map((pull) => pullJson(repo, pull));
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash by default).',
    inputSchema: {
      type: 'object',
      properties: {
        ...ownerRepoProps,
        pull_number: { type: 'number', description: 'The pull request number.' },
        merge_method: { type: 'string', description: 'merge, squash or rebase.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    run: (store, args) => {
      const repo = requireRepo(store, args);
      const number = numberArg(args, 'pull_number');
      const item = number === undefined ? undefined : repo.items.get(number);
      if (item === undefined || item.kind !== 'pull') throw new ToolError('pull request not found');
      const methodRaw = stringArg(args, 'merge_method') ?? 'squash';
      const method: MergeMethod = methodRaw === 'merge' ? 'merge' : methodRaw === 'rebase' ? 'rebase' : 'squash';
      const outcome = mergePullRequest(repo, item, method);
      if (!outcome.ok) throw new ToolError(`pull request is not mergeable (${outcome.reason})`);
      return { ...pullJson(repo, item), sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' };
    },
  },
  {
    name: 'create_issue_comment',
    description: 'Comment on an issue or pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        ...ownerRepoProps,
        issue_number: { type: 'number', description: 'The issue or pull request number.' },
        body: { type: 'string', description: 'The comment body.' },
      },
      required: ['owner', 'repo', 'issue_number', 'body'],
    },
    run: (store, args) => {
      const repo = requireRepo(store, args);
      const number = numberArg(args, 'issue_number');
      const item = number === undefined ? undefined : repo.items.get(number);
      if (item === undefined) throw new ToolError('issue not found');
      const body = stringArg(args, 'body');
      if (body === undefined) throw new ToolError('body is required');
      const comment = addCommentRec(store, repo, item, body);
      return commentJson(repo, item, comment);
    },
  },
  {
    name: 'create_branch',
    description: 'Create a branch from another branch (or the default branch).',
    inputSchema: {
      type: 'object',
      properties: {
        ...ownerRepoProps,
        branch: { type: 'string', description: 'The new branch name.' },
        from_branch: { type: 'string', description: 'The branch to fork from; defaults to the default branch.' },
      },
      required: ['owner', 'repo', 'branch'],
    },
    run: (store, args) => {
      const repo = requireRepo(store, args);
      const branch = stringArg(args, 'branch');
      if (branch === undefined) throw new ToolError('branch is required');
      const from = stringArg(args, 'from_branch') ?? repo.defaultBranch;
      const sha = branchTip(repo, from);
      if (sha === null) throw new ToolError(`branch "${from}" does not exist`);
      repo.refs.set(`refs/heads/${branch}`, sha);
      return { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } };
    },
  },
];

// ---------------------------------------------------------------------------------------------
// The JSON-RPC layer

const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_PARAMS = -32602;
const JSON_RPC_METHOD_NOT_FOUND = -32601;

interface RpcMessage {
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function toolListResult(): unknown {
  return {
    tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
  };
}

function discoverResult(): unknown {
  return {
    supportedVersions: [...SUPPORTED_VERSIONS],
    capabilities: { tools: { listChanged: false } },
    serverInfo: { ...SERVER_INFO },
    _meta: {
      'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO },
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    },
  };
}

function callTool(store: Store, params: unknown): { result?: unknown; error?: { code: number; message: string } } {
  const p = (params ?? {}) as Record<string, unknown>;
  const name = typeof p.name === 'string' ? p.name : '';
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    return { error: { code: JSON_RPC_INVALID_PARAMS, message: `unknown tool: ${name}` } };
  }
  const args = (p.arguments !== null && typeof p.arguments === 'object' ? p.arguments : {}) as Record<string, unknown>;
  const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0) {
    return {
      result: {
        content: [{ type: 'text', text: `missing required argument(s): ${missing.join(', ')}` }],
        isError: true,
      },
    };
  }
  try {
    const value = tool.run(store, args);
    const result: Record<string, unknown> = {
      content: [{ type: 'text', text: JSON.stringify(value) }],
      isError: false,
    };
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) result.structuredContent = value;
    return { result };
  } catch (error) {
    return {
      result: {
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      },
    };
  }
}

/** Answer one JSON-RPC message; null means a notification (no answer owed). */
function handleMessage(store: Store, message: RpcMessage): Record<string, unknown> | null {
  const method = typeof message.method === 'string' ? message.method : '';
  const id = message.id;
  if (id === undefined || id === null) return null; // a notification
  const ok = (result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, text: string): Record<string, unknown> => ({ jsonrpc: '2.0', id, error: { code, message: text } });
  switch (method) {
    case 'server/discover':
      return ok(discoverResult());
    case 'initialize': {
      const params = (message.params ?? {}) as Record<string, unknown>;
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
      return ok({ protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { ...SERVER_INFO } });
    }
    case 'tools/list':
      return ok(toolListResult());
    case 'tools/call': {
      const outcome = callTool(store, message.params);
      if (outcome.error !== undefined) return fail(outcome.error.code, outcome.error.message);
      return ok(outcome.result);
    }
    case 'ping':
      return ok({});
    default:
      return fail(JSON_RPC_METHOD_NOT_FOUND, `method not found: ${method}`);
  }
}

/** POST /mcp. A body that is not JSON is a 400 with a -32700 parse error, per the transport. */
export function handleMcp(store: Store, body: Buffer, res: ServerResponse): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: JSON_RPC_PARSE_ERROR, message: 'Parse error' } });
    return;
  }
  if (Array.isArray(parsed)) {
    const answers = parsed
      .map((entry) => handleMessage(store, (entry ?? {}) as RpcMessage))
      .filter((answer) => answer !== null);
    sendJson(res, 200, answers);
    return;
  }
  if (parsed === null || typeof parsed !== 'object') {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: JSON_RPC_PARSE_ERROR, message: 'Parse error' } });
    return;
  }
  const answer = handleMessage(store, parsed as RpcMessage);
  if (answer === null) {
    res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' });
    res.end();
    return;
  }
  sendJson(res, 200, answer);
}
