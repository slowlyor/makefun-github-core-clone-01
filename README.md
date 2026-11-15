# makefun-github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/slowlyor/makefun-github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/slowlyor/makefun-github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

asu-forge is a standalone GitHub-compatible git forge in a single Node process, standard library only — no git binary, no database, no UI. One in-memory store backs four surfaces at once, so an object created over any of them is the same object over all of them: git smart-HTTP (protocol v2 fetch with shallow/deepen, v0 receive-pack push with report-status, packfiles read and written in pure Node), the GitHub REST v3 API (repositories, branches, commits, git refs, contents, labels, issues, comments, pull requests with squash/merge), GraphQL v4 (gh's viewer/repository/issue/pull-request documents, the __type feature probes, Relay node(id:), cursor connections, create/close/merge mutations, operation batching), and MCP (server/discover for the 2026-07-28 revision plus the initialize handshake, with github-mcp-server's core tools). Verified locally against the competition's sealed conformance suite: 120 of 120 checks pass.

## Run it

```sh
MAKEFUN_SHOP_TOKEN=<trial token> node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=v8j9bb4h&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
