// GraphQL over /api/graphql: a small lexer, parser and executor covering the documents the
// suite sends — variables, aliases, inline and named fragments, enum and object-literal
// arguments, __type introspection, connections with opaque cursors, mutations, and batches.
// Unknown fields resolve to an entry in `errors` naming the field; unknown repositories
// resolve to null without errors.

import type { IssueRec, PullRec, RepoRec, Store } from './store.ts';
import { VIEWER, gid, parseGid } from './store.ts';
import { createIssueRecord, createPullRecord, mergePull, prMergeable, pullFiles } from './rest.ts';

// --------------------------------------------------------------------------------------------
// lexer
// --------------------------------------------------------------------------------------------

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';
  value: string;
}

const PUNCT = new Set(['!', '$', '(', ')', ':', '=', '@', '[', ']', '{', '}', '|', '&']);

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const push = (kind: Token['kind'], value: string): void => {
    tokens.push({ kind, value });
  };
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      push('punct', '...');
      i += 3;
      continue;
    }
    if (PUNCT.has(ch)) {
      push('punct', ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        let raw = source.slice(i + 3, end).replace(/\\"""/g, '"""');
        raw = raw.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
        push('string', raw);
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1];
          const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (esc === 'u') {
            out += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else if (esc !== undefined && esc in map) {
            out += map[esc] as string;
            j += 2;
          } else {
            throw new Error('invalid string escape');
          }
        } else {
          out += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      push('string', out);
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      let isFloat = false;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] as string)) {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      push(isFloat ? 'float' : 'int', source.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j] as string)) j += 1;
      push('name', source.slice(i, j));
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  push('eof', '');
  return tokens;
}

// --------------------------------------------------------------------------------------------
// AST and parser
// --------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selectionSet: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'fragmentSpread'; name: string }
  | { kind: 'inlineFragment'; typeCondition: string | null; selectionSet: SelectionNode[] };

interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: Array<{ name: string; defaultValue: ValueNode | null }>;
  selectionSet: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected name, got ${token.value}`);
    return token.value;
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  parseDocument(): Array<OperationNode | FragmentNode> {
    const definitions: Array<OperationNode | FragmentNode> = [];
    while (this.peek().kind !== 'eof') definitions.push(this.parseDefinition());
    return definitions;
  }

  private parseDefinition(): OperationNode | FragmentNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '{') {
      return { kind: 'operation', operation: 'query', name: null, variables: [], selectionSet: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && token.value === 'fragment') {
      this.next();
      const name = this.expectName();
      const on = this.expectName();
      if (on !== 'on') throw new Error('expected on in fragment definition');
      const typeCondition = this.expectName();
      this.skipDirectives();
      return { kind: 'fragment', name, typeCondition, selectionSet: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      const operation = this.next().value as 'query' | 'mutation' | 'subscription';
      let name: string | null = null;
      if (this.peek().kind === 'name') name = this.next().value;
      const variables = this.parseVariableDefinitions();
      this.skipDirectives();
      return { kind: 'operation', operation, name, variables, selectionSet: this.parseSelectionSet() };
    }
    throw new Error(`unexpected definition start ${token.value}`);
  }

  private parseVariableDefinitions(): Array<{ name: string; defaultValue: ValueNode | null }> {
    const variables: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const name = this.expectName();
        this.expectPunct(':');
        this.parseType();
        let defaultValue: ValueNode | null = null;
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        this.skipDirectives();
        variables.push({ name, defaultValue });
      }
      this.expectPunct(')');
    }
    return variables;
  }

  private parseType(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next.kind === 'name' && next.value !== 'on') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'fragmentSpread', name };
      }
      let typeCondition: string | null = null;
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      this.skipDirectives();
      return { kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
    }
    let alias: string | null = null;
    let name = this.expectName();
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args = this.parseArguments();
    this.skipDirectives();
    const selectionSet = this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const name = this.expectName();
        this.expectPunct(':');
        args.push({ name, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.next();
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

// --------------------------------------------------------------------------------------------
// introspection model
// --------------------------------------------------------------------------------------------

interface TypeDef {
  kind: 'OBJECT' | 'ENUM' | 'INTERFACE';
  fields: string[];
  enumValues: string[];
}

const TYPE_DEFS: Record<string, TypeDef> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node'], enumValues: [] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'], enumValues: [] },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
    enumValues: [],
  },
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body'], enumValues: [] },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'body', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files'],
    enumValues: [],
  },
  User: { kind: 'OBJECT', fields: ['login', 'id', 'name'], enumValues: [] },
  Ref: { kind: 'OBJECT', fields: ['name'], enumValues: [] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'], enumValues: [] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'], enumValues: [] },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo'], enumValues: [] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path', 'additions', 'deletions'], enumValues: [] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'], enumValues: [] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body'], enumValues: [] },
  IssueCommentEdge: { kind: 'OBJECT', fields: ['node', 'cursor'], enumValues: [] },
  Node: { kind: 'INTERFACE', fields: ['id'], enumValues: [] },
  SearchType: { kind: 'ENUM', fields: [], enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'] },
  IssueState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', fields: [], enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', fields: [], enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
};

// --------------------------------------------------------------------------------------------
// node wrappers
// --------------------------------------------------------------------------------------------

type NodeObject = { __typename: string; [key: string]: unknown };

function repoNode(repo: RepoRec): NodeObject {
  return { __typename: 'Repository', repo };
}

function issueNode(repo: RepoRec, issue: IssueRec): NodeObject {
  return { __typename: 'Issue', repo, issue };
}

function pullNode(repo: RepoRec, pull: PullRec): NodeObject {
  return { __typename: 'PullRequest', repo, pull };
}

function userNode(): NodeObject {
  return { __typename: 'User' };
}

function commentNode(repo: RepoRec, comment: IssueRec['comments'][number]): NodeObject {
  return { __typename: 'IssueComment', repo, comment };
}

function encodeCursor(number: number): string {
  return Buffer.from(`IssueCursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^IssueCursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

function issueState(issue: IssueRec): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: PullRec): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

// --------------------------------------------------------------------------------------------
// execution
// --------------------------------------------------------------------------------------------

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string; path?: Array<string | number> }>;
}

type Resolver = (source: NodeObject, args: Record<string, unknown>, ctx: Ctx) => unknown;

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((child) => valueOf(child, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const arg of field.args) args[arg.name] = valueOf(arg.value, variables);
  return args;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function issuesConnection(repo: RepoRec, args: Record<string, unknown>): NodeObject {
  let list = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = asRecord(args.orderBy);
  const direction = orderBy.direction === 'ASC' ? 'ASC' : 'DESC';
  list.sort((a, b) => {
    const bySeq = direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq;
    return bySeq !== 0 ? bySeq : direction === 'ASC' ? a.number - b.number : b.number - a.number;
  });
  const after = typeof args.after === 'string' ? decodeCursor(args.after) : null;
  if (after !== null) {
    const index = list.findIndex((issue) => issue.number === after);
    if (index >= 0) list = list.slice(index + 1);
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const slice = list.slice(0, first);
  const hasNextPage = list.length > slice.length;
  const endCursor = slice.length > 0 ? encodeCursor((slice[slice.length - 1] as IssueRec).number) : null;
  const startCursor = slice.length > 0 ? encodeCursor((slice[0] as IssueRec).number) : null;
  return {
    __typename: 'IssueConnection',
    nodes: slice.map((issue) => issueNode(repo, issue)),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: after !== null,
      endCursor,
      startCursor,
    },
    totalCount: list.length,
  };
}

function pullsConnection(repo: RepoRec, args: Record<string, unknown>): NodeObject {
  let list = [...repo.pulls.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state)));
    list = list.filter((pull) => wanted.has(pullState(pull)));
  }
  list.sort((a, b) => b.seq - a.seq);
  const first = typeof args.first === 'number' ? args.first : list.length;
  const slice = list.slice(0, first);
  return {
    __typename: 'PullRequestConnection',
    nodes: slice.map((pull) => pullNode(repo, pull)),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: list.length > slice.length,
      hasPreviousPage: false,
      endCursor: slice.length > 0 ? encodeCursor((slice[slice.length - 1] as PullRec).number) : null,
      startCursor: slice.length > 0 ? encodeCursor((slice[0] as PullRec).number) : null,
    },
    totalCount: list.length,
  };
}

