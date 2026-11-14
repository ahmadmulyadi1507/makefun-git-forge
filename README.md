# make.fun entry: a GitHub-compatible git forge

A standalone GitHub-compatible git forge in one Node 22 process, standard
library only (no dependencies, no install step, no git binary in the pod).
Built for the make.fun bounty **"Build a GitHub-compatible git forge"**
(`github-core-clone-01`).

## What it serves

- **Git smart HTTP** — `git-upload-pack` (protocol v2 with `ls-refs` and
  `fetch`, and v0) and `git-receive-pack` (v0) at
  `/<owner>/<repo>.git/info/refs`, `/<owner>/<repo>.git/git-upload-pack`,
  `/<owner>/<repo>.git/git-receive-pack`. The git object store, pack reader
  and writer (including OFS/REF delta resolution), reachability, shallow
  fetch (`depth`, `deepen`, `unshallow`) and fast-forward-only pushes are
  all implemented here, on `node:zlib` and `node:crypto`.
- **REST v3** under `/api/v3` — repositories, branches, commits, contents
  (create/update/delete with SHA checks), refs, labels, issues and comments,
  pull requests with files and squash merges, pagination with `Link`
  headers, `X-GitHub-Request-Id` on every reply, and Bearer-token auth
  (401 without it).
- **GraphQL v4** at `/api/graphql` — `viewer`, `repository` (with issue /
  issues / pullRequests / pullRequest connections and cursor pagination),
  `node(id:)` with inline fragments, `__type` introspection, and the
  `createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest` and
  `addComment` mutations. Unknown fields are reported in an `errors` array
  with HTTP 200.
- **MCP** at `/mcp` — JSON-RPC 2.0 Streamable HTTP, modern era 2026-07-28
  (`server/discover`) with the legacy `initialize` fallback, and six tools
  (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`) acting on the same store as
  the REST surface.

State is in-memory and deterministic: no wall clock in anything served
(timestamps derive from a fixed epoch plus a monotonic sequence), no
unseeded randomness, so a trial replay leaves the same state.

## Layout

- `main.ts` — the entry ↔ env lifecycle (bind an ephemeral port, register,
  poll `/done`, exit 0). Kept as the kit's starter ships it.
- `app.ts` — the HTTP server and routing.
- `src/git.ts` — git objects, packs, pkt-lines, reachability, diff/merge.
- `src/git-http.ts` — git smart HTTP handlers.
- `src/rest.ts` — REST v3 handlers.
- `src/graphql.ts` — GraphQL parser and executor.
- `src/mcp.ts` — MCP endpoint and tools.
- `src/store.ts` — the in-memory data model.

## Local grade

Graded locally with the kit's own sealed suite
(`makefun grade-local --kit <kit> --bot . --driver process --worktree`):

- **937 / 1000** — feature 600/600 (120/120 conformance checks),
  agent 200/200, perf 137/200, `working: 1`, replay matched byte for byte,
  L1 regrade reproduced byte for byte.

## License

MIT — see `LICENSE`.
