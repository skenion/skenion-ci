#!/usr/bin/env node
import crypto from "node:crypto";
import path from "node:path";
import {
  appendStepSummary,
  assertSemver,
  ensureDir,
  parseArgs,
  requireArg,
  setOutput,
  writeJson,
  writeText,
} from "./lib/github-actions.mjs";
import {
  extractArtifacts,
  readManifestSource,
  validateTrainManifestInvariants,
} from "./lib/manifest.mjs";

try {
  const args = parseArgs();
  const manifestInput = requireArg(args, "manifest");
  const expectedVersion = requireArg(args, "train-version");
  const outDir = args["out-dir"] ?? ".skenion-train";
  const manifestRoot = args["manifest-root"] ?? ".";
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";

  assertSemver(expectedVersion, "train version");
  ensureDir(outDir);

  const loaded = readManifestSource(manifestInput, { manifestRoot, outDir });
  const manifest = loaded.manifest;
  const validation = validateTrainManifestInvariants(manifest, expectedVersion);
  if (validation.errors.length > 0) {
    console.error("Manifest validation failed:");
    for (const error of validation.errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  const { header, components } = validation;
  const artifacts = extractArtifacts(manifest, components);
  if (artifacts.length === 0) {
    throw new Error("Manifest must describe release artifacts before verify-release-artifacts can pass. Add artifacts or releaseArtifacts entries with supported types: github-release, npm, crate, url.");
  }

  const results = [];
  const errors = [];
  for (const artifact of artifacts) {
    try {
      results.push(await verifyArtifact(artifact, expectedVersion, token));
    } catch (error) {
      errors.push(`${artifactLabel(artifact)}: ${error.message}`);
      results.push({
        component: artifact.component ?? "",
        type: inferType(artifact),
        label: artifactLabel(artifact),
        status: "failed",
        error: error.message,
      });
    }
  }

  const report = {
    schema: "skenion.release-artifact-verification.v1",
    name: "Skenion Release Artifact Verification",
    version: 1,
    trainId: header.trainId,
    trainVersion: expectedVersion,
    manifestSource: loaded.label,
    verifiedAt: new Date().toISOString(),
    artifactCount: artifacts.length,
    passedCount: results.filter((result) => result.status === "passed").length,
    failedCount: errors.length,
    results,
  };

  const reportPath = path.join(outDir, "release-artifact-verification.json");
  const summaryPath = path.join(outDir, "release-artifact-verification.md");
  const summary = renderSummary(report, errors);
  writeJson(reportPath, report);
  writeText(summaryPath, summary);
  appendStepSummary(summary);

  setOutput("verified-count", String(report.passedCount));
  setOutput("report-path", reportPath);
  setOutput("summary", `${report.passedCount}/${report.artifactCount} release artifacts verified for ${expectedVersion}.`);

  if (errors.length > 0) {
    console.error("Release artifact verification failed:");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(`Verified ${report.passedCount} release artifacts for ${expectedVersion}.`);
} catch (error) {
  console.error(`::error::${error.message}`);
  process.exit(1);
}

async function verifyArtifact(artifact, expectedVersion, token) {
  const type = inferType(artifact);
  const version = artifact.version ?? artifact.trainVersion;
  if (!version) {
    throw new Error(`${type} artifacts must include an explicit version matching the train version.`);
  }
  if (version !== expectedVersion) {
    throw new Error(`artifact version "${version}" must equal train version "${expectedVersion}".`);
  }

  if (type === "github-release") {
    return verifyGitHubRelease(artifact, token);
  }
  if (type === "npm") {
    return verifyNpmPackage(artifact, version);
  }
  if (type === "crate") {
    return verifyCrate(artifact, version);
  }
  if (type === "page" || type === "github-pages") {
    return verifyPageArtifact(artifact, expectedVersion);
  }
  if (type === "url" || type === "binary") {
    return verifyDownloadUrlArtifact(artifact);
  }

  throw new Error(`unsupported artifact verification type "${type}". Add explicit support before allowing this manifest to pass.`);
}

async function verifyGitHubRelease(artifact, token) {
  const repo = artifact.repository ?? artifact.repo;
  const tag = artifact.tag ?? artifact.tagName;
  validateRepo(repo);
  if (!tag) {
    throw new Error("github-release artifacts must include an explicit tag.");
  }
  if (!token) {
    throw new Error("GH_TOKEN is required to verify GitHub release artifacts.");
  }

  const release = await githubJson(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, token);
  if (release.draft || release.prerelease) {
    throw new Error(`GitHub release ${repo}@${tag} must be a final published release.`);
  }

  const expectedAssets = normalizeAssetList(artifact.assets ?? artifact.expectedAssets);
  for (const expectedAsset of expectedAssets) {
    const actual = release.assets.find((asset) => asset.name === expectedAsset.name);
    if (!actual) {
      throw new Error(`GitHub release ${repo}@${tag} is missing asset "${expectedAsset.name}".`);
    }
    if (expectedAsset.sha256) {
      await verifyDownloadSha256(actual.url, expectedAsset.sha256, token, true);
    }
  }

  return {
    component: artifact.component ?? "",
    type: "github-release",
    label: `${repo}@${tag}`,
    status: "passed",
    assetCount: release.assets.length,
    checkedAssets: expectedAssets.map((asset) => asset.name),
  };
}

async function verifyNpmPackage(artifact, expectedVersion) {
  const packageName = artifact.package ?? artifact.npmPackage;
  if (!packageName) {
    throw new Error("npm artifacts must include package or npmPackage.");
  }
  const registry = stripTrailingSlash(artifact.registry ?? artifact.registryUrl ?? "https://registry.npmjs.org");
  const metadata = await fetchJson(`${registry}/${encodeURIComponent(packageName)}`);
  if (!metadata.versions?.[expectedVersion]) {
    throw new Error(`npm package ${packageName}@${expectedVersion} was not found in ${registry}.`);
  }

  return {
    component: artifact.component ?? "",
    type: "npm",
    label: `${packageName}@${expectedVersion}`,
    status: "passed",
    registry,
  };
}

async function verifyCrate(artifact, expectedVersion) {
  const crate = artifact.crate;
  if (!crate) {
    throw new Error("crate artifacts must include crate.");
  }
  const registry = stripTrailingSlash(artifact.registry ?? artifact.registryUrl ?? "https://crates.io");
  await fetchJson(`${registry}/api/v1/crates/${encodeURIComponent(crate)}/${expectedVersion}`);

  return {
    component: artifact.component ?? "",
    type: "crate",
    label: `${crate}@${expectedVersion}`,
    status: "passed",
    registry,
  };
}

async function verifyDownloadUrlArtifact(artifact) {
  const url = artifact.url ?? artifact.href;
  if (!url) {
    throw new Error(`${inferType(artifact)} artifacts must include url.`);
  }
  const sha256 = artifact.sha256 ?? artifact.checksum?.sha256;
  if (!sha256) {
    throw new Error(`${inferType(artifact)} artifacts must include sha256 checksum metadata to bind the URL to the train.`);
  }

  await assertUrlReachable(url);
  await verifyDownloadSha256(url, sha256);

  return {
    component: artifact.component ?? "",
    type: inferType(artifact),
    label: url,
    status: "passed",
    checksum: "sha256",
  };
}

async function verifyPageArtifact(artifact, expectedVersion) {
  const url = artifact.url ?? artifact.href;
  if (!url) {
    throw new Error(`${inferType(artifact)} artifacts must include url.`);
  }

  const deployedVersion = artifact.deployedVersion ?? artifact.manualVersion ?? artifact.pageVersion ?? artifact.deployment?.version;
  if (deployedVersion !== expectedVersion) {
    throw new Error(`${inferType(artifact)} artifacts must include deployedVersion, manualVersion, pageVersion, or deployment.version matching "${expectedVersion}".`);
  }

  const status = String(artifact.status ?? artifact.deploymentStatus ?? artifact.deployment?.status ?? "").toLowerCase();
  const allowedStatuses = new Set(["deployed", "published", "success", "verified", "passed"]);
  if (!allowedStatuses.has(status)) {
    throw new Error(`${inferType(artifact)} artifacts must include deployed status metadata.`);
  }

  await assertUrlReachable(url);

  return {
    component: artifact.component ?? "",
    type: inferType(artifact),
    label: url,
    status: "passed",
    deployedVersion,
  };
}

async function assertUrlReachable(url) {
  const head = await fetch(url, { method: "HEAD", headers: baseHeaders() });
  if (head.ok) {
    return;
  }
  if (![403, 405].includes(head.status)) {
    throw new Error(`URL ${url} returned ${head.status} to HEAD.`);
  }

  const get = await fetch(url, { method: "GET", headers: { ...baseHeaders(), Range: "bytes=0-0" } });
  if (!get.ok && get.status !== 206) {
    throw new Error(`URL ${url} returned ${get.status} to GET.`);
  }
}

async function verifyDownloadSha256(url, expected, token = "", githubAsset = false) {
  const response = await fetch(url, {
    headers: githubAsset
      ? githubHeaders(token, { Accept: "application/octet-stream" })
      : baseHeaders(),
  });
  if (!response.ok) {
    throw new Error(`checksum download failed for ${url} with ${response.status}.`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const actual = crypto.createHash("sha256").update(buffer).digest("hex");
  if (actual.toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`sha256 mismatch for ${url}: expected ${expected}, got ${actual}.`);
  }
}

function inferType(artifact) {
  const explicit = String(artifact.type ?? "").trim().toLowerCase();
  if (explicit) {
    return explicit.replaceAll("_", "-");
  }
  if (artifact.package || artifact.npmPackage) {
    return "npm";
  }
  if (artifact.crate) {
    return "crate";
  }
  if ((artifact.repository || artifact.repo) && (artifact.tag || artifact.tagName)) {
    return "github-release";
  }
  if (artifact.url || artifact.href) {
    return "url";
  }
  return "unknown";
}

function normalizeAssetList(value) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("github-release assets must be an array when provided.");
  }
  return value.map((asset) => {
    if (typeof asset === "string") {
      return { name: asset };
    }
    if (!asset.name) {
      throw new Error("github-release asset entries must include name.");
    }
    return {
      name: asset.name,
      sha256: asset.sha256 ?? asset.checksum?.sha256,
    };
  });
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: baseHeaders() });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`request failed for ${url} with ${response.status}: ${body}`);
  }
  return response.json();
}