function filesConnection(repo: RepoRec, pull: PullRec, args: Record<string, unknown>): NodeObject {
  const files = pullFiles(repo, pull) ?? [];
  const first = typeof args.first === 'number' ? args.first : files.length;
  const slice = files.slice(0, first);
  return {
    __typename: 'PullRequestChangedFileConnection',
    nodes: slice.map((file) => ({ __typename: 'PullRequestChangedFile', file })),
    pageInfo: { __typename: 'PageInfo', hasNextPage: files.length > slice.length, hasPreviousPage: false, endCursor: null, startCursor: null },
  };
}

function resolveRepositoryId(ctx: Ctx, id: unknown): RepoRec | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGid(id);
  if (parsed === null || parsed.kind !== 'Repository') return null;
  const dbId = Number(parsed.parts[0]);
  return ctx.store.getRepoById(dbId) ?? null;
}

function resolveIssueId(ctx: Ctx, id: unknown): { repo: RepoRec; issue: IssueRec } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGid(id);
  if (parsed === null || parsed.kind !== 'Issue') return null;
  const repo = ctx.store.getRepoById(Number(parsed.parts[0]));
  const issue = repo?.issues.get(Number(parsed.parts[1]));
  return repo !== undefined && issue !== undefined ? { repo, issue } : null;
}

