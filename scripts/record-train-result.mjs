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
  trainIdFromVersion,
  writeJson,
  writeText,
} from "./lib/github-actions.mjs";
import {
  manifestHeader,
  normalizeComponents,
  readManifestSource,
  releaseOrder,
} from "./lib/manifest.mjs";

try {
  const args = parseArgs();
  const manifestInput = requireArg(args, "manifest");
  const trainVersion = requireArg(args, "train-version");
  const mode = normalizeMode(args.mode);
  const status = normalizeStatus(requireArg(args, "status"));
  const summaryInput = args.summary ?? "";
  const outDir = args["out-dir"] ?? ".skenion-train";
  const manifestRoot = args["manifest-root"] ?? ".";

  assertSemver(trainVersion, "train version");
  ensureDir(outDir);

  const manifestResult = tryReadManifest(manifestInput, manifestRoot, outDir);
  const header = manifestResult.manifest ? manifestHeader(manifestResult.manifest) : {};
  const components = manifestResult.manifest ? normalizeComponents(manifestResult.manifest) : [];
  const trainId = header.trainId ?? trainIdFromVersion(trainVersion);

  const result = {
    schema: "skenion.release-train-result.v1",
    name: "skenion Release Train Result",
    version: 1,
    trainId,
    trainVersion,
    mode,
    status,
    summary: summaryInput,
    manifest: {
      source: manifestResult.label,
      normalizedPath: manifestResult.normalizedPath,
      error: manifestResult.error,
      schema: header.schema ?? null,
      trainId: header.trainId ?? null,
      trainVersion: header.trainVersion ?? null,
      componentCount: components.length,
      releaseOrder: manifestResult.manifest ? releaseOrder(manifestResult.manifest) : [],
    },
    github: {
      repository: process.env.GITHUB_REPOSITORY ?? "",
      workflow: process.env.GITHUB_WORKFLOW ?? "",
      runId: process.env.GITHUB_RUN_ID ?? "",
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "",
      sha: process.env.GITHUB_SHA ?? "",
      ref: process.env.GITHUB_REF ?? "",
      actor: process.env.GITHUB_ACTOR ?? "",
    },
    recordedAt: new Date().toISOString(),
  };

  const artifactName = `skenion-train-${trainVersion}-${mode}-${status}`;
  const resultPath = path.join(outDir, "train-result.json");
  const summaryPath = path.join(outDir, "train-result.md");
  const summary = renderSummary(result);

  writeJson(resultPath, result);
  writeText(summaryPath, summary);
  appendStepSummary(summary);

  setOutput("result-path", resultPath);
  setOutput("summary-path", summaryPath);
  setOutput("artifact-name", artifactName);

  console.log(`Recorded skenion train result ${artifactName}.`);
} catch (error) {
  console.error(`::error::${error.message}`);
  process.exit(1);
}

function tryReadManifest(manifestInput, manifestRoot, outDir) {
  try {
    return readManifestSource(manifestInput, { manifestRoot, outDir });
  } catch (error) {
    return {
      kind: "unavailable",
      label: manifestInput,
      normalizedPath: "",
      manifest: null,
      error: error.message,
    };
  }
}

function normalizeStatus(value) {
  const status = String(value).trim().toLowerCase();
  const allowed = new Set(["success", "failure", "cancelled", "skipped", "neutral"]);
  if (!allowed.has(status)) {
    throw new Error(`Invalid status "${value}". Expected one of: success, failure, cancelled, skipped, neutral.`);
  }
  return status;
}

function renderSummary(result) {
  return [
    "## skenion Train Result",
    "",
    `- Train: ${result.trainId} (${result.trainVersion})`,
    `- Mode: ${result.mode}`,
    `- Status: ${result.status}`,
    `- Components: ${result.manifest.componentCount}`,
    `- Release order: ${result.manifest.releaseOrder.join(" -> ") || "(unavailable)"}`,
    `- Run: ${result.github.repository}#${result.github.runId}`,
    ...(result.summary ? [`- Summary: ${result.summary}`] : []),
    ...(result.manifest.error ? [`- Manifest warning: ${result.manifest.error}`] : []),
    "",
  ].join("\n");
}
