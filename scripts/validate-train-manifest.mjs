#!/usr/bin/env node
import path from "node:path";
import {
  appendStepSummary,
  assertSemver,
  ensureDir,
  normalizeMode,
  parseArgs,
  requireArg,
  setOutput,
  writeJson,
  writeText,
} from "./lib/github-actions.mjs";
import {
  readManifestSource,
  releaseAuthorityState,
  validateTrainManifestInvariants,
} from "./lib/manifest.mjs";

try {
  const args = parseArgs();
  const manifestInput = requireArg(args, "manifest");
  const expectedVersion = requireArg(args, "train-version");
  const mode = normalizeMode(args.mode);
  const outDir = args["out-dir"] ?? ".skenion-train";
  const manifestRoot = args["manifest-root"] ?? ".";

  assertSemver(expectedVersion, "expected train version");
  ensureDir(outDir);

  const loaded = readManifestSource(manifestInput, { manifestRoot, outDir });
  const manifest = loaded.manifest;
  const warnings = [];
  const validation = validateTrainManifestInvariants(manifest, expectedVersion);
  const { errors, header, components, order, targets, studioTargets, trainVersion, trainId } = validation;

  if (mode === "verify") {
    warnings.push("verify mode validates manifest structure here; artifact existence is checked by verify-release-artifacts.yml.");
  }

  const summary = {
    schema: header.schema,
    "schema-version": header["schema-version"],
    "train-id": trainId,
    "train-version": trainVersion,
    mode,
    "component-count": components.length,
    "release-order": order,
    "runtime-targets": targets,
    "studio-desktop-targets": studioTargets["desktop-packages"],
    "studio-runtime-sidecar-targets": studioTargets["runtime-sidecars"],
    "release-authority-state": releaseAuthorityState(manifest),
    "manifest-source": loaded.label,
    "normalized-manifest-path": loaded.normalizedPath,
    warnings,
  };

  writeJson(path.join(outDir, "manifest.validation-summary.json"), summary);
  writeText(path.join(outDir, "manifest.validation-summary.md"), renderSummary(summary, errors));

  setOutput("train-version", trainVersion);
  setOutput("train-id", trainId);
  setOutput("manifest-path", loaded.normalizedPath);
  setOutput("summary", `Train ${trainId} (${trainVersion}) has ${components.length} lockstep components and ${targets.length} runtime targets.`);

  appendStepSummary(renderSummary(summary, errors));

  if (errors.length > 0) {
    console.error("Manifest validation failed:");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(`Validated skenion release train ${trainId} (${trainVersion}) in ${mode} mode.`);
} catch (error) {
  console.error(`::error::${error.message}`);
  process.exit(1);
}

function renderSummary(summary, errors) {
  const status = errors.length === 0 ? "passed" : "failed";
  return [
    "## skenion Train Manifest Validation",
    "",
    `- Status: ${status}`,
    `- Mode: ${summary.mode}`,
    `- Train: ${summary["train-id"]} (${summary["train-version"]})`,
    `- Schema: ${summary.schema ?? "(missing)"}@${summary["schema-version"] ?? "(missing)"}`,
    `- Components: ${summary["component-count"]}`,
    `- Release order: ${summary["release-order"].join(" -> ") || "(missing)"}`,
    `- Runtime targets: ${summary["runtime-targets"].join(", ") || "(missing)"}`,
    `- Studio desktop targets: ${summary["studio-desktop-targets"].join(", ") || "(missing)"}`,
    `- Studio runtime sidecar targets: ${summary["studio-runtime-sidecar-targets"].join(", ") || "(missing)"}`,
    `- Release authority state: ${renderAuthorityState(summary["release-authority-state"])}`,
    `- Normalized manifest: ${summary["normalized-manifest-path"]}`,
    ...summary.warnings.map((warning) => `- Warning: ${warning}`),
    ...(errors.length === 0 ? [] : ["", "### Errors", "", ...errors.map((error) => `- ${error}`)]),
    "",
  ].join("\n");
}

function renderAuthorityState(state) {
  return Object.entries(state)
    .map(([name, status]) => `${name}=${status ?? "(missing)"}`)
    .join(", ") || "(missing)";
}
