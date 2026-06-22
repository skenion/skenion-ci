#!/usr/bin/env node
import path from "node:path";
import {
  appendStepSummary,
  assertSemver,
  boolValue,
  ensureDir,
  normalizeMode,
  parseArgs,
  requireArg,
  setOutput,
  writeJson,
  writeText,
} from "./lib/github-actions.mjs";

try {
  const args = parseArgs();
  const targetRepo = requireArg(args, "target-repo");
  const trainVersion = requireArg(args, "train-version");
  const mode = normalizeMode(args.mode);
  const dryRun = boolValue(args["dry-run"] ?? "true");
  const workflowFile = normalizeWorkflowFile(args["workflow-file"] ?? "release-please.yml");
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  const outDir = args["out-dir"] ?? ".skenion-train";

  assertSemver(trainVersion, "train version");
  ensureDir(outDir);
  validateRepo(targetRepo);

  const mutates = mode === "publish" && !dryRun;
  if (mutates && !token) {
    throw new Error("GH_TOKEN is required when dispatch-release-please mutates a target repository.");
  }

  const targetRef = args["target-ref"]?.trim() || (mutates ? await resolveDefaultBranch(targetRepo, token) : "default-branch");
  const payload = {
    ref: targetRef,
    inputs: {
      "release-as": trainVersion,
      "train-version": trainVersion,
      "release-train-mode": mode,
    },
  };

  const dispatch = {
    targetRepo,
    workflowFile,
    trainVersion,
    mode,
    dryRun,
    mutates,
    payload,
  };

  const payloadPath = path.join(outDir, "release-please-dispatch.json");
  writeJson(payloadPath, dispatch);

  if (mutates) {
    await dispatchWorkflow(targetRepo, workflowFile, payload, token);
    console.log(`Dispatched ${workflowFile} in ${targetRepo} with release-as=${trainVersion}.`);
  } else {
    console.log(`Dry run: would dispatch ${workflowFile} in ${targetRepo} with release-as=${trainVersion}.`);
  }

  const summary = renderSummary(dispatch);
  writeText(path.join(outDir, "release-please-dispatch.md"), summary);
  appendStepSummary(summary);

  setOutput("target-repo", targetRepo);
  setOutput("target-ref", targetRef);
  setOutput("mutated", String(mutates));
  setOutput("dispatch-payload", payloadPath);
} catch (error) {
  console.error(`::error::${error.message}`);
  process.exit(1);
}

function normalizeWorkflowFile(value) {
  return String(value).replace(/^\.github\/workflows\//, "");
}

function validateRepo(value) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(value)) {
    throw new Error(`target-repo must be in owner/repo form, got "${value}".`);
  }
}

async function resolveDefaultBranch(repo, token) {
  const response = await githubJson(`https://api.github.com/repos/${repo}`, token);
  const branch = response.default_branch;
  if (!branch) {
    throw new Error(`Could not resolve default branch for ${repo}.`);
  }
  return branch;
}

async function dispatchWorkflow(repo, workflowFile, payload, token) {
  const workflowId = encodeURIComponent(workflowFile);
  const response = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${workflowId}/dispatches`, {
    method: "POST",
    headers: githubHeaders(token, { "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });

  if (response.status !== 204) {
    const body = await response.text();
    throw new Error(`GitHub workflow dispatch failed with ${response.status}: ${body}`);
  }
}

async function githubJson(url, token) {
  const response = await fetch(url, {
    headers: githubHeaders(token),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API request failed with ${response.status}: ${body}`);
  }

  return response.json();
}

function githubHeaders(token, extra = {}) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "skenion-ci-release-train",
    "X-GitHub-Api-Version": "2022-11-28",
    ...extra,
  };
}

function renderSummary(dispatch) {
  return [
    "## Release Please Dispatch",
    "",
    `- Target repository: ${dispatch.targetRepo}`,
    `- Workflow: ${dispatch.workflowFile}`,
    `- Mode: ${dispatch.mode}`,
    `- Dry run: ${dispatch.dryRun}`,
    `- Mutated: ${dispatch.mutates}`,
    `- Ref: ${dispatch.payload.ref}`,
    `- release-as: ${dispatch.payload.inputs["release-as"]}`,
    "",
  ].join("\n");
}
