# How the packages are distributed

**Status**: the channel and the mechanics are decided; the scope's owner and
the token's holder are not. Nothing has been published yet.

[i356]: https://github.com/wienerlabs/square/issues/356

## The gap

Thirteen packages under `packages/` are `private: false`, named `@squaresdk/*`
and at version `0.1.0`, and none is on npm: `npm view @squaresdk/<name>`
answered E404 for all thirteen on 2026-09-15, and a registry search for the
scope finds nothing. Three binaries (`square`, `square-mcp`, `square-hosted`)
exist only for someone who clones this repository, and two READMEs gave an
`npm install @squaresdk/…` that could not work ([#356][i356]). For the
testnet that is the whole question of who can use it: an institution puts
`square-mcp` into its Claude Desktop, an agent developer puts
`@squaresdk/agent` into a project, an operator puts `square` on a machine.

## What is decided

**The channel is npm, under the `@squaresdk` scope, for every package that is
not private.** The packages are already named for it; what was missing was
the flow. `did-aip-driver` stays private and ships as the GHCR image its own
workflow builds.

**The packages move in lockstep.** One version for all thirteen, bumped
together by `node scripts/publish.mjs --set-version <version>`, which writes
it into every `package.json` and lockfile. A change to one package is a
release of all; that is simpler than thirteen version histories for packages
that are built and tested together, and it is what `^0.1.0` between them
assumes.

**A tag publishes.** `git tag v<version>` on `main` runs
`.github/workflows/publish.yml`, which builds every package in dependency
order, refuses a tag whose version is not the one the packages declare,
packs each one, and publishes with provenance whatever version the registry
does not already hold, so a run that failed half way is re-run and finishes.
The token is the `NPM_TOKEN` repository secret; without it the job says so
and publishes nothing, the way `deploy.yml` behaves without `VERCEL_TOKEN`.

**`file:` stays in the repository; the tarball carries a range.** The
packages depend on each other as `file:../core`, which is what lets a clone
build with no registry, and a published manifest saying `file:../core` would
break every install. `scripts/publish.mjs` rewrites each `file:` sibling to
`^<the sibling's version>` for the length of the pack and puts the file back
byte for byte; the root `LICENSE` is put beside each package for the same
span, because npm reads it from the package's own root and `files` cannot
name a file above it. The dry run then proves the point that matters: the
thirteen tarballs are installed together into an empty project, every package
is imported, and the four binaries answer.

**Every pull request runs the dry run.** The `pack and install (dry run)` job
fails a package that would ship without its `dist/`, a bin, its README or
its license, with a file outside `files`, or with a `file:` dependency, on
the pull request and not on the day of the release.

## What that rules out

- No workspace conversion. npm workspaces would resolve the siblings too, but
  they change how every package installs, tests and builds, and the thirteen
  lockfiles with them; the rewrite at pack time changes nothing about the
  repository.
- No tarballs on GitHub Releases as the channel. They would need the same
  `file:` rewrite and hand an installer a chain of URLs for what one
  `npm install` from the registry does.
- No per-package versions, until a package needs to move alone. The script
  refuses a tag that does not match every package, so the day that changes
  is a visible change to it.

## What is not decided

Who owns the `@squaresdk` scope on npm, and which account's token becomes
`NPM_TOKEN`. The scope is free as of the date above; whoever creates the
organisation holds the packages' names, which is the project's call and not
this document's. Until the secret is set, the workflow's publish job is a
no-op, and the READMEs say where the packages come from instead.

## What the READMEs say until then

The commands the packages will install with are written where a reader would
look, marked as waiting on the first release, next to the clone-and-build
path that works today. The two `npm install @squaresdk/…` lines that named
a channel that did not exist are corrected the same way. When `v0.1.0` is
on the registry, the marks come off.

## Evidence

`node scripts/publish.mjs --install-check` on `main` at the time of this
decision:

```
packed 13 package(s) into /tmp/squaresdk-pack-…, in dependency order:
  @squaresdk/a2a               0.1.0      45 files     178 KiB unpacked
  @squaresdk/did-resolver      0.1.0      19 files      83 KiB unpacked
  @squaresdk/core              0.1.0      45 files     409 KiB unpacked
  @squaresdk/aa                0.1.0      19 files      62 KiB unpacked
  @squaresdk/data              0.1.0      75 files     101 KiB unpacked
  @squaresdk/x402              0.1.0      19 files      74 KiB unpacked
  @squaresdk/agent             0.1.0      11 files      44 KiB unpacked
  @squaresdk/policy            0.1.0      22 files      98 KiB unpacked
  @squaresdk/cli               0.1.0      45 files     143 KiB unpacked
  @squaresdk/hardening         0.1.0      19 files      91 KiB unpacked
  @squaresdk/mcp               0.1.0      23 files     131 KiB unpacked
  @squaresdk/hosted            0.1.0      19 files      82 KiB unpacked
  @squaresdk/observability     0.1.0      19 files      84 KiB unpacked
installing every tarball into an empty project:
  import @squaresdk/core: 65 export(s)          (and the other eleven libraries)
  square --version: exit 0, 0.1.0
  square-hosted : exit 1, usage: square-hosted <config.json> | square-hosted seal <agentId>
  square-mcp : exit 1, [square-mcp] HTTP request failed.   (no chain at the URL it was given; the point is that it ran)
  square-data : exit 2, usage: square-data migrate up
```