async function githubJson(url, token) {
  const response = await fetch(url, { headers: githubHeaders(token) });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API request failed for ${url} with ${response.status}: ${body}`);
  }
  return response.json();
}

function githubHeaders(token, extra = {}) {
  return {
    ...baseHeaders(),
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    ...extra,
  };
}

function baseHeaders() {
  return {
    "User-Agent": "skenion-ci-release-train",
  };
}

function validateRepo(value) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(value ?? "")) {
    throw new Error(`repository must be in owner/repo form, got "${value}".`);
  }
}

function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/, "");
}

function artifactLabel(artifact) {
  return artifact.name ?? artifact.package ?? artifact.npmPackage ?? artifact.crate ?? artifact.url ?? artifact.tag ?? inferType(artifact);
}

function renderSummary(report, errors) {
  return [
    "## Release Artifact Verification",
    "",
    `- Train: ${report.trainId} (${report.trainVersion})`,
    `- Status: ${errors.length === 0 ? "passed" : "failed"}`,
    `- Artifacts: ${report.passedCount}/${report.artifactCount} passed`,
    "",
    "### Results",
    "",
    ...report.results.map((result) => `- ${result.status}: ${result.type} ${result.label}`),
    ...(errors.length === 0 ? [] : ["", "### Errors", "", ...errors.map((error) => `- ${error}`)]),
    "",
  ].join("\n");
}