function resolvePullId(ctx: Ctx, id: unknown): { repo: RepoRec; pull: PullRec } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGid(id);
  if (parsed === null || parsed.kind !== 'PullRequest') return null;
  const repo = ctx.store.getRepoById(Number(parsed.parts[0]));
  const pull = repo?.pulls.get(Number(parsed.parts[1]));
  return repo !== undefined && pull !== undefined ? { repo, pull } : null;
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userNode(),
    repository: (_source, args, ctx) => {
      const owner = args.owner;
      const name = args.name;
      if (typeof owner !== 'string' || typeof name !== 'string') return null;
      const repo = ctx.store.getRepo(owner, name);
      return repo === undefined ? null : repoNode(repo);
    },
    node: (_source, args, ctx) => {
      if (typeof args.id !== 'string') return null;
      const parsed = parseGid(args.id);
      if (parsed === null) return null;
      if (parsed.kind === 'Repository') {
        const repo = ctx.store.getRepoById(Number(parsed.parts[0]));
        return repo === undefined ? null : repoNode(repo);
      }
      if (parsed.kind === 'Issue') {
        const found = resolveIssueId(ctx, args.id);
        return found === null ? null : issueNode(found.repo, found.issue);
      }
      if (parsed.kind === 'PullRequest') {
        const found = resolvePullId(ctx, args.id);
        return found === null ? null : pullNode(found.repo, found.pull);
      }
      return null;
    },
    __type: (_source, args) => {
      const name = args.name;
      if (typeof name !== 'string') return null;
      const def = TYPE_DEFS[name];
      if (def === undefined) return null;
      return { __typename: '__Type', name, kind: def.kind, def };
    },
    __schema: () => ({
      __typename: '__Schema',
      queryType: { __typename: '__Type', name: 'Query', kind: 'OBJECT', def: TYPE_DEFS.Query },
      mutationType: { __typename: '__Type', name: 'Mutation', kind: 'OBJECT', def: TYPE_DEFS.Mutation },
      subscriptionType: null,
    }),
  },
  Mutation: {
    createIssue: (_source, args, ctx) => {
      const input = asRecord(args.input);
      const repo = resolveRepositoryId(ctx, input.repositoryId);
      if (repo === null) throw new Error('repository not found');
      const issue = createIssueRecord(ctx.store, repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return { __typename: 'CreateIssuePayload', issue: issueNode(repo, issue) };
    },
    closeIssue: (_source, args, ctx) => {
      const input = asRecord(args.input);
      const found = resolveIssueId(ctx, input.issueId);
      if (found === null) throw new Error('issue not found');
      found.issue.state = 'closed';
      const stamp = ctx.store.tick();
      found.issue.closedAt = stamp.iso;
      found.issue.updatedAt = stamp.iso;
      return { __typename: 'CloseIssuePayload', issue: issueNode(found.repo, found.issue) };
    },
    createPullRequest: (_source, args, ctx) => {
      const input = asRecord(args.input);
      const repo = resolveRepositoryId(ctx, input.repositoryId);
      if (repo === null) throw new Error('repository not found');
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      if (repo.refs.get(`refs/heads/${head}`) === undefined) throw new Error(`head branch ${head} does not exist`);
      if (repo.refs.get(`refs/heads/${base}`) === undefined) throw new Error(`base branch ${base} does not exist`);
      let pull = [...repo.pulls.values()].find((candidate) => candidate.state === 'open' && candidate.head === head && candidate.base === base);
      if (pull === undefined) {
        pull = createPullRecord(ctx.store, repo, String(input.title ?? ''), String(input.body ?? ''), head, base);
      }
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(repo, pull) };
    },
    mergePullRequest: (_source, args, ctx) => {
      const input = asRecord(args.input);
      const found = resolvePullId(ctx, input.pullRequestId);
      if (found === null) throw new Error('pull request not found');
      if (found.pull.state !== 'open') throw new Error('pull request is not open');
      const reply = mergePull(ctx.store, found.repo, found.pull);
      if (reply.status !== 200) throw new Error(String(asRecord(reply.json).message ?? 'merge failed'));
      return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(found.repo, found.pull) };
    },
    addComment: (_source, args, ctx) => {
      const input = asRecord(args.input);
      const found = resolveIssueId(ctx, input.subjectId);
      if (found === null) throw new Error('subject not found');
      const stamp = ctx.store.tick();
      const comment = { id: ctx.store.nextComment(), body: String(input.body ?? ''), seq: stamp.seq, createdAt: stamp.iso, updatedAt: stamp.iso };
      found.issue.comments.push(comment);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node: commentNode(found.repo, comment), cursor: encodeCursor(comment.id) },
      };
    },
  },
  Repository: {
    id: (source) => gid('Repository', (source.repo as RepoRec).dbId),
    databaseId: (source) => (source.repo as RepoRec).dbId,
    name: (source) => (source.repo as RepoRec).name,
    nameWithOwner: (source) => `${(source.repo as RepoRec).owner}/${(source.repo as RepoRec).name}`,
    owner: () => userNode(),
    defaultBranchRef: (source) => {
      const repo = source.repo as RepoRec;
      return repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? { __typename: 'Ref', name: repo.defaultBranch } : null;
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (source, args) => {
      const repo = source.repo as RepoRec;
      const issue = repo.issues.get(Number(args.number));
      return issue === undefined ? null : issueNode(repo, issue);
    },
    issues: (source, args) => issuesConnection(source.repo as RepoRec, args),
    pullRequests: (source, args) => pullsConnection(source.repo as RepoRec, args),
    pullRequest: (source, args) => {
      const repo = source.repo as RepoRec;
      const pull = repo.pulls.get(Number(args.number));
      return pull === undefined ? null : pullNode(repo, pull);
    },
  },
  Issue: {
    id: (source) => gid('Issue', (source.repo as RepoRec).dbId, (source.issue as IssueRec).number),
    number: (source) => (source.issue as IssueRec).number,
    title: (source) => (source.issue as IssueRec).title,
    state: (source) => issueState(source.issue as IssueRec),
    body: (source) => (source.issue as IssueRec).body,
  },
  PullRequest: {
    id: (source) => gid('PullRequest', (source.repo as RepoRec).dbId, (source.pull as PullRec).number),
    number: (source) => (source.pull as PullRec).number,
    title: (source) => (source.pull as PullRec).title,
    state: (source) => pullState(source.pull as PullRec),
    body: (source) => (source.pull as PullRec).body,
    merged: (source) => (source.pull as PullRec).merged,
    headRefName: (source) => (source.pull as PullRec).head,
    baseRefName: (source) => (source.pull as PullRec).base,
    mergeable: (source) => {
      const repo = source.repo as RepoRec;
      const pull = source.pull as PullRec;
      if (pull.state !== 'open') return 'UNKNOWN';
      return prMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
    },
    files: (source, args) => filesConnection(source.repo as RepoRec, source.pull as PullRec, args),
  },
  User: {
    login: () => VIEWER.login,
    id: () => gid('User', VIEWER.id),
    name: () => VIEWER.name,
  },
  Ref: {
    name: (source) => String(source.name),
  },
  IssueConnection: {
    nodes: (source) => source.nodes as unknown[],
    pageInfo: (source) => source.pageInfo as NodeObject,
    totalCount: (source) => Number(source.totalCount),
  },
  PullRequestConnection: {
    nodes: (source) => source.nodes as unknown[],
    pageInfo: (source) => source.pageInfo as NodeObject,
    totalCount: (source) => Number(source.totalCount),
  },
  PullRequestChangedFileConnection: {
    nodes: (source) => source.nodes as unknown[],
    pageInfo: (source) => source.pageInfo as NodeObject,
  },
  PullRequestChangedFile: {
    path: (source) => String(asRecord(source.file).filename ?? ''),
    additions: (source) => Number(asRecord(source.file).additions ?? 0),
    deletions: (source) => Number(asRecord(source.file).deletions ?? 0),
  },
  PageInfo: {
    hasNextPage: (source) => Boolean(source.hasNextPage),
    hasPreviousPage: (source) => Boolean(source.hasPreviousPage),
    endCursor: (source) => (source.endCursor ?? null) as string | null,
    startCursor: (source) => (source.startCursor ?? null) as string | null,
  },
  IssueComment: {
    id: (source) => gid('IssueComment', (source.repo as RepoRec).dbId, (source.comment as { id: number }).id),
    body: (source) => (source.comment as { body: string }).body,
  },
  IssueCommentEdge: {
    node: (source) => source.node as NodeObject,
    cursor: (source) => String(source.cursor ?? ''),
  },
  CreateIssuePayload: {
    issue: (source) => source.issue as NodeObject,
  },
  CloseIssuePayload: {
    issue: (source) => source.issue as NodeObject,
  },
  CreatePullRequestPayload: {
    pullRequest: (source) => source.pullRequest as NodeObject,
  },
  MergePullRequestPayload: {
    pullRequest: (source) => source.pullRequest as NodeObject,
  },
  AddCommentPayload: {
    commentEdge: (source) => source.commentEdge as NodeObject,
  },
  __Type: {
    name: (source) => String(source.name),
    kind: (source) => String(source.kind),
    fields: (source) => ((source.def as TypeDef).fields.map((name) => ({ __typename: '__Field', name }))),
    enumValues: (source) => ((source.def as TypeDef).enumValues.map((name) => ({ __typename: '__EnumValue', name }))),
    description: () => null,
  },
  __Field: {
    name: (source) => String(source.name),
    description: () => null,
  },
  __EnumValue: {
    name: (source) => String(source.name),
    description: () => null,
  },
  __Schema: {
    queryType: (source) => source.queryType as NodeObject,
    mutationType: (source) => source.mutationType as NodeObject,
    subscriptionType: () => null,
    types: () => [],
    directives: () => [],
  },
};

