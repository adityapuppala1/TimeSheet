## graphify

This project has a knowledge graph at `graphify-out/` with god nodes, community structure, and
cross-file relationships, built from the source AST plus the architecture docs.

**Invocation on this machine:** the `graphify` console script is NOT on PATH — always call it as
`python -m graphify …`. The interpreter that actually has the package is recorded in
`graphify-out/.graphify_python` if `python` ever stops resolving to it.

Rules:
- For codebase questions, first run `python -m graphify query "<question>"` when
  `graphify-out/graph.json` exists. Use `python -m graphify path "<A>" "<B>"` for relationships
  and `python -m graphify explain "<concept>"` for focused concepts. These return a scoped
  subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output. Add `--budget 4000`
  when a broad question truncates.
- Read `graphify-out/GRAPH_REPORT.md` only for broad architecture review, or when
  query/path/explain do not surface enough context.
- After modifying code, run `python -m graphify update .` to keep the graph current (AST-only,
  no LLM cost). The installed `post-commit` git hook already does this automatically after every
  commit, detached, so a normal commit-based workflow needs no manual step. Docs/markdown
  changes are NOT covered by the hook — re-run `/graphify . --update` for those.
- `.graphifyignore` deliberately excludes vendored `.agents/` skill docs, generated Prisma
  clients, and build output. Without that, ~70% of the graph's markdown was third-party rule
  files and the real architecture was buried. Add new generated/vendored paths there rather than
  letting them into the graph.

Known quality caveats for this graph (be aware when reading `GRAPH_REPORT.md`):
- Package-manifest dependency lists create many single-node communities, so the report's
  community count (224) and its auto-generated "suggested questions" over-index on
  `dependencies` hubs. Code and architecture queries are unaffected.
- ~700 of 6352 raw edges were dropped at build time as dangling endpoints — semantic edges from
  one doc chunk referencing a node defined in another. The graph is usable; it just isn't
  exhaustive on doc-to-doc links.
