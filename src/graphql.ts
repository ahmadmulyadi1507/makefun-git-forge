// graphql.ts — a small GraphQL parser + executor for the documented
// operations only (viewer, repository, node, __type, and the five mutations
// the gh CLI sends). Unknown fields are reported in an errors array with
// HTTP 200, as the suite requires.

import { diffTrees, parseCommit, threeWayMerge, buildCommit } from './git.ts';
import {
  Store,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  decodeGlobalId,
  globalId,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

// ------------------------------------------------------------------ parser

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Record<string, Value> };

interface Field {
  alias: string | null;
  name: string;
  args: Record<string, Value>;
  selection: Selection | null;
}

interface Fragment {
  typeCondition: string | null;
  selection: Selection;
}

type Selection = Array<Field | Fragment>;

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, Value>;
  selection: Selection;
}

function tokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c) || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}():$![]=@'.includes(c)) {
      tokens.push(c);
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1];
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < src.length && /[A-Za-z0-9_.-]/.test(src[j]) && !/[\s,{}():$![]=@]/.test(src[j])) j += 1;
    tokens.push(src.slice(i, j));
    i = j;
  }
  return tokens;
}

class Parser {
  tokens: string[];
  pos = 0;

  constructor(src: string) {
    this.tokens = tokenize(src);
  }

  peek(): string | undefined {
    return this.tokens[this.pos];
  }

  next(): string {
    const t = this.tokens[this.pos];
    this.pos += 1;
    return t;
  }