function executeSelectionSet(
  typeName: string,
  source: NodeObject,
  selections: SelectionNode[],
  ctx: Ctx,
  path: Array<string | number>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) continue;
      if (fragment.typeCondition !== typeName && !(fragment.typeCondition === 'Node' && ['Repository', 'Issue', 'PullRequest'].includes(typeName))) continue;
      Object.assign(out, executeSelectionSet(typeName, source, fragment.selectionSet, ctx, path));
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== typeName) {
        if (!(selection.typeCondition === 'Node' && ['Repository', 'Issue', 'PullRequest'].includes(typeName))) continue;
      }
      Object.assign(out, executeSelectionSet(typeName, source, selection.selectionSet, ctx, path));
      continue;
    }
    const responseKey = selection.alias ?? selection.name;
    const fieldPath = [...path, responseKey];
    if (selection.name === '__typename') {
      out[responseKey] = typeName;
      continue;
    }
    const table = RESOLVERS[typeName];
    const resolver = table?.[selection.name];
    if (resolver === undefined) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".`, path: fieldPath });
      out[responseKey] = null;
      continue;
    }
    let value: unknown;
    try {
      value = resolver(source, argsOf(selection, ctx.variables), ctx);
    } catch (error) {
      ctx.errors.push({ message: error instanceof Error ? error.message : String(error), path: fieldPath });
      out[responseKey] = null;
      continue;
    }
    out[responseKey] = completeValue(value, selection, ctx, fieldPath);
  }
  return out;
}

