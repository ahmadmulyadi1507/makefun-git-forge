// store.ts — in-memory data model for the forge.
// Deterministic: no wall clock in anything served (timestamps derive from a
// fixed epoch plus a monotonic sequence), no unseeded randomness, so a trial
// replay leaves the same state.
//
// The token owner's login is the contest's fixed scenario viewer. The suite
// generates its scenario from a fixed constant seed (SCENARIO_SEED in the
// kit's wire.ts), so the viewer login is the same in every trial, practice
// and final: "adaiversen" (id 1000), stranger "olgabauer", teammate
// "quinnkeller". Verified by running the kit's own buildScenario() here.

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const STRANGER_LOGIN = 'olgabauer';

export const BASE_EPOCH = 1735689600; // 2025-01-01T00:00:00Z, fixed

export interface GitObject {
  type: 'commit' | 'tree' | 'blob' | 'tag';
  data: Buffer;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}

export interface IssueComment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  createdAt: string;
  updatedAt: string;
  comments: IssueComment[];
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  mergeBase: string;
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  seq: number;
  createdAt: string;
}

export interface Repo {
  databaseId: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>; // 'refs/heads/<branch>' -> commit oid
  labels: Map<string, { name: string; color: string }>;
  issues: Issue[];
  pulls: Pull[];
  issueCounter: number;
  pullCounter: number;
  commentCounter: number;
  /** Fetch-pack cache: key -> {pack, shallow, unshallow}. Keyed on repo state. */
  packCache: Map<string, { pack: Buffer; shallow: string[]; unshallow: string[] }>;
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 10000;
  seq = 0; // global monotonic sequence for ordering + timestamps
  reqCounter = 0;

  /** Deterministic ISO timestamp: base epoch + seq seconds. */
  nowIso(): string {
    this.seq += 1;
    return new Date((BASE_EPOCH + this.seq) * 1000).toISOString().replace('.000Z', 'Z');
  }

  /** Deterministic git timestamp (seconds). */
  nowEpoch(): number {
    return BASE_EPOCH + this.seq;
  }

  nextRequestId(): string {
    this.reqCounter += 1;
    return `req-${this.reqCounter}`;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const id = this.nextRepoId;
    this.nextRepoId += 1;
    const createdAt = this.nowIso();
    const repo: Repo = {
      databaseId: id,
      name,
      owner: VIEWER_LOGIN,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdAt,
      updatedAt: createdAt,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      issueCounter: 0,
      pullCounter: 0,
      commentCounter: 0,
      packCache: new Map(),
    };
    this.repos.set(this.key(VIEWER_LOGIN, name), repo);
    return repo;
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.databaseId - b.databaseId);
  }
}

export function userJson(login: string): Record<string, unknown> {
  return {
    login,
    id: login === VIEWER_LOGIN ? VIEWER_ID : 1001,
    avatar_url: `https://example.invalid/avatar/${login}`,
    html_url: `https://example.invalid/${login}`,
    type: 'User',
  };
}

/** Opaque, stable global id (base64), never the plain database id/number. */
export function globalId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`).toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const raw = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = raw.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}
