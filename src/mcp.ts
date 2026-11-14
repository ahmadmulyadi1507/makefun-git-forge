// mcp.ts — Model Context Protocol endpoint (POST /mcp).
// Modern era 2026-07-28 (server/discover, no handshake, no session) plus the
// legacy initialize + notifications/initialized fallback. JSON-RPC 2.0 over
// Streamable HTTP. Tools act on the same store as the REST surface.

import { Store, VIEWER_LOGIN, type Issue, type Pull, type Repo } from './store.ts';
import { doMergePull } from './graphql.ts';

const SERVER_NAME = 'makefun-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full repository name owner/repo' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full repository name owner/repo' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full repository name owner/repo' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full repository name owner/repo' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with the squash method.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full repository name owner/repo' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function textResult(obj: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

function errorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

function resolveOwnerRepo(store: Store, args: Record<string, unknown>): Repo | null {
  let owner = String(args.owner ?? '');
  let repoName = String(args.repo ?? '');
  const fullName = String(args.full_name ?? '');
  if ((!owner || !repoName) && fullName.includes('/')) {
    const [o, r] = fullName.split('/');
    owner = owner || o;
    repoName = repoName || r;
  }
  if (!owner || !repoName) return null;
  if (owner !== VIEWER_LOGIN) return null;
  return store.getRepo(owner, repoName) ?? null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): { result: Record<string, unknown>; rpcError?: { code: number; message: string } } {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    return { result: {}, rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  }
  for (const req of tool.inputSchema.required) {
    if (args[req] === undefined || args[req] === null || args[req] === '') {
      return { result: errorResult(`Missing required argument: ${req}`) };
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (store.getRepo(VIEWER_LOGIN, repoName)) {
        return { result: errorResult(`Repository ${VIEWER_LOGIN}/${repoName} already exists`) };
      }
      const repo = store.createRepo(repoName, String(args.description ?? ''), args.private === true);
      return { result: textResult(repoSummary(repo)) };
    }
    case 'get_repo': {
      const repo = resolveOwnerRepo(store, args);
      if (!repo) return { result: errorResult('Repository not found') };
      return { result: textResult(repoSummary(repo)) };
    }
    case 'create_issue': {
      const repo = resolveOwnerRepo(store, args);
      if (!repo) return { result: errorResult('Repository not found') };
      repo.issueCounter += 1;
      const createdAt = store.nowIso();
      const issue: Issue = {
        number: repo.issueCounter,
        title: String(args.title),
        body: String(args.body ?? ''),
        state: 'open',
        labels: [],
        seq: store.seq,
        createdAt,
        updatedAt: createdAt,
        comments: [],
      };
      repo.issues.push(issue);
      return { result: textResult(issueSummary(repo, issue)) };
    }
    case 'list_issues': {
      const repo = resolveOwnerRepo(store, args);
      if (!repo) return { result: errorResult('Repository not found') };
      const state = String(args.state ?? 'open');
      const list = repo.issues.filter((i) => state === 'all' || i.state === state);
      return { result: textResult(list.map((i) => issueSummary(repo, i))) };
    }
    case 'create_pull_request': {
      const repo = resolveOwnerRepo(store, args);
      if (!repo) return { result: errorResult('Repository not found') };
      const head = String(args.head);
      const base = String(args.base);
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) return { result: errorResult('Head or base branch does not exist') };
      repo.pullCounter += 1;
      const createdAt = store.nowIso();
      const pull: Pull = {
        number: repo.pullCounter,
        title: String(args.title),
        body: String(args.body ?? ''),
        state: 'open',
        head,
        base,
        headSha,
        baseSha,
        mergeBase: baseSha,
        merged: false,
        mergeCommitSha: null,
        mergedAt: null,
        seq: store.seq,
        createdAt,
      };
      repo.pulls.push(pull);
      return { result: textResult(pullSummary(repo, pull)) };
    }
    case 'merge_pull_request': {
      const repo = resolveOwnerRepo(store, args);
      if (!repo) return { result: errorResult('Repository not found') };
      const number = Number(args.pull_number);
      const pull = repo.pulls.find((p) => p.number === number);
      if (!pull) return { result: errorResult(`Pull request #${number} not found`) };
      const merged = doMergePull(store, repo, pull);
      if (!merged.ok) return { result: errorResult('Pull request is not mergeable') };
      return { result: textResult(pullSummary(repo, pull)) };
    }
    default:
      return { result: {}, rpcError: { code: -32601, message: `Method not found: ${name}` } };
  }
}

function repoSummary(repo: Repo): Record<string, unknown> {
  return {
    id: repo.databaseId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    description: repo.description,
    private: repo.private,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function issueSummary(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.databaseId * 1_000_000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function pullSummary(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: repo.databaseId * 1_000_000 + pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head, sha: pull.headSha },
    base: { ref: pull.base, sha: pull.baseSha },
    created_at: pull.createdAt,
  };
}

export interface McpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const jsonRpc = (id: unknown, result: unknown): McpResponse => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id, result }),
});

const jsonRpcError = (id: unknown, code: number, message: string, status = 200): McpResponse => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }),
});

export function handleMcp(store: Store, rawBody: Buffer): McpResponse {
  let msg: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    msg = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return jsonRpcError(null, -32700, 'Parse error', 400);
  }
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
    return jsonRpcError(null, -32600, 'Invalid Request', 400);
  }
  const id = msg.id ?? null;
  const method = String(msg.method ?? '');
  const params = (msg.params ?? {}) as Record<string, unknown>;

  // Notification (no id): no response body, 202 Accepted.
  if (msg.id === undefined) {
    return { status: 202, headers: {}, body: '' };
  }

  switch (method) {
    case 'server/discover': {
      return jsonRpc(id, {
        protocolVersion: SUPPORTED_VERSIONS[0],
        supportedVersions: SUPPORTED_VERSIONS,
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        capabilities: { tools: {} },
      });
    }
    case 'initialize': {
      const requested = String((params as Record<string, unknown>).protocolVersion ?? '');
      const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
      return jsonRpc(id, {
        protocolVersion: negotiated,
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        capabilities: { tools: {} },
      });
    }
    case 'ping': {
      return jsonRpc(id, {});
    }
    case 'tools/list': {
      return jsonRpc(id, { tools: TOOLS });
    }
    case 'tools/call': {
      const toolName = String(params.name ?? '');
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const { result, rpcError } = callTool(store, toolName, args);
      if (rpcError) return jsonRpcError(id, rpcError.code, rpcError.message);
      return jsonRpc(id, result);
    }
    case 'resources/list':
      return jsonRpc(id, { resources: [] });
    case 'prompts/list':
      return jsonRpc(id, { prompts: [] });
    default:
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }
}
