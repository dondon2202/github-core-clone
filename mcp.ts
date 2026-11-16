// MCP over Streamable HTTP: JSON-RPC 2.0 on POST /mcp. Modern era (2026-07-28) via
// server/discover plus the legacy initialize handshake, a static six-tool list, and tools
// that act on the same store as REST. Unknown tools and missing arguments are JSON-RPC
// errors, never HTTP 500s; a non-JSON body is HTTP 400 with -32700.

import type { Store } from './store.ts';
import { VIEWER } from './store.ts';
import {
  createIssueRecord,
  createPullRecord,
  issueJson,
  mergePull,
  pullJson,
  repoJson,
} from './rest.ts';

export interface McpReply {
  status: number;
  json: unknown;
  empty?: boolean;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
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
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
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
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
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
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request between two branches.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'integer', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const SERVER_INFO = { name: 'github-forge', version: '1.0.0' };

function result(id: unknown, payload: unknown): McpReply {
  return { status: 200, json: { jsonrpc: '2.0', id, result: payload } };
}

function failure(id: unknown, code: number, message: string, status = 200): McpReply {
  return { status, json: { jsonrpc: '2.0', id, error: { code, message } } };
}

/** Read an argument by canonical name, tolerating the suite's documented synonyms. */
function pick(args: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    if (args[name] !== undefined) return args[name];
  }
  return undefined;
}

function toolText(payload: unknown, isError = false): Record<string, unknown> {
  const out: Record<string, unknown> = {
    content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }],
    structuredContent: payload,
  };
  if (isError) out.isError = true;
  return out;
}

class ToolError extends Error {}

function needString(args: Record<string, unknown>, names: string[], label: string): string {
  const value = pick(args, names);
  if (typeof value !== 'string' || value === '') throw new ToolError(`missing required argument: ${label}`);
  return value;
}

function needRepo(store: Store, args: Record<string, unknown>): { owner: string; name: string; repo: NonNullable<ReturnType<Store['getRepo']>> } {
  const owner = needString(args, ['owner', 'owner_login', 'org', 'user', 'login'], 'owner');
  const name = needString(args, ['repo', 'repository', 'repo_name', 'name'], 'repo');
  const repo = store.getRepo(owner, name);
  if (repo === undefined) throw new ToolError(`repository ${owner}/${name} not found`);
  return { owner, name, repo };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const normalized = name.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
  const tool = TOOLS.find((candidate) => normalized === candidate.name || normalized.endsWith(`_${candidate.name}`) || normalized.endsWith(`/${candidate.name}`));
  if (tool === undefined) throw new ToolError(`unknown tool: ${name}`);
  switch (tool.name) {
    case 'create_repo': {
      const repoName = needString(args, ['name', 'repo', 'repository'], 'name');
      const description = pick(args, ['description', 'body']) ?? '';
      const isPrivate = pick(args, ['private']) === true;
      if (store.getRepo(VIEWER.login, repoName) !== undefined) {
        return toolText({ message: `Repository ${repoName} already exists` }, true);
      }
      const repo = store.createRepo(repoName, isPrivate, typeof description === 'string' ? description : '');
      return toolText(repoJson(repo));
    }
    case 'get_repo': {
      const { repo } = needRepo(store, args);
      return toolText(repoJson(repo));
    }
    case 'create_issue': {
      const { repo } = needRepo(store, args);
      const title = needString(args, ['title', 'subject'], 'title');
      const body = pick(args, ['body', 'description', 'content']);
      const issue = createIssueRecord(store, repo, title, typeof body === 'string' ? body : '', []);
      return toolText(issueJson(repo, issue));
    }
    case 'list_issues': {
      const { repo } = needRepo(store, args);
      const state = String(pick(args, ['state']) ?? 'open');
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((issue) => issue.state === state);
      list.sort((a, b) => a.seq - b.seq);
      return toolText(list.map((issue) => issueJson(repo, issue)));
    }
    case 'create_pull_request': {
      const { repo } = needRepo(store, args);
      const title = needString(args, ['title', 'subject'], 'title');
      const body = pick(args, ['body', 'description', 'content']);
      const head = needString(args, ['head', 'head_branch', 'source', 'from', 'branch'], 'head');
      const base = needString(args, ['base', 'base_branch', 'target', 'into'], 'base');
      const headShort = head.startsWith('refs/heads/') ? head.slice('refs/heads/'.length) : head;
      const baseShort = base.startsWith('refs/heads/') ? base.slice('refs/heads/'.length) : base;
      if (repo.refs.get(`refs/heads/${headShort}`) === undefined) {
        return toolText({ message: `head branch ${headShort} does not exist` }, true);
      }
      if (repo.refs.get(`refs/heads/${baseShort}`) === undefined) {
        return toolText({ message: `base branch ${baseShort} does not exist` }, true);
      }
      let pull = [...repo.pulls.values()].find((candidate) => candidate.state === 'open' && candidate.head === headShort && candidate.base === baseShort);
      if (pull === undefined) {
        pull = createPullRecord(store, repo, title, typeof body === 'string' ? body : '', headShort, baseShort);
      }
      return toolText(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const { repo } = needRepo(store, args);
      const raw = pick(args, ['pull_number', 'number', 'pullNumber']);
      const number = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isInteger(number) || number < 1) throw new ToolError('missing required argument: pull_number');
      const pull = repo.pulls.get(number);
      if (pull === undefined) return toolText({ message: `pull request #${number} not found` }, true);
      const reply = mergePull(store, repo, pull);
      if (reply.status !== 200) {
        const message = reply.json !== null && typeof reply.json === 'object' ? String((reply.json as Record<string, unknown>).message ?? 'merge failed') : 'merge failed';
        return toolText({ message }, true);
      }
      return toolText({ ...(reply.json as Record<string, unknown>), number });
    }
    default:
      throw new ToolError(`unknown tool: ${name}`);
  }
}

export function handleMcp(store: Store, rawBody: Buffer): McpReply {
  let request: unknown;
  try {
    request = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return failure(null, -32700, 'parse error', 400);
  }
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return failure(null, -32600, 'invalid request');
  }
  const rpc = request as Record<string, unknown>;
  const id = rpc.id === undefined ? null : rpc.id;
  const method = rpc.method;
  if (typeof method !== 'string') return failure(id, -32600, 'invalid request: method must be a string');
  if (method.startsWith('notifications/')) {
    return { status: 202, json: null, empty: true };
  }
  const params = rpc.params !== null && typeof rpc.params === 'object' && !Array.isArray(rpc.params) ? (rpc.params as Record<string, unknown>) : {};

  if (method === 'server/discover') {
    return result(id, {
      serverInfo: SERVER_INFO,
      capabilities: { tools: {} },
      supportedVersions: ['2026-07-28'],
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    return result(id, { protocolVersion: requested, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
  }
  if (method === 'ping') {
    return result(id, {});
  }
  if (method === 'tools/list') {
    return result(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const toolName = params.name;
    if (typeof toolName !== 'string' || toolName === '') return failure(id, -32602, 'missing required argument: name');
    const args = params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
      ? (params.arguments as Record<string, unknown>)
      : {};
    try {
      return result(id, callTool(store, toolName, args));
    } catch (error) {
      if (error instanceof ToolError) {
        const code = error.message.startsWith('unknown tool') ? -32601 : -32602;
        return failure(id, code, error.message);
      }
      return failure(id, -32603, error instanceof Error ? error.message : String(error));
    }
  }
  return failure(id, -32601, `method not found: ${method}`);
}
