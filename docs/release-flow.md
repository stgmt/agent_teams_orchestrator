# Release Flow

> **Fork releases:** `stgmt/agent_teams_orchestrator` ships Windows x64 only.
> Push an immutable source tag, then run `package-windows-claude.yml` against
> that tag and exact commit. Verify the downloaded workflow artifact, publish
> its unchanged ZIP, manifest, and checksum in this fork under
> `runtime-v<version>`, and verify the public downloads. OpenCode V2 is not
> included. The upstream publisher below is disabled in this fork; a tag push
> does not dispatch it.
>
> The remaining sections describe the upstream release process and its
> separate multi-platform binaries repository.

This repo has two different release concepts. They should not be mixed.

## 1. `agent_teams_orchestrator` release

Purpose:
- source-of-truth version for the private runtime repo
- immutable source tag for a specific runtime build
- private GitHub Release for internal history and traceability

What lives here:
- source code
- commits
- tags like `v0.0.3`
- optional private GitHub Releases

What does **not** live here by default:
- public delivery binaries for app users

## 2. `agent_teams_orchestrator_binaries` release

Purpose:
- public delivery channel for runtime binary assets used by `pnpm dev`
- source for runtime assets staged into Electron builds

What lives there:
- runtime archives like `agent-teams-runtime-darwin-arm64-v0.0.3.tar.gz`
- versioned runtime manifest and checksums

Important:
- runtime source tag, public binary release tag, and runtime version must match

## Current contract

- `agent_teams_orchestrator` tag identifies the source revision used to build the runtime
- `agent_teams_orchestrator_binaries` release tag identifies where users download runtime artifacts
- `claude_team/runtime.lock.json` binds these two together:
  - `sourceRef` = private runtime source tag
  - `releaseRepository` = `777genius/agent_teams_orchestrator_binaries`
  - `releaseTag` = namespaced public binary release tag such as `runtime-v0.0.3`

## Tagged runtime release

Use this when you want to publish a runtime without touching the UI release cadence.

Steps:
1. Bump `package.json` version in `agent_teams_orchestrator`
2. Verify the runtime still compiles
3. Commit to `main`
4. Push `main` to `origin`
5. Create and push an immutable git tag like `v0.0.3`
6. Wait for the automatically triggered `release-runtime.yml` workflow

Pushing the version tag triggers `release-runtime.yml`, which builds all five platform archives
and uploads them, the versioned manifest and checksums to a **draft** in
`agent_teams_orchestrator_binaries`. A successful tag workflow does not mean the assets are public;
the anonymous-download job is skipped while the release remains a draft.

Before publication, qualify all five base platform builds and every qualified optional
OpenCode V2 support archive. The generated release manifest determines the complete
asset roster (five base archives, each qualified platform's support ZIP, manifest and checksums).
Each optional descriptor must match the same runtime source commit, platform, Bun pin
and qualified engines as its base; platform metadata sidecars are build inputs only.

Published runtime releases and their versioned support assets are retained. Installed
apps download their pinned support lazily and may still need an older release after
a new app/runtime version ships. Never delete published assets as draft cleanup, replace
their bytes in place, or point an old descriptor at a newer engine. The workflow may
recreate only the matching **still-draft** release, rechecking its state immediately
before deletion. Cleaning unrelated releases or implementing a retention service is
outside this delivery flow.
Check the manifest's `sourceRef` and `sourceCommit` against the immutable source tag, archive
SHA256 values against the manifest/checksums, and payload `VERSION` and `COMMIT_SHA`. Retain the
verified draft release ID and asset identities with the qualification evidence.

After the required owner authorization, promote that exact verified draft ID without rebuilding:

```sh
gh api --method PATCH "repos/777genius/agent_teams_orchestrator_binaries/releases/RELEASE_ID" \
  -F draft=false -F prerelease=false -f make_latest=false
```

Replace `RELEASE_ID` only with the verified draft's ID. This is the same publication operation
used by the workflow; it preserves the qualified asset bytes and does not promote `latest`.
Then dispatch `release-runtime.yml` for the same immutable source tag/version with
`publish_release=false`. The workflow detects the already published release, skips build/upload,
and runs `Verify public anonymous downloads` against the complete asset roster
derived from that release's manifest, including its optional V2 support archives.

Source releases follow the same readiness boundary. A tag creates a source draft;
after a successful binary verification workflow, `Promote Verified Source Releases`
automatically publishes matching source drafts. It verifies the stable public
binary release, exact source commit, manifest/checksum consistency and anonymous
asset URLs. Older drafts without a published stable delivery stay drafts. For
reconciliation and recovery, see [source release publication](../scripts/release/README.md).

Important:
- the runtime tag creates a binary draft but does **not** publish it or update the UI lock automatically
- if `claude_team` is still pinned to an older runtime in `runtime.lock.json`, users will keep bootstrapping that older binary

## Republish runtime assets manually

Use this when the runtime binary must be refreshed for public `pnpm dev` or packaged app flows.

Run the private workflow `release-runtime.yml` with:
- `source_ref` = runtime source tag, for example `v0.0.3`
- `runtime_version` = runtime version, for example `0.0.3`
- `target_release_repo` = `777genius/agent_teams_orchestrator_binaries`
- `target_release_tag` = matching public runtime release, for example `runtime-v0.0.3`

By default this builds the runtime from the private repo and uploads the versioned archives into
a draft. `publish_release=true` also publishes after upload; `publish_prerelease=true` selects a
prerelease instead of a stable release, and publication keeps `make_latest=false`.

Do not use a `publish_release=true` redispatch to promote a draft whose bytes have already been
qualified: when a draft exists, the workflow rebuilds, deletes that draft and creates a replacement
before uploading. That invalidates the retained draft ID and artifact qualification. Promote the
verified draft by exact ID as described above, then dispatch with `publish_release=false` for the
anonymous-download gate. An already published release is not rebuilt by either dispatch path.

After publishing assets, also update `claude_team/runtime.lock.json` to the new runtime version if you want `pnpm dev` and packaged app flows to start using it.

## Frontend-managed release

The preferred production flow is for the frontend release workflow to coordinate runtime delivery:

1. Push a frontend tag, for example `v1.3.0`.
2. The frontend workflow reads `claude_team/runtime.lock.json`.
3. If the runtime assets for that lock are missing from the public binary release, the workflow triggers this repo's private `release-runtime.yml` with `workflow_dispatch`.
4. The frontend workflow finds and polls the exact orchestrator run name:
   `runtime <runtime_version> -> <target_release_repo>@<target_release_tag>`.
5. A missing runtime's default dispatch creates a draft; complete qualification and exact-ID
   publication as described above. A successful draft build alone does not satisfy public delivery.
6. After publication and the anonymous-download gate, the frontend workflow verifies all runtime
   assets exist in the public binary release.
7. Platform packaging jobs download and unpack the matching runtime into `resources/runtime` before `electron-builder`.

This keeps the packaged Electron app self-contained while still keeping the runtime source private.

Required frontend secret:
- `RUNTIME_BUILD_DISPATCH_TOKEN` with permission to dispatch and read Actions runs in `777genius/agent_teams_orchestrator`.

Required orchestrator secret:
- `BINARIES_PUBLISH_TOKEN` with permission to upload assets into `777genius/agent_teams_orchestrator_binaries`.

## Recommended rule

- create a private orchestrator release whenever you want a clean source milestone
- publish runtime assets into `agent_teams_orchestrator_binaries` for every runtime version tag
- if the new runtime adds commands or behavior expected by the UI, do **both**:
  - publish the runtime assets into the public binary release
  - bump `claude_team/runtime.lock.json`