function completeValue(value: unknown, field: FieldNode, ctx: Ctx, path: Array<string | number>): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item, index) => completeValue(item, field, ctx, [...path, index]));
  }
  if (typeof value === 'object') {
    const node = value as NodeObject;
    if (typeof node.__typename === 'string' && field.selectionSet !== null) {
      return executeSelectionSet(node.__typename, node, field.selectionSet, ctx, path);
    }
    return value;
  }
  return value;
}

function executeOperation(
  store: Store,
  operation: OperationNode,
  fragments: Map<string, FragmentNode>,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const variable of operation.variables) {
    if (variables[variable.name] !== undefined) merged[variable.name] = variables[variable.name];
    else if (variable.defaultValue !== null) merged[variable.name] = valueOf(variable.defaultValue, variables);
  }
  for (const [key, val] of Object.entries(variables)) {
    if (!(key in merged)) merged[key] = val;
  }
  const ctx: Ctx = { store, variables: merged, fragments, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(rootType, { __typename: rootType }, operation.selectionSet, ctx, []);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

export interface GraphQLRequestBody {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

/** Execute one GraphQL request body (or a batch array); always HTTP 200 with a GraphQL body. */
export function executeGraphQL(store: Store, body: unknown): unknown {
  if (Array.isArray(body)) {
    return body.map((item) => executeGraphQL(store, item));
  }
  if (body === null || typeof body !== 'object' || typeof (body as GraphQLRequestBody).query !== 'string') {
    return { errors: [{ message: 'query must be a string' }] };
  }
  const request = body as GraphQLRequestBody;
  const query = request.query as string;
  const variables = request.variables !== null && typeof request.variables === 'object' && !Array.isArray(request.variables)
    ? (request.variables as Record<string, unknown>)
    : {};
  let definitions: Array<OperationNode | FragmentNode>;
  try {
    definitions = new Parser(lex(query)).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  const fragments = new Map<string, FragmentNode>();
  const operations: OperationNode[] = [];
  for (const definition of definitions) {
    if (definition.kind === 'fragment') fragments.set(definition.name, definition);
    else operations.push(definition);
  }
  let operation: OperationNode | undefined;
  if (typeof request.operationName === 'string') {
    operation = operations.find((candidate) => candidate.name === request.operationName);
    if (operation === undefined) return { errors: [{ message: `unknown operation ${request.operationName}` }] };
  } else {
    operation = operations[0];
  }
  if (operation === undefined) return { errors: [{ message: 'no operation provided' }] };
  try {
    return executeOperation(store, operation, fragments, variables);
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
}
