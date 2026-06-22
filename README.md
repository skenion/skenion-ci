# Skenion CI

Reusable GitHub Actions workflows for Skenion repositories.

`echovisionlab/skenion` is the release train conductor: it owns product train
sequencing, manifests, compatibility decisions, and final release reporting.
`echovisionlab/skenion-ci` is the reusable workflow library that the conductor
invokes from pinned workflow calls such as:

```yaml
uses: echovisionlab/skenion-ci/.github/workflows/validate-train-manifest.yml@v1
```

The reusable workflows check out helper scripts from the exact workflow commit
SHA that GitHub resolved for the pinned call. Callers cannot override the helper
script ref separately from the reusable workflow ref.

Publishing remains GitHub Actions only. These workflows may validate, dispatch,
verify, and record release trains, but they must not be replaced by local
registry publishing from a developer machine.

## Required Token

Callers should provide `SKENION_RELEASE_TRAIN_TOKEN` to workflows that dispatch
or verify cross-repository release artifacts:

```yaml
secrets:
  SKENION_RELEASE_TRAIN_TOKEN: ${{ secrets.SKENION_RELEASE_TRAIN_TOKEN }}
```

The token must be able to dispatch workflows across Skenion repositories and
read or write pull requests, releases, Actions runs, artifacts, and repository
contents as required by the calling train phase. For GitHub fine-grained tokens,
grant only the repositories in the release train and the minimum matching
permissions. For classic tokens, the release conductor generally needs workflow
dispatch capability plus repository read/write scopes appropriate to Release
Please and release artifact inspection.

## Modes

- `prepare`: dry-run friendly planning and structural validation. Workflows
  should echo intended work and avoid mutations.
- `publish`: the only mode that may mutate release state. Dispatch still
  requires `dry-run: false` in `dispatch-release-please.yml`.
- `verify`: inspect already published registry packages, GitHub releases, Pages
  URLs, and checksums described by the manifest. Verification must not check out
  sibling branches or `main` as release authority.

## Train Manifest Shape

The manifest is JSON. Inputs may pass either a path in the caller repository or
an inline JSON string.

Required structural fields:

```json
{
  "schema": "skenion.release-train",
  "schemaVersion": "0.1.0",
  "name": "Skenion Release Train",
  "version": 1,
  "trainId": "0.43",
  "trainVersion": "0.43.0",
  "components": [
    { "name": "contracts", "repository": "echovisionlab/Skenion-contracts", "version": "0.43.0" },
    { "name": "runtime", "repository": "echovisionlab/Skenion-runtime", "version": "0.43.0" },
    { "name": "sdk", "repository": "echovisionlab/Skenion-sdk", "version": "0.43.0" },
    { "name": "studio", "repository": "echovisionlab/Skenion-studio", "version": "0.43.0" },
    { "name": "examples", "repository": "echovisionlab/Skenion-examples", "version": "0.43.0" },
    { "name": "docs", "repository": "echovisionlab/Skenion-docs", "version": "0.43.0" }
  ],
  "releaseOrder": ["contracts", "runtime", "sdk", "studio", "examples", "docs"],
  "artifactTargets": [
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "x86_64-pc-windows-msvc",
    "aarch64-pc-windows-msvc",
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu"
  ]
}
```

For verification, add `artifacts`, `releaseArtifacts`, or component-level
artifact entries. Supported artifact types are `github-release`, `npm`, `crate`,
`url`, `page`, `github-pages`, and `binary`. Unknown types fail closed until the
library has explicit support for them. Every release artifact must include an
explicit `version` or `trainVersion` matching the train. Downloadable `url` and
`binary` artifacts must include a `sha256` checksum. `page` and `github-pages`
artifacts must include deployed version metadata and deployed status metadata.
GitHub release asset entries may include `sha256` checksums for asset
verification.

## Workflows

### `validate-train-manifest.yml`

Validates manifest invariants without checking out sibling repositories.

Inputs:

- `manifest` (required): caller repository path or inline JSON string.
- `manifest-ref`: optional caller repository ref for path manifests.
- `train-version` (required): expected lockstep version, such as `0.43.0`.
- `mode`: `prepare`, `publish`, or `verify`; default `prepare`.

Outputs:

- `train-version`
- `train-id`
- `manifest-path`
- `summary`

### `dispatch-release-please.yml`

Dispatches a target repository Release Please workflow with an explicit
`release-as` input. It does not allow independent per-repository Release Please
version authority.

Inputs:

- `target-repo` (required): `owner/repo`.
- `train-version` (required): explicit `release-as` version.
- `mode`: default `prepare`; only `publish` can mutate.
- `dry-run`: default `true`; must be `false` for mutation.
- `workflow-file`: default `release-please.yml`.
- `target-ref`: optional dispatch ref. Empty publish calls resolve the target
  default branch through the GitHub API.

Secret:

- `SKENION_RELEASE_TRAIN_TOKEN`

Outputs:

- `target-repo`
- `target-ref`
- `mutated`
- `dispatch-payload`

### `verify-release-artifacts.yml`

Verifies already released artifacts described by the manifest. It checks
registries, GitHub releases, URLs, Pages endpoints, and described checksums; it
does not fetch sibling repository branches or treat `main` as a release source.

Inputs:

- `manifest` (required): caller repository path or inline JSON string.
- `manifest-ref`: optional caller repository ref for path manifests.
- `train-version` (required): expected lockstep version.

Secret:

- `SKENION_RELEASE_TRAIN_TOKEN`

Outputs:

- `verified-count`
- `report-path`
- `summary`

### `record-train-result.yml`

Writes a structured train result JSON file, writes a Markdown summary, appends
the GitHub step summary, and uploads the files as a workflow artifact.

Inputs:

- `manifest` (required): caller repository path or inline JSON string.
- `manifest-ref`: optional caller repository ref for path manifests.
- `train-version` (required): expected lockstep version.
- `mode`: `prepare`, `publish`, or `verify`; default `prepare`.
- `status` (required): `success`, `failure`, `cancelled`, `skipped`, or
  `neutral`.
- `summary`: optional human-readable result note.

Outputs:

- `result-path`
- `summary-path`
- `artifact-name`

## License And Credit

This repository is licensed under the Apache License, Version 2.0.

Redistributions must preserve copyright, license, and NOTICE information as
required by Apache-2.0. If Skenion helps your artwork, research, publication,
installation, or tool, please credit Skenion and EchoVisionLab.
