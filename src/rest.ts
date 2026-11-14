// rest.ts — GitHub REST v3 API (/api/v3) handlers.
// Every reply is application/json, never HTML, and carries a non-empty
// X-GitHub-Request-Id. Errors carry {message: string}.

import {
  buildCommit,
  buildTree,
  buildTreeFromPaths,
  diffTrees,
  flattenTree,
  hashObject,
  isOid,
  parseCommit,
  parseTree,
  peelToCommit,
  reachableCommits,
  storeObject,
  threeWayMerge,
  ZERO_OID,
} from './git.ts';
import { Store, VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, userJson, type Repo } from './store.ts';

export interface HttpRequest {
  method: string;
  path: string; // decoded path, no query
  query: URLSearchParams;
  headers: Record<string, string>;
  body: Buffer;
  baseUrl: string; // e.g. http://127.0.0.1:PORT
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string; // already serialised
}

const json = (store: Store, status: number, value: unknown, extra?: Record<string, string>): HttpResponse => ({
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': store.nextRequestId(),
    ...extra,
  },
  body: JSON.stringify(value),
});

const err = (store: Store, status: number, message: string): HttpResponse =>
  json(store, status, { message, documentation_url: 'https://example.invalid/docs' });

function parseJsonBody(req: HttpRequest): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (req.body.length === 0) return { ok: true, value: {} };
  try {
    const v = JSON.parse(req.body.toString('utf8'));
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return { ok: false };
    return { ok: true, value: v as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function repoJson(store: Store, repo: Repo, baseUrl: string): Record<string, unknown> {
  const full = `${repo.owner}/${repo.name}`;
  return {
    id: repo.databaseId,
    node_id: Buffer.from(`Repository:${repo.databaseId}`).toString('base64'),
    name: repo.name,
    full_name: full,
    owner: userJson(repo.owner),
    private: repo.private,
    html_url: `${baseUrl}/${full}`,
    description: repo.description,
    fork: false,
    url: `${baseUrl}/api/v3/repos/${full}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    git_url: `git://example.invalid/${full}.git`,
    ssh_url: `git@example.invalid:${full}.git`,
    clone_url: `${baseUrl}/${full}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function issueJson(repo: Repo, issue: Repo['issues'][number]): Record<string, unknown> {
  return {
    id: repo.databaseId * 1_000_000 + issue.number,
    node_id: Buffer.from(`Issue:${repo.databaseId}:${issue.number}`).toString('base64'),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    labels_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    user: userJson(VIEWER_LOGIN),
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed', description: '' })),
    state: issue.state,
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    author_association: 'OWNER',
  };
}

function pullJson(repo: Repo, pull: Repo['pulls'][number]): Record<string, unknown> {
  return {
    id: repo.databaseId * 1_000_000 + pull.number,
    node_id: Buffer.from(`PullRequest:${repo.databaseId}:${pull.number}`).toString('base64'),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userJson(VIEWER_LOGIN),
    labels: [],
    created_at: pull.createdAt,
    updated_at: pull.createdAt,
    closed_at: pull.state === 'closed' ? pull.createdAt : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: true,
    mergeable_state: 'clean',
    head: { label: `${repo.owner}:${pull.head}`, ref: pull.head, sha: pull.headSha, user: userJson(VIEWER_LOGIN) },
    base: { label: `${repo.owner}:${pull.base}`, ref: pull.base, sha: pull.baseSha, user: userJson(VIEWER_LOGIN) },
  };
}

function resolveRef(repo: Repo, ref: string): string | null {
  // branch name, full ref, HEAD, commit oid (full or unique prefix)
  if (ref === 'HEAD') {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  if (ref.startsWith('refs/')) {
    return repo.refs.get(ref) ?? (repo.objects.has(ref) ? ref : null);
  }
  const direct = repo.refs.get(`refs/heads/${ref}`);
  if (direct) return direct;
  if (isOid(ref)) return repo.objects.has(ref) ? ref : null;
  if (/^[0-9a-f]{7,39}$/.test(ref)) {
    const matches = [...repo.objects.keys()].filter((k) => k.startsWith(ref));
    if (matches.length === 1) return matches[0];
  }
  return null;
}

function commitIdentity(store: Store): { name: string; email: string } {
  return { name: VIEWER_LOGIN, email: VIEWER_EMAIL };
}

/** Create a commit on a branch (or unborn default branch) from a file map. */
function commitFiles(
  store: Store,
  repo: Repo,
  branch: string,
  message: string,
  files: Map<string, { mode: string; oid: string }>,
): string {
  const refName = `refs/heads/${branch}`;
  const parent = repo.refs.get(refName);
  let baseFiles = new Map<string, { mode: string; oid: string }>();
  if (parent) {
    const info = parseCommit(repo.objects.get(parent)!.data);
    baseFiles = flattenTree(repo, info.tree);
  }
  for (const [path, v] of files) {
    if (v.oid === '') baseFiles.delete(path);
    else baseFiles.set(path, v);
  }
  const treeOid = buildTreeFromPaths(repo, baseFiles);
  const ts = store.nowEpoch();
  const ident = commitIdentity(store);
  const stamp = `${ts} +0000`;
  const commitOid = buildCommit(repo, {
    tree: treeOid,
    parents: parent ? [parent] : [],
    author: `${ident.name} <${ident.email}> ${stamp}`,
    committer: `${ident.name} <${ident.email}> ${stamp}`,
    message,
    timestamp: ts,
  });
  repo.refs.set(refName, commitOid);
  repo.updatedAt = store.nowIso();
  return commitOid;
}

function getBlobAt(repo: Repo, treeOid: string, path: string): { mode: string; oid: string } | null {
  const flat = flattenTree(repo, treeOid);
  return flat.get(path) ?? null;
}

export function handleRest(store: Store, req: HttpRequest): HttpResponse {
  const parts = req.path.split('/').filter((p) => p.length > 0);
  // parts[0] === 'api', parts[1] === 'v3'
  const seg = parts.slice(2);

  // ---- API root and meta (no repo context) ----
  if (req.method === 'GET' && seg.length === 0) {
    return json(store, 200, {
      current_user_url: `${req.baseUrl}/api/v3/user`,
      current_user_authorizations_html_url: `${req.baseUrl}/settings`,
      authorizations_url: `${req.baseUrl}/api/v3/authorizations`,
      repository_url: `${req.baseUrl}/api/v3/repos/{owner}/{repo}`,
      user_url: `${req.baseUrl}/api/v3/users/{user}`,
      rate_limit_url: `${req.baseUrl}/api/v3/rate_limit`,
      meta: `${req.baseUrl}/api/v3/meta`,
    }, { 'x-oauth-scopes': 'repo, user', 'x-accepted-oauth-scopes': 'repo, user' });
  }
  if (req.method === 'GET' && seg.length === 1 && seg[0] === 'meta') {
    return json(store, 200, {
      verifiable_password_authentication: false,
      installed_version: '1.0.0',
      hooks: [],
      git: [],
      pages: [],
      importer: [],
      api: [],
    });
  }
  if (req.method === 'GET' && seg.length === 1 && seg[0] === 'user') {
    return json(store, 200, {
      ...userJson(VIEWER_LOGIN),
      name: 'ada iversen',
      email: VIEWER_EMAIL,
      bio: '',
      public_repos: store.repos.size,
      followers: 0,
      following: 0,
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    });
  }
  // POST /user/repos and GET /user/repos
  if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
    if (req.method === 'POST') {
      const body = parseJsonBody(req);
      if (!body.ok) return err(store, 400, 'Problems parsing JSON');
      const name = str(body.value.name);
      if (!name) return err(store, 422, 'name is required');
      if (!/^[A-Za-z0-9._-]+$/.test(name) || name.length > 100) {
        return err(store, 422, 'name is invalid');
      }
      if (store.getRepo(VIEWER_LOGIN, name)) return err(store, 422, 'name already exists on this account');
      const repo = store.createRepo(name, str(body.value.description), body.value.private === true);
      return json(store, 201, repoJson(store, repo, req.baseUrl));
    }
    if (req.method === 'GET') {
      const perPage = Math.max(1, Math.min(100, Number(req.query.get('per_page') ?? '30') || 30));
      const page = Math.max(1, Number(req.query.get('page') ?? '1') || 1);
      const all = store.listRepos();
      const totalPages = Math.max(1, Math.ceil(all.length / perPage));
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const extra: Record<string, string> = {};
      if (page < totalPages) {
        const next = `${req.baseUrl}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
        const last = `${req.baseUrl}/api/v3/user/repos?per_page=${perPage}&page=${totalPages}`;
        const first = `${req.baseUrl}/api/v3/user/repos?per_page=${perPage}&page=1`;
        extra.link = `<${next}>; rel="next", <${last}>; rel="last", <${first}>; rel="first"`;
      } else if (page > 1) {
        const prev = `${req.baseUrl}/api/v3/user/repos?per_page=${perPage}&page=${page - 1}`;
        const first = `${req.baseUrl}/api/v3/user/repos?per_page=${perPage}&page=1`;
        extra.link = `<${prev}>; rel="prev", <${first}>; rel="first"`;
      }
      return json(store, 200, slice.map((r) => repoJson(store, r, req.baseUrl)), extra);
    }
  }

  // ---- /repos/{owner}/{name}/... ----
  if (seg.length >= 3 && seg[0] === 'repos') {
    const owner = decodeURIComponent(seg[1]);
    const name = decodeURIComponent(seg[2]);
    const rest = seg.slice(3);
    const repo = store.getRepo(owner, name);
    const ownerMismatch = owner !== VIEWER_LOGIN;
    if (!repo || ownerMismatch) {
      return err(store, 404, 'Not Found');
    }

    // GET /repos/{o}/{r}
    if (req.method === 'GET' && rest.length === 0) {
      return json(store, 200, repoJson(store, repo, req.baseUrl));
    }
    // PATCH /repos/{o}/{r}
    if (req.method === 'PATCH' && rest.length === 0) {
      const body = parseJsonBody(req);
      if (!body.ok) return err(store, 400, 'Problems parsing JSON');
      if (typeof body.value.description === 'string') repo.description = body.value.description;
      if (typeof body.value.private === 'boolean') repo.private = body.value.private;
      repo.updatedAt = store.nowIso();
      return json(store, 200, repoJson(store, repo, req.baseUrl));
    }
    // DELETE /repos/{o}/{r}
    if (req.method === 'DELETE' && rest.length === 0) {
      store.repos.delete(store.key(owner, name));
      return { status: 204, headers: { 'x-github-request-id': store.nextRequestId() }, body: '' };
    }

    // ---- branches ----
    if (rest[0] === 'branches') {
      if (req.method === 'GET' && rest.length === 1) {
        const list = [...repo.refs.keys()]
          .filter((r) => r.startsWith('refs/heads/'))
          .map((r) => r.slice('refs/heads/'.length))
          .sort()
          .map((b) => ({
            name: b,
            commit: { sha: repo.refs.get(`refs/heads/${b}`)!, url: `${req.baseUrl}/api/v3/repos/${owner}/${name}/commits/${repo.refs.get(`refs/heads/${b}`)!}` },
            protected: false,
          }));
        return json(store, 200, list);
      }
      if (req.method === 'GET' && rest.length === 2) {
        const branch = decodeURIComponent(rest[1]);
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (!sha) return err(store, 404, 'Branch not found');
        return json(store, 200, {
          name: branch,
          commit: { sha, url: `${req.baseUrl}/api/v3/repos/${owner}/${name}/commits/${sha}` },
          protected: false,
        });
      }
    }

    // ---- commits ----
    if (rest[0] === 'commits' && req.method === 'GET') {
      if (rest.length === 2) {
        const sha = resolveRef(repo, decodeURIComponent(rest[1]));
        if (!sha) return err(store, 404, 'No commit found for SHA');
        const info = parseCommit(repo.objects.get(sha)!.data);
        return json(store, 200, commitJson(repo, sha, info));
      }
      const refParam = req.query.get('sha') ?? repo.defaultBranch;
      const tip = resolveRef(repo, refParam);
      if (!tip) return json(store, 200, []);
      const commits = [...reachableCommits(repo, [tip])];
      // Order: tip first, then by parent walk (BFS from tip).
      const ordered: string[] = [];
      const seen = new Set<string>();
      const queue = [tip];
      while (queue.length > 0) {
        const oid = queue.shift()!;
        if (seen.has(oid)) continue;
        seen.add(oid);
        ordered.push(oid);
        const info = parseCommit(repo.objects.get(oid)!.data);
        for (const p of info.parents) queue.push(p);
      }
      return json(store, 200, ordered.map((oid) => commitJson(repo, oid, parseCommit(repo.objects.get(oid)!.data))));
    }

    // ---- git refs ----
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (req.method === 'POST' && rest.length === 2) {
        const body = parseJsonBody(req);
        if (!body.ok) return err(store, 400, 'Problems parsing JSON');
        const ref = str(body.value.ref);
        const sha = str(body.value.sha);
        if (!ref.startsWith('refs/')) return err(store, 422, 'ref must start with refs/');
        if (!isOid(sha) || !repo.objects.has(sha)) return err(store, 422, 'Object does not exist');
        repo.refs.set(ref, sha);
        return json(store, 201, { ref, object: { sha, type: 'commit', url: `${req.baseUrl}/api/v3/repos/${owner}/${name}/git/commits/${sha}` } });
      }
      if (req.method === 'GET' && rest.length === 2) {
        const all = [...repo.refs.entries()].map(([ref, sha]) => ({
          ref,
          object: { sha, type: 'commit', url: `${req.baseUrl}/api/v3/repos/${owner}/${name}/git/commits/${sha}` },
        }));
        return json(store, 200, all);
      }
      if (req.method === 'GET' && rest.length >= 3) {
        const ref = decodeURIComponent(rest.slice(2).join('/'));
        const sha = repo.refs.get(ref);
        if (!sha) return err(store, 404, 'Reference does not exist');
        return json(store, 200, { ref, object: { sha, type: 'commit', url: `${req.baseUrl}/api/v3/repos/${owner}/${name}/git/commits/${sha}` } });
      }
    }

    // ---- contents ----
    if (rest[0] === 'contents') {
      const path = rest.slice(1).map((p) => decodeURIComponent(p)).join('/');
      const branchParam = req.query.get('ref') ?? repo.defaultBranch;
      if (req.method === 'GET') {
        const tip = resolveRef(repo, branchParam);
        if (!tip) return err(store, 404, 'No commit found for SHA');
        const info = parseCommit(repo.objects.get(tip)!.data);
        if (path === '') {
          return json(store, 200, dirEntries(repo, info.tree, ''));
        }
        const flat = flattenTree(repo, info.tree);
        const file = flat.get(path);
        if (file) {
          const blob = repo.objects.get(file.oid)!;
          return json(store, 200, {
            type: 'file',
            encoding: 'base64',
            size: blob.data.length,
            name: path.split('/').pop(),
            path,
            content: blob.data.toString('base64'),
            sha: file.oid,
            url: `${req.baseUrl}/api/v3/repos/${owner}/${name}/contents/${path}`,
            html_url: `${req.baseUrl}/${owner}/${name}/blob/${branchParam}/${path}`,
            git_url: `${req.baseUrl}/api/v3/repos/${owner}/${name}/git/blobs/${file.oid}`,
            download_url: `${req.baseUrl}/${owner}/${name}/raw/${branchParam}/${path}`,
          });
        }
        // directory?
        const prefix = `${path}/`;
        const children = new Set<string>();
        for (const p of flat.keys()) {
          if (p.startsWith(prefix)) children.add(p.slice(prefix.length).split('/')[0]);
        }
        if (children.size > 0) {
          return json(store, 200, dirEntries(repo, info.tree, path));
        }
        return err(store, 404, 'Not Found');
      }
      if (req.method === 'PUT') {
        const body = parseJsonBody(req);
        if (!body.ok) return err(store, 400, 'Problems parsing JSON');
        const branch = str(body.value.branch, repo.defaultBranch);
        const message = str(body.value.message, 'Update file');
        const contentB64 = str(body.value.content);
        if (!contentB64) return err(store, 422, 'content is required');
        let content: Buffer;
        try {
          content = Buffer.from(contentB64, 'base64');
        } catch {
          return err(store, 422, 'content is not valid base64');
        }
        const refName = `refs/heads/${branch}`;
        const tip = repo.refs.get(refName);
        if (tip === undefined && branch !== repo.defaultBranch) {
          return err(store, 404, 'Branch not found');
        }
        let existing: { mode: string; oid: string } | null = null;
        if (tip) {
          const info = parseCommit(repo.objects.get(tip)!.data);
          existing = getBlobAt(repo, info.tree, path);
        }
        const givenSha = str(body.value.sha);
        if (existing) {
          if (!givenSha) return err(store, 422, "sha wasn't supplied");
          if (givenSha !== existing.oid) return err(store, 409, 'sha does not match');
        }
        const blobOid = storeObject(repo, 'blob', content);
        const files = new Map<string, { mode: string; oid: string }>([[path, { mode: '100644', oid: blobOid }]]);
        const commitOid = commitFiles(store, repo, branch, message, files);
        return json(store, existing ? 200 : 201, {
          content: {
            name: path.split('/').pop(),
            path,
            sha: blobOid,
            size: content.length,
            url: `${req.baseUrl}/api/v3/repos/${owner}/${name}/contents/${path}`,
            html_url: `${req.baseUrl}/${owner}/${name}/blob/${branch}/${path}`,
            git_url: `${req.baseUrl}/api/v3/repos/${owner}/${name}/git/blobs/${blobOid}`,
            download_url: `${req.baseUrl}/${owner}/${name}/raw/${branch}/${path}`,
            type: 'file',
            encoding: 'base64',
            content: contentB64,
          },
          commit: { sha: commitOid, message, author: commitIdentity(store), committer: commitIdentity(store) },
        });
      }
      if (req.method === 'DELETE') {
        const body = parseJsonBody(req);
        if (!body.ok) return err(store, 400, 'Problems parsing JSON');
        const branch = str(body.value.branch, repo.defaultBranch);
        const message = str(body.value.message, 'Delete file');
        const refName = `refs/heads/${branch}`;
        const tip = repo.refs.get(refName);
        if (!tip) return err(store, 404, 'Branch not found');
        const info = parseCommit(repo.objects.get(tip)!.data);
        const existing = getBlobAt(repo, info.tree, path);
        if (!existing) return err(store, 404, 'Not Found');
        const givenSha = str(body.value.sha);
        if (givenSha && givenSha !== existing.oid) return err(store, 409, 'sha does not match');
        const files = new Map<string, { mode: string; oid: string }>([[path, { mode: '', oid: '' }]]);
        const commitOid = commitFiles(store, repo, branch, message, files);
        return json(store, 200, {
          content: null,
          commit: { sha: commitOid, message, author: commitIdentity(store), committer: commitIdentity(store) },
        });
      }
    }

    // ---- labels ----
    if (rest[0] === 'labels') {
      if (req.method === 'POST' && rest.length === 1) {
        const body = parseJsonBody(req);
        if (!body.ok) return err(store, 400, 'Problems parsing JSON');
        const name = str(body.value.name);
        if (!name) return err(store, 422, 'name is required');
        const color = str(body.value.color, 'ededed');
        repo.labels.set(name, { name, color });
        return json(store, 201, { name, color, description: str(body.value.description) });
      }
      if (req.method === 'GET' && rest.length === 1) {
        return json(store, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: '' })));
      }
    }

    // ---- issues ----
    if (rest[0] === 'issues') {
      if (req.method === 'POST' && rest.length === 1) {
        const body = parseJsonBody(req);
        if (!body.ok) return err(store, 400, 'Problems parsing JSON');
        const title = str(body.value.title);
        if (!title) return err(store, 422, 'title is required');
        const labels: string[] = Array.isArray(body.value.labels) ? body.value.labels.filter((x): x is string => typeof x === 'string') : [];
        for (const label of labels) {
          if (!repo.labels.has(label)) return err(store, 422, `Label does not exist: ${label}`);
        }
        repo.issueCounter += 1;
        const createdAt = store.nowIso();
        const issue: Repo['issues'][number] = {
          number: repo.issueCounter,
          title,
          body: str(body.value.body),
          state: 'open',
          labels,
          seq: store.seq,
          createdAt,
          updatedAt: createdAt,
          comments: [],
        };
        repo.issues.push(issue);
        return json(store, 201, issueJson(repo, issue));
      }
      if (req.method === 'GET' && rest.length === 1) {
        const state = req.query.get('state') ?? 'open';
        const sort = req.query.get('sort') ?? 'created';
        const direction = req.query.get('direction') ?? 'desc';
        let list = repo.issues.filter((i) => state === 'all' || i.state === state);
        if (sort === 'created') {
          list = [...list].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        }
        return json(store, 200, list.map((i) => issueJson(repo, i)));
      }
      if (rest.length === 2) {
        const number = Number(rest[1]);
        const issue = repo.issues.find((i) => i.number === number);
        if (!issue) return err(store, 404, 'Not Found');
        if (req.method === 'GET') return json(store, 200, issueJson(repo, issue));
        if (req.method === 'PATCH') {
          const body = parseJsonBody(req);
          if (!body.ok) return err(store, 400, 'Problems parsing JSON');
          if (typeof body.value.title === 'string') issue.title = body.value.title;
          if (typeof body.value.body === 'string') issue.body = body.value.body;
          if (typeof body.value.state === 'string' && (body.value.state === 'open' || body.value.state === 'closed')) {
            issue.state = body.value.state;
          }
          if (Array.isArray(body.value.labels)) {
            const labels = body.value.labels.filter((x): x is string => typeof x === 'string');
            for (const label of labels) {
              if (!repo.labels.has(label)) return err(store, 422, `Label does not exist: ${label}`);
            }
            issue.labels = labels;
          }
          issue.updatedAt = store.nowIso();
          return json(store, 200, issueJson(repo, issue));
        }
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        const number = Number(rest[1]);
        const issue = repo.issues.find((i) => i.number === number);
        if (!issue) return err(store, 404, 'Not Found');
        if (req.method === 'POST') {
          const body = parseJsonBody(req);
          if (!body.ok) return err(store, 400, 'Problems parsing JSON');
          const commentBody = str(body.value.body);
          if (!commentBody) return err(store, 422, 'body is required');
          repo.commentCounter += 1;
          const comment = { id: repo.commentCounter, body: commentBody, user: VIEWER_LOGIN, createdAt: store.nowIso() };
          issue.comments.push(comment);
          return json(store, 201, {
            id: comment.id,
            node_id: Buffer.from(`IssueComment:${repo.databaseId}:${comment.id}`).toString('base64'),
            url: `${req.baseUrl}/api/v3/repos/${owner}/${name}/issues/comments/${comment.id}`,
            body: comment.body,
            user: userJson(VIEWER_LOGIN),
            created_at: comment.createdAt,
            updated_at: comment.createdAt,
          });
        }
        if (req.method === 'GET') {
          return json(store, 200, issue.comments.map((c) => ({
            id: c.id,
            node_id: Buffer.from(`IssueComment:${repo.databaseId}:${c.id}`).toString('base64'),
            url: `${req.baseUrl}/api/v3/repos/${owner}/${name}/issues/comments/${c.id}`,
            body: c.body,
            user: userJson(VIEWER_LOGIN),
            created_at: c.createdAt,
            updated_at: c.createdAt,
          })));
        }
      }
    }

    // ---- pulls ----
    if (rest[0] === 'pulls') {
      if (req.method === 'POST' && rest.length === 1) {
        const body = parseJsonBody(req);
        if (!body.ok) return err(store, 400, 'Problems parsing JSON');
        const title = str(body.value.title);
        const head = str(body.value.head);
        const base = str(body.value.base);
        if (!title || !head || !base) return err(store, 422, 'title, head and base are required');
        const headSha = repo.refs.get(`refs/heads/${head}`);
        const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (!headSha || !baseSha) return err(store, 422, 'head or base branch does not exist');
        repo.pullCounter += 1;
        const createdAt = store.nowIso();
        const pull: Repo['pulls'][number] = {
          number: repo.pullCounter,
          title,
          body: str(body.value.body),
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
        return json(store, 201, pullJson(repo, pull));
      }
      if (req.method === 'GET' && rest.length === 1) {
        const state = req.query.get('state') ?? 'open';
        const list = repo.pulls.filter((p) => state === 'all' || p.state === state);
        return json(store, 200, list.map((p) => pullJson(repo, p)));
      }
      if (rest.length === 2) {
        const number = Number(rest[1]);
        const pull = repo.pulls.find((p) => p.number === number);
        if (!pull) return err(store, 404, 'Not Found');
        if (req.method === 'GET') return json(store, 200, pullJson(repo, pull));
      }
      if (rest.length === 3 && rest[2] === 'files') {
        const number = Number(rest[1]);
        const pull = repo.pulls.find((p) => p.number === number);
        if (!pull) return err(store, 404, 'Not Found');
        if (req.method === 'GET') {
          const baseInfo = parseCommit(repo.objects.get(pull.mergeBase)!.data);
          const headInfo = parseCommit(repo.objects.get(pull.headSha)!.data);
          const diffs = diffTrees(repo, baseInfo.tree, headInfo.tree);
          return json(store, 200, diffs.map((d) => ({
            sha: d.newOid ?? d.oldOid ?? ZERO_OID,
            filename: d.filename,
            status: d.status,
            additions: d.additions,
            deletions: d.deletions,
            changes: d.changes,
            blob_url: `${req.baseUrl}/api/v3/repos/${owner}/${name}/git/blobs/${d.newOid ?? d.oldOid}`,
            raw_url: `${req.baseUrl}/${owner}/${name}/raw/${pull.head}/${d.filename}`,
            contents_url: `${req.baseUrl}/api/v3/repos/${owner}/${name}/contents/${d.filename}?ref=${pull.head}`,
          })));
        }
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        const number = Number(rest[1]);
        const pull = repo.pulls.find((p) => p.number === number);
        if (!pull) return err(store, 404, 'Not Found');
        if (req.method === 'PUT') {
          if (pull.state === 'closed') return err(store, 405, 'Pull Request is already closed');
          const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
          if (!baseTip) return err(store, 404, 'Base branch not found');
          const baseInfo = parseCommit(repo.objects.get(pull.mergeBase)!.data);
          const headInfo = parseCommit(repo.objects.get(pull.headSha)!.data);
          const currentInfo = parseCommit(repo.objects.get(baseTip)!.data);
          const mergedTree = threeWayMerge(repo, baseInfo.tree, headInfo.tree, currentInfo.tree);
          if (mergedTree === null) return err(store, 405, 'Pull Request is not mergeable');
          const ts = store.nowEpoch();
          const ident = commitIdentity(store);
          const stamp = `${ts} +0000`;
          const mergeSha = buildCommit(repo, {
            tree: mergedTree,
            parents: [baseTip],
            author: `${ident.name} <${ident.email}> ${stamp}`,
            committer: `${ident.name} <${ident.email}> ${stamp}`,
            message: `${pull.title} (#${pull.number})`,
            timestamp: ts,
          });
          repo.refs.set(`refs/heads/${pull.base}`, mergeSha);
          pull.state = 'closed';
          pull.merged = true;
          pull.mergeCommitSha = mergeSha;
          pull.mergedAt = store.nowIso();
          pull.baseSha = mergeSha;
          return json(store, 200, { sha: mergeSha, merged: true, message: `Pull Request successfully merged` });
        }
      }
    }
  }

  return err(store, 404, 'Not Found');
}

