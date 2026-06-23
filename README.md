# skenion CI

Reusable GitHub Actions workflows for skenion release verification.

`skenion/skenion-ci` is a workflow library for compatibility matrix validation
and promotion evidence. It is not the release train conductor and does not
dispatch component Release Please workflows from `main`. Component repositories
own their own Release Please, tag, release, package, and artifact workflows.

Publishing remains GitHub Actions only. This repository verifies already
declared evidence; it must not publish npm packages, crates, GitHub releases, or
desktop artifacts from local machines or from the compatibility verifier.

## Compatibility Matrix Verification

Use the v2 verifier from a caller repository with either a checked-in matrix
path or inline JSON:

```yaml
jobs:
  verify:
    uses: skenion/skenion-ci/.github/workflows/verify-compatibility-matrix.yml@v2
    with:
      matrix: .skenion/compatibility/0.45.json
      manifest-ref: ${{ github.sha }}
    secrets:
      GH_TOKEN: ${{ secrets.GH_TOKEN }}
```

Callers should pin reusable workflow refs, such as `@v2`. The `main` branch is
for development only.

`GH_TOKEN` is required only when the matrix lists Runtime or Studio GitHub
release assets. The verifier uses it to read GitHub Releases and download
release assets for checksum verification. Registry and local shape checks do
not require GitHub API credentials.

The workflow writes a normalized matrix, a JSON report, and a Markdown summary
under the configured `out-dir` (default `.skenion-train`) and exposes these
outputs:

- `status`
- `verified-count`
- `failure-count`
- `report-path`
- `summary-path`
- `summary`

## Matrix Requirements

The v2 verifier is scoped to the corrected M06.9 compatibility model. A matrix
must use:

```json
{
  "schema": "skenion.compatibility-matrix",
  "schema-version": "0.1.0",
  "contracts-line": "0.45",
  "contracts-range": ">=0.45.0 <0.46.0"
}
```

Contracts package and crate versions must stay inside the declared v0 Contracts
line. For example, line `0.45` means `>=0.45.0 <0.46.0`. If an SDK package is
listed, it must declare the same supported Contracts range.

The verifier checks:

- `components.contracts.npm` exists on npm as `@skenion/contracts`.
- `components.contracts.crate` or `components.contracts.crate-package` exists
  on crates.io as `skenion-contracts`.
- `components.sdk.npm` exists on npm as `@skenion/sdk` when listed.
- Runtime and Studio GitHub release assets exist when listed, and their
  downloaded bytes match the declared sha256 checksum.
- Promoted matrices have passed examples conformance evidence.
- Promoted matrices mark Manual Pages as deployed and promoted.

## Workflow Inputs

### `verify-compatibility-matrix.yml`

Inputs:

- `matrix` (required): path to a compatibility matrix JSON file in the caller
  repository, or an inline JSON string.
- `manifest-ref`: optional caller repository ref for path matrices.
- `manifest-root`: checkout path used as the matrix root; default `.caller`.
- `out-dir`: output directory for reports; default `.skenion-train`.

Secret:

- `GH_TOKEN`: optional unless Runtime or Studio GitHub release artifacts are
  listed.

Outputs:

- `status`
- `verified-count`
- `failure-count`
- `report-path`
- `summary-path`
- `summary`

## Deprecated v1 Workflows

The old train-manifest workflows remain in the repository as historical v1
validation helpers, but they are not the main release model. `v1` tag users can
continue to pin historical behavior. On `main`,
`dispatch-release-please.yml` fails closed with a removal message; component
repositories own Release Please.

`verify-release-artifacts.yml` is a deprecated v1 artifact verifier. On `main`
it accepts caller-provided `GH_TOKEN` only for GitHub release and asset reads.

Existing v1 train validation scripts are isolated from the v2 compatibility
matrix path and should not be extended for new M06.9 promotion work.

## Local Validation

Run the verifier self-check locally:

```sh
node scripts/verify-compatibility-matrix.mjs --self-check
```

The self-check covers a valid matrix, a bad SDK Contracts range, a missing
Runtime release asset, a checksum mismatch, and a promoted matrix whose Manual
is not promoted.

## License And Credit

This repository is licensed under the Apache License, Version 2.0.

Redistributions must preserve copyright, license, and NOTICE information as
required by Apache-2.0. If skenion helps your artwork, research, publication,
installation, or tool, please credit skenion and its contributors.