  expect(t: string): void {
    const got = this.next();
    if (got !== t) throw new Error(`expected ${t}, got ${got}`);
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.pos < this.tokens.length) {
      ops.push(this.parseOperation());
    }
    return ops;
  }

  parseOperation(): Operation {
    let type: 'query' | 'mutation' = 'query';
    const tok = this.peek();
    if (tok === 'query' || tok === 'mutation') {
      type = this.next() as 'query' | 'mutation';
    }
    let name: string | null = null;
    if (this.peek() && this.peek() !== '{' && this.peek() !== '(') {
      name = this.next();
    }
    if (this.peek() === '(') this.skipParens();
    const selection = this.parseSelection();
    return { type, name, variables: {}, selection };
  }

  skipParens(): void {
    let depth = 0;
    while (this.pos < this.tokens.length) {
      const t = this.next();
      if (t === '(') depth += 1;
      else if (t === ')') {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }

  parseSelection(): Selection {
    this.expect('{');
    const sel: Selection = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        let typeCondition: string | null = null;
        if (this.peek() === 'on') {
          this.next();
          typeCondition = this.next();
        }
        const inner = this.parseSelection();
        sel.push({ typeCondition, selection: inner });
        continue;
      }
      const first = this.next();
      let alias: string | null = null;
      let name = first;
      if (this.peek() === ':') {
        this.next();
        alias = first;
        name = this.next();
      }
      const args: Record<string, Value> = {};
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')') {
          const argName = this.next();
          this.expect(':');
          args[argName] = this.parseValue();
        }
        this.next();
      }
      let sub: Selection | null = null;
      if (this.peek() === '{') sub = this.parseSelection();
      sel.push({ alias, name, args, selection: sub });
    }
    this.expect('}');
    return sel;
  }

  parseValue(): Value {
    const t = this.next();
    if (t === '$') return { kind: 'var', name: this.next() };
    if (t === '[') {
      const values: Value[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.next();
      return { kind: 'list', values };
    }
    if (t === '{') {
      const fields: Record<string, Value> = {};
      while (this.peek() !== '}') {
        const k = this.next();
        this.expect(':');
        fields[k] = this.parseValue();
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (t.startsWith('"')) return { kind: 'string', value: JSON.parse(t) };
    if (t === 'true') return { kind: 'bool', value: true };
    if (t === 'false') return { kind: 'bool', value: false };
    if (t === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(t)) return { kind: 'int', value: Number(t) };
    if (/^-?\d+\.\d+$/.test(t)) return { kind: 'float', value: Number(t) };
    return { kind: 'enum', value: t };
  }
}

// ------------------------------------------------------------------ executor

interface Ctx {
  store: Store;
  errors: Array<{ message: string }>;
  variables: Record<string, unknown>;
}

function resolveValue(v: Value, ctx: Ctx): unknown {
  switch (v.kind) {
    case 'var':
      return ctx.variables[v.name];
    case 'string':
    case 'int':
    case 'float':
    case 'bool':
      return v.value;
    case 'null':
      return null;
    case 'enum':
      return v.value;
    case 'list':
      return v.values.map((x) => resolveValue(x, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v.fields)) out[k] = resolveValue(val, ctx);
      return out;
    }
  }
}

function argValue(field: Field, name: string, ctx: Ctx): unknown {
  const v = field.args[name];
  return v === undefined ? undefined : resolveValue(v, ctx);
}

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'createdAt', 'updatedAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  User: ['id', 'login', 'name', 'email'],
  Viewer: ['id', 'login', 'name', 'email'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

function unknownField(ctx: Ctx, typeName: string, fieldName: string): null {
  ctx.errors.push({ message: `Cannot query field "${fieldName}" on type "${typeName}".` });
  return null;
}

interface TypedObject {
  __typename: string;
  [key: string]: unknown;
}

function repoObject(store: Store, repo: Repo): TypedObject {
  return {
    __typename: 'Repository',
    __repo: repo,
    id: globalId('Repository', repo.databaseId),
    databaseId: repo.databaseId,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { __typename: 'User', login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 1001 },
    defaultBranchRef: { __typename: 'Ref', name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
}

function issueObject(store: Store, repo: Repo, issue: Issue): TypedObject {
  return {
    __typename: 'Issue',
    __repo: repo,
    __issue: issue,
    id: globalId('Issue', repo.databaseId, issue.number),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
  };
}

function pullObject(store: Store, repo: Repo, pull: Pull): TypedObject {
  const mergeable = computeMergeable(store, repo, pull);
  return {
    __typename: 'PullRequest',
    __repo: repo,
    __pull: pull,
    id: globalId('PullRequest', repo.databaseId, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    mergeable,
    headRefName: pull.head,
    baseRefName: pull.base,
    headRef: { __typename: 'Ref', name: pull.head },
    baseRef: { __typename: 'Ref', name: pull.base },
  };
}

function computeMergeable(store: Store, repo: Repo, pull: Pull): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  if (!baseTip) return 'UNKNOWN';
  const baseInfo = parseCommit(repo.objects.get(pull.mergeBase)!.data);
  const headInfo = parseCommit(repo.objects.get(pull.headSha)!.data);
  const currentInfo = parseCommit(repo.objects.get(baseTip)!.data);
  const merged = threeWayMerge(repo, baseInfo.tree, headInfo.tree, currentInfo.tree);
  return merged === null ? 'CONFLICTING' : 'MERGEABLE';
}

export function doMergePull(store: Store, repo: Repo, pull: Pull): { ok: boolean; sha?: string } {
  if (pull.state !== 'open') return { ok: false };
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  if (!baseTip) return { ok: false };
  const baseInfo = parseCommit(repo.objects.get(pull.mergeBase)!.data);
  const headInfo = parseCommit(repo.objects.get(pull.headSha)!.data);
  const currentInfo = parseCommit(repo.objects.get(baseTip)!.data);
  const mergedTree = threeWayMerge(repo, baseInfo.tree, headInfo.tree, currentInfo.tree);
  if (mergedTree === null) return { ok: false };
  const ts = store.nowEpoch();
  const stamp = `${ts} +0000`;
  const mergeSha = buildCommit(repo, {
    tree: mergedTree,
    parents: [baseTip],
    author: `${VIEWER_LOGIN} <${VIEWER_EMAIL}> ${stamp}`,
    committer: `${VIEWER_LOGIN} <${VIEWER_EMAIL}> ${stamp}`,
    message: `${pull.title} (#${pull.number})`,
    timestamp: ts,
  });
  repo.refs.set(`refs/heads/${pull.base}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = mergeSha;
  pull.mergedAt = store.nowIso();
  pull.baseSha = mergeSha;
  return { ok: true, sha: mergeSha };
}

function cursorFor(seq: number): string {
  return Buffer.from(`cursor:${seq}`).toString('base64');
}

function seqFromCursor(cursor: string | null | undefined): number | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, 'base64').toString('utf8');
    const m = raw.match(/^cursor:(\d+)$/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function paginateIssues(store: Store, repo: Repo, field: Field, ctx: Ctx): TypedObject {
  const first = (argValue(field, 'first', ctx) as number | undefined) ?? 10;
  const after = argValue(field, 'after', ctx) as string | null | undefined;
  const states = argValue(field, 'states', ctx) as string[] | undefined;
  const orderBy = argValue(field, 'orderBy', ctx) as { field?: string; direction?: string } | undefined;
  const direction = orderBy?.direction === 'ASC' ? 'asc' : 'desc';
  let list = [...repo.issues];
  if (states && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  const afterSeq = seqFromCursor(after);
  if (afterSeq !== null) {
    list = list.filter((i) => (direction === 'asc' ? i.seq > afterSeq : i.seq < afterSeq));
  }
  const page = list.slice(0, first);
  const hasNextPage = list.length > first;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1].seq) : null;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((i) => issueObject(store, repo, i)),
    edges: page.map((i) => ({ __typename: 'IssueEdge', cursor: cursorFor(i.seq), node: issueObject(store, repo, i) })),
    totalCount: list.length,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: afterSeq !== null,
      startCursor: page.length > 0 ? cursorFor(page[0].seq) : null,
      endCursor,
    },
  };
}

function paginatePulls(store: Store, repo: Repo, field: Field, ctx: Ctx): TypedObject {
  const first = (argValue(field, 'first', ctx) as number | undefined) ?? 10;
  const after = argValue(field, 'after', ctx) as string | null | undefined;
  const states = argValue(field, 'states', ctx) as string[] | undefined;
  let list = [...repo.pulls];
  if (states && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((p) => wanted.has(p.state));
  }
  list.sort((a, b) => b.seq - a.seq);
  const afterSeq = seqFromCursor(after);
  if (afterSeq !== null) list = list.filter((p) => p.seq < afterSeq);
  const page = list.slice(0, first);
  const hasNextPage = list.length > first;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1].seq) : null;
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((p) => pullObject(store, repo, p)),
    edges: page.map((p) => ({ __typename: 'PullRequestEdge', cursor: cursorFor(p.seq), node: pullObject(store, repo, p) })),
    totalCount: list.length,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: afterSeq !== null,
      startCursor: page.length > 0 ? cursorFor(page[0].seq) : null,
      endCursor,
    },
  };
}

function resolveObjectField(ctx: Ctx, obj: TypedObject, field: Field): unknown {
  const typeName = obj.__typename;
  const name = field.name;
  const store = ctx.store;

  // Repository
  if (typeName === 'Repository') {
    const repo = obj.__repo as Repo;
    switch (name) {
      case 'id':
      case 'databaseId':
      case 'name':
      case 'nameWithOwner':
      case 'owner':
      case 'defaultBranchRef':
      case 'viewerPermission':
      case 'hasIssuesEnabled':
        return obj[name];
      case 'issue': {
        const number = argValue(field, 'number', ctx) as number;
        const issue = repo.issues.find((i) => i.number === number);
        return issue ? issueObject(store, repo, issue) : null;
      }
      case 'issues':
        return paginateIssues(store, repo, field, ctx);
      case 'pullRequests':
        return paginatePulls(store, repo, field, ctx);
      case 'pullRequest': {
        const number = argValue(field, 'number', ctx) as number;
        const pull = repo.pulls.find((p) => p.number === number);
        return pull ? pullObject(store, repo, pull) : null;
      }
      default:
        return unknownField(ctx, 'Repository', name);
    }
  }

  // Issue
  if (typeName === 'Issue') {
    switch (name) {
      case 'id':
      case 'number':
      case 'title':
      case 'state':
      case 'body':
        return obj[name];
      case 'author':
        return { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID };
      case 'comments': {
        const issue = obj.__issue as Issue;
        return {
          __typename: 'IssueCommentConnection',
          nodes: issue.comments.map((c) => ({
            __typename: 'IssueComment',
            id: globalId('IssueComment', (obj.__repo as Repo).databaseId, c.id),
            body: c.body,
          })),
          totalCount: issue.comments.length,
        };
      }
      default:
        return unknownField(ctx, 'Issue', name);
    }
  }

  // PullRequest
  if (typeName === 'PullRequest') {
    const repo = obj.__repo as Repo;
    const pull = obj.__pull as Pull;
    switch (name) {
      case 'id':
      case 'number':
      case 'title':
      case 'body':
      case 'state':
      case 'merged':
      case 'mergeable':
      case 'headRefName':
      case 'baseRefName':
      case 'headRef':
      case 'baseRef':
        return obj[name];
      case 'files': {
        const first = (argValue(field, 'first', ctx) as number | undefined) ?? 10;
        const baseInfo = parseCommit(repo.objects.get(pull.mergeBase)!.data);
        const headInfo = parseCommit(repo.objects.get(pull.headSha)!.data);
        const diffs = diffTrees(repo, baseInfo.tree, headInfo.tree).slice(0, first);
        return {
          __typename: 'PullRequestChangedFileConnection',
          nodes: diffs.map((d) => ({ __typename: 'PullRequestChangedFile', path: d.filename, additions: d.additions, deletions: d.deletions, changeType: d.status.toUpperCase() })),
          totalCount: diffs.length,
        };
      }
      case 'createdAt':
        return pull.createdAt;
      case 'updatedAt':
        return pull.createdAt;
      default:
        return unknownField(ctx, 'PullRequest', name);
    }
  }

  // User / Viewer
  if (typeName === 'User' || typeName === 'Viewer') {
    switch (name) {
      case 'id':
        return globalId('User', VIEWER_ID);
      case 'login':
        return VIEWER_LOGIN;
      case 'name':
        return 'ada iversen';
      case 'email':
        return VIEWER_EMAIL;
      default:
        return unknownField(ctx, typeName, name);
    }
  }

  // Connections
  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'IssueCommentConnection' || typeName === 'PullRequestChangedFileConnection') {
    switch (name) {
      case 'nodes':
      case 'edges':
      case 'totalCount':
      case 'pageInfo':
        return obj[name] ?? null;
      default:
        return unknownField(ctx, typeName, name);
    }
  }
  if (typeName === 'IssueEdge' || typeName === 'PullRequestEdge') {
    return name === 'cursor' || name === 'node' ? obj[name] : unknownField(ctx, typeName, name);
  }
  if (typeName === 'PageInfo') {
    switch (name) {
      case 'hasNextPage':
      case 'hasPreviousPage':
      case 'startCursor':
      case 'endCursor':
        return obj[name] ?? null;
      default:
        return unknownField(ctx, typeName, name);
    }
  }
  if (typeName === 'Ref') {
    if (name === 'name') return obj.name;
    return unknownField(ctx, 'Ref', name);
  }
  if (typeName === 'IssueComment') {
    if (name === 'id' || name === 'body') return obj[name];
    return unknownField(ctx, 'IssueComment', name);
  }
  if (typeName === 'PullRequestChangedFile') {
    if (['path', 'additions', 'deletions', 'changeType'].includes(name)) return obj[name];
    return unknownField(ctx, 'PullRequestChangedFile', name);
  }
  if (typeName === '__Type') {
    switch (name) {
      case 'name':
      case 'kind':
      case 'description':
        return obj[name] ?? null;
      case 'fields': {
        const typeName2 = obj.__typeName as string;
        const fields = TYPE_FIELDS[typeName2] ?? [];
        return fields.map((f) => ({ __typename: '__Field', name: f, type: { __typename: '__Type', name: 'String', kind: 'SCALAR' } }));
      }
      case 'enumValues': {
        const typeName2 = obj.__typeName as string;
        const values = ENUM_VALUES[typeName2] ?? [];
        return values.map((v) => ({ __typename: '__EnumValue', name: v, description: null }));
      }
      default:
        return unknownField(ctx, '__Type', name);
    }
  }
  if (typeName === '__Field') {
    if (name === 'name') return obj.name;
    if (name === 'type') return obj.type;
    return unknownField(ctx, '__Field', name);
  }
  if (typeName === '__EnumValue') {
    if (name === 'name' || name === 'description') return obj[name] ?? null;
    return unknownField(ctx, '__EnumValue', name);
  }
  if (typeName === 'IssueCreatePayload' || typeName === 'CloseIssuePayload' || typeName === 'CreatePullRequestPayload' || typeName === 'MergePullRequestPayload' || typeName === 'AddCommentPayload') {
    return obj[name] ?? unknownField(ctx, typeName, name);
  }
  if (typeName === 'IssueCommentEdge') {
    if (name === 'node' || name === 'cursor') return obj[name] ?? null;
    return unknownField(ctx, typeName, name);
  }

  return unknownField(ctx, typeName, name);
}

function selectFields(ctx: Ctx, obj: unknown, sel: Selection | null, typeName: string): unknown {
  if (sel === null) return obj;
  if (obj === null || obj === undefined) return null;
  if (Array.isArray(obj)) return obj.map((item) => selectFields(ctx, item, sel, typeName));
  if (typeof obj !== 'object') return obj;
  const typed = obj as TypedObject;
  const out: Record<string, unknown> = {};
  for (const item of sel) {
    if ('typeCondition' in item) {
      const frag = item as Fragment;
      if (frag.typeCondition && frag.typeCondition !== typed.__typename) continue;
      const nested = selectFields(ctx, obj, frag.selection, typed.__typename);
      if (nested && typeof nested === 'object') Object.assign(out, nested);
      continue;
    }
    const field = item as Field;
    const key = field.alias ?? field.name;
    const value = resolveObjectField(ctx, typed, field);
    out[key] = value === null || value === undefined ? value : selectFields(ctx, value, field.selection, typed.__typename);
  }
  return out;
}

function executeRoot(ctx: Ctx, op: Operation): Record<string, unknown> {
  const store = ctx.store;
  const out: Record<string, unknown> = {};
  for (const item of op.selection) {
    if ('typeCondition' in item) continue;
    const field = item as Field;
    const key = field.alias ?? field.name;
    const name = field.name;

    if (op.type === 'query') {
      if (name === 'viewer') {
        const viewer: TypedObject = { __typename: 'Viewer', login: VIEWER_LOGIN, id: VIEWER_ID, name: 'ada iversen', email: VIEWER_EMAIL };
        out[key] = selectFields(ctx, viewer, field.selection, 'Viewer');
        continue;
      }
      if (name === 'repository') {
        const owner = argValue(field, 'owner', ctx) as string;
        const repoName = argValue(field, 'name', ctx) as string;
        const repo = owner === VIEWER_LOGIN ? store.getRepo(owner, repoName) : undefined;
        if (!repo) {
          out[key] = null;
          continue;
        }
        out[key] = selectFields(ctx, repoObject(store, repo), field.selection, 'Repository');
        continue;
      }
      if (name === 'node') {
        const id = argValue(field, 'id', ctx) as string;
        const decoded = decodeGlobalId(id);
        let obj: TypedObject | null = null;
        if (decoded?.kind === 'Repository') {
          const dbId = Number(decoded.parts[0]);
          const repo = [...store.repos.values()].find((r) => r.databaseId === dbId);
          if (repo) obj = repoObject(store, repo);
        } else if (decoded?.kind === 'Issue') {
          const dbId = Number(decoded.parts[0]);
          const number = Number(decoded.parts[1]);
          const repo = [...store.repos.values()].find((r) => r.databaseId === dbId);
          const issue = repo?.issues.find((i) => i.number === number);
          if (repo && issue) obj = issueObject(store, repo, issue);
        } else if (decoded?.kind === 'PullRequest') {
          const dbId = Number(decoded.parts[0]);
          const number = Number(decoded.parts[1]);
          const repo = [...store.repos.values()].find((r) => r.databaseId === dbId);
          const pull = repo?.pulls.find((p) => p.number === number);
          if (repo && pull) obj = pullObject(store, repo, pull);
        }
        out[key] = obj ? selectFields(ctx, obj, field.selection, obj.__typename) : null;
        continue;
      }
      if (name === '__type') {
        const typeName = argValue(field, 'name', ctx) as string;
        const known = TYPE_FIELDS[typeName] !== undefined || ENUM_VALUES[typeName] !== undefined;
        if (!known) {
          out[key] = null;
          continue;
        }
        const typeObj: TypedObject = {
          __typename: '__Type',
          __typeName: typeName,
          name: typeName,
          kind: ENUM_VALUES[typeName] ? 'ENUM' : 'OBJECT',
          description: null,
        };
        out[key] = selectFields(ctx, typeObj, field.selection, '__Type');
        continue;
      }
      if (name === '__schema') {
        out[key] = { __typename: '__Schema', types: [] };
        continue;
      }
      ctx.errors.push({ message: `Cannot query field "${name}" on type "Query".` });
      out[key] = null;
      continue;
    }

    // mutations
    const input = (argValue(field, 'input', ctx) as Record<string, unknown> | undefined) ?? {};
    if (name === 'createIssue') {
      const repoId = String(input.repositoryId ?? '');
      const decoded = decodeGlobalId(repoId);
      const repo = decoded?.kind === 'Repository' ? [...store.repos.values()].find((r) => r.databaseId === Number(decoded.parts[0])) : undefined;
      if (!repo) {
        ctx.errors.push({ message: 'Repository not found for createIssue.' });
        out[key] = null;
        continue;
      }
      repo.issueCounter += 1;
      const createdAt = store.nowIso();
      const issue: Issue = {
        number: repo.issueCounter,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        labels: [],
        seq: store.seq,
        createdAt,
        updatedAt: createdAt,
        comments: [],
      };
      repo.issues.push(issue);
      const payload: TypedObject = {
        __typename: 'IssueCreatePayload',
        issue: issueObject(store, repo, issue),
        clientMutationId: (input.clientMutationId as string | null) ?? null,
      };
      out[key] = selectFields(ctx, payload, field.selection, 'IssueCreatePayload');
      continue;
    }
    if (name === 'closeIssue') {
      const issueId = String(input.issueId ?? '');
      const decoded = decodeGlobalId(issueId);
      let found: { repo: Repo; issue: Issue } | null = null;
      if (decoded?.kind === 'Issue') {
        const repo = [...store.repos.values()].find((r) => r.databaseId === Number(decoded.parts[0]));
        const issue = repo?.issues.find((i) => i.number === Number(decoded.parts[1]));
        if (repo && issue) found = { repo, issue };
      }
      if (!found) {
        ctx.errors.push({ message: 'Issue not found for closeIssue.' });
        out[key] = null;
        continue;
      }
      found.issue.state = 'closed';
      found.issue.updatedAt = store.nowIso();
      const payload: TypedObject = {
        __typename: 'CloseIssuePayload',
        issue: issueObject(store, found.repo, found.issue),
        clientMutationId: (input.clientMutationId as string | null) ?? null,
      };
      out[key] = selectFields(ctx, payload, field.selection, 'CloseIssuePayload');
      continue;
    }
    if (name === 'createPullRequest') {
      const repoId = String(input.repositoryId ?? '');
      const decoded = decodeGlobalId(repoId);
      const repo = decoded?.kind === 'Repository' ? [...store.repos.values()].find((r) => r.databaseId === Number(decoded.parts[0])) : undefined;
      if (!repo) {
        ctx.errors.push({ message: 'Repository not found for createPullRequest.' });
        out[key] = null;
        continue;
      }
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) {
        ctx.errors.push({ message: 'Head or base branch does not exist.' });
        out[key] = null;
        continue;
      }
      repo.pullCounter += 1;
      const createdAt = store.nowIso();
      const pull: Pull = {
        number: repo.pullCounter,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
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
      const payload: TypedObject = {
        __typename: 'CreatePullRequestPayload',
        pullRequest: pullObject(store, repo, pull),
        clientMutationId: (input.clientMutationId as string | null) ?? null,
      };
      out[key] = selectFields(ctx, payload, field.selection, 'CreatePullRequestPayload');
      continue;
    }
    if (name === 'mergePullRequest') {
      const pullId = String(input.pullRequestId ?? '');
      const decoded = decodeGlobalId(pullId);
      let found: { repo: Repo; pull: Pull } | null = null;
      if (decoded?.kind === 'PullRequest') {
        const repo = [...store.repos.values()].find((r) => r.databaseId === Number(decoded.parts[0]));
        const pull = repo?.pulls.find((p) => p.number === Number(decoded.parts[1]));
        if (repo && pull) found = { repo, pull };
      }
      if (!found) {
        ctx.errors.push({ message: 'Pull request not found for mergePullRequest.' });
        out[key] = null;
        continue;
      }
      const merged = doMergePull(store, found.repo, found.pull);
      if (!merged.ok) {
        ctx.errors.push({ message: 'Pull request is not mergeable.' });
        out[key] = null;
        continue;
      }
      const payload: TypedObject = {
        __typename: 'MergePullRequestPayload',
        pullRequest: pullObject(store, found.repo, found.pull),
        clientMutationId: (input.clientMutationId as string | null) ?? null,
      };
      out[key] = selectFields(ctx, payload, field.selection, 'MergePullRequestPayload');
      continue;
    }
    if (name === 'addComment') {
      const subjectId = String(input.subjectId ?? '');
      const decoded = decodeGlobalId(subjectId);
      let found: { repo: Repo; issue: Issue } | null = null;
      if (decoded?.kind === 'Issue') {
        const repo = [...store.repos.values()].find((r) => r.databaseId === Number(decoded.parts[0]));
        const issue = repo?.issues.find((i) => i.number === Number(decoded.parts[1]));
        if (repo && issue) found = { repo, issue };
      }
      if (!found) {
        ctx.errors.push({ message: 'Subject not found for addComment.' });
        out[key] = null;
        continue;
      }
      found.repo.commentCounter += 1;
      const comment = {
        id: found.repo.commentCounter,
        body: String(input.body ?? ''),
        user: VIEWER_LOGIN,
        createdAt: store.nowIso(),
      };
      found.issue.comments.push(comment);
      const node: TypedObject = {
        __typename: 'IssueComment',
        id: globalId('IssueComment', found.repo.databaseId, comment.id),
        body: comment.body,
      };
      const payload: TypedObject = {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', cursor: cursorFor(comment.id), node },
        subject: issueObject(store, found.repo, found.issue),
        clientMutationId: (input.clientMutationId as string | null) ?? null,
      };
      out[key] = selectFields(ctx, payload, field.selection, 'AddCommentPayload');
      continue;
    }
    ctx.errors.push({ message: `Cannot query field "${name}" on type "Mutation".` });
    out[key] = null;
  }
  return out;
}

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

export function executeGraphQL(store: Store, query: string, variables: Record<string, unknown>): GraphQLResult {
  const ctx: Ctx = { store, errors: [], variables };
  let ops: Operation[];
  try {
    ops = new Parser(query).parseDocument();
  } catch (e) {
    return { data: null, errors: [{ message: `Syntax Error: ${(e as Error).message}` }] };
  }
  if (ops.length === 1) {
    const data = executeRoot(ctx, ops[0]);
    const result: GraphQLResult = { data };
    if (ctx.errors.length > 0) result.errors = ctx.errors;
    return result;
  }
  // A batch is handled by the caller (array body); this path is unused.
  const data = executeRoot(ctx, ops[0]);
  const result: GraphQLResult = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

export function executeGraphQLBatch(
  store: Store,
  docs: Array<{ query: string; variables?: Record<string, unknown> }>,
): GraphQLResult[] {
  return docs.map((d) => executeGraphQL(store, d.query, d.variables ?? {}));
}