function commitJson(repo: Repo, sha: string, info: ReturnType<typeof parseCommit>): Record<string, unknown> {
  const author = parseIdent(info.author);
  const committer = parseIdent(info.committer);
  return {
    sha,
    node_id: Buffer.from(`Commit:${repo.databaseId}:${sha}`).toString('base64'),
    commit: {
      author,
      committer,
      message: info.message.replace(/\n+$/, ''),
      tree: { sha: info.tree },
      url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `/${repo.owner}/${repo.name}/commit/${sha}`,
    author: userJson(VIEWER_LOGIN),
    committer: userJson(VIEWER_LOGIN),
    parents: info.parents.map((p) => ({ sha: p, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${p}` })),
  };
}

function parseIdent(raw: string): { name: string; email: string; date: string } {
  const m = raw.match(/^(.*?) <(.*?)> (\d+) [+-]\d{4}$/);
  if (!m) return { name: raw, email: '', date: new Date(1735689600 * 1000).toISOString() };
  return { name: m[1], email: m[2], date: new Date(Number(m[3]) * 1000).toISOString() };
}

function dirEntries(repo: Repo, treeOid: string, dirPath: string): Record<string, unknown>[] {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return [];
  const entries = parseTree(obj.data);
  const prefix = dirPath === '' ? '' : `${dirPath}/`;
  // For a subdirectory, descend to its tree first.
  if (dirPath !== '') {
    const flat = flattenTree(repo, treeOid);
    // Find the tree oid of the directory by walking components.
    let cur = treeOid;
    for (const part of dirPath.split('/')) {
      const e = parseTree(repo.objects.get(cur)!.data).find((x) => x.name === part && x.mode === '40000');
      if (!e) return [];
      cur = e.oid;
    }
    return parseTree(repo.objects.get(cur)!.data).map((e) => dirEntry(repo, e, `${prefix}${e.name}`));
  }
  return entries.map((e) => dirEntry(repo, e, `${prefix}${e.name}`));
}

function dirEntry(repo: Repo, e: { mode: string; name: string; oid: string }, path: string): Record<string, unknown> {
  const isDir = e.mode === '40000';
  const size = isDir ? 0 : (repo.objects.get(e.oid)?.data.length ?? 0);
  return {
    type: isDir ? 'dir' : 'file',
    size,
    name: e.name,
    path,
    sha: e.oid,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${isDir ? 'trees' : 'blobs'}/${e.oid}`,
    html_url: `/${repo.owner}/${repo.name}/${isDir ? 'tree' : 'blob'}/${repo.defaultBranch}/${path}`,
    download_url: isDir ? null : `/${repo.owner}/${repo.name}/raw/${repo.defaultBranch}/${path}`,
  };
}
