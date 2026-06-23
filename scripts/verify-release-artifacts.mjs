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
  if (args["self-check"] === "true") {
    await runSelfCheck();
    console.log("verify-release-artifacts self-check passed.");
    process.exit(0);
  }

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
    throw new Error("Manifest must describe release artifacts before verify-release-artifacts can pass. Add artifacts entries or release-gates with supported types: github-release, npm, crate, url.");
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
    name: "skenion Release Artifact Verification",
    version: 1,
    "train-id": header["train-id"],
    "train-version": expectedVersion,
    "manifest-source": loaded.label,
    "verified-at": new Date().toISOString(),
    "artifact-count": artifacts.length,
    "passed-count": results.filter((result) => result.status === "passed").length,
    "failed-count": errors.length,
    results,
  };

  const reportPath = path.join(outDir, "release-artifact-verification.json");
  const summaryPath = path.join(outDir, "release-artifact-verification.md");
  const summary = renderSummary(report, errors);
  writeJson(reportPath, report);
  writeText(summaryPath, summary);
  appendStepSummary(summary);

  setOutput("verified-count", String(report["passed-count"]));
  setOutput("report-path", reportPath);
  setOutput("summary", `${report["passed-count"]}/${report["artifact-count"]} release artifacts verified for ${expectedVersion}.`);

  if (errors.length > 0) {
    console.error("Release artifact verification failed:");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(`Verified ${report["passed-count"]} release artifacts for ${expectedVersion}.`);
} catch (error) {
  console.error(`::error::${error.message}`);
  process.exit(1);
}

async function verifyArtifact(artifact, expectedVersion, token) {
  const type = inferType(artifact);
  const version = artifact.version ?? artifact["train-version"];
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
  const tag = artifact.tag;
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
  const checksumChecks = [];
  for (const expectedAsset of expectedAssets) {
    const actual = release.assets.find((asset) => asset.name === expectedAsset.name);
    if (!actual) {
      throw new Error(`GitHub release ${repo}@${tag} is missing asset "${expectedAsset.name}".`);
    }
    const checksum = await resolveAssetChecksum(expectedAsset, release.assets, token);
    if (checksum) {
      const actualSha256 = await verifyDownloadSha256(actual.url, checksum.value, token, true);
      checksumChecks.push({
        asset: expectedAsset.name,
        source: checksum.source,
        sha256: actualSha256,
      });
    }
  }

  return {
    component: artifact.component ?? "",
    type: "github-release",
    label: `${repo}@${tag}`,
    status: "passed",
    "asset-count": release.assets.length,
    "checked-assets": expectedAssets.map((asset) => asset.name),
    "checksum-checks": checksumChecks,
  };
}

async function verifyNpmPackage(artifact, expectedVersion) {
  const packageName = artifact.package;
  if (!packageName) {
    throw new Error("npm artifacts must include package.");
  }
  const registry = stripTrailingSlash(artifact.registry ?? artifact["registry-url"] ?? "https://registry.npmjs.org");
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
  const registry = stripTrailingSlash(artifact.registry ?? artifact["registry-url"] ?? "https://crates.io");
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

  const deployedVersion = artifact["deployed-version"] ?? artifact["manual-version"] ?? artifact["page-version"] ?? artifact.deployment?.version;
  if (deployedVersion !== expectedVersion) {
    throw new Error(`${inferType(artifact)} artifacts must include deployed-version, manual-version, page-version, or deployment.version matching "${expectedVersion}".`);
  }

  const status = String(artifact.status ?? artifact["deployment-status"] ?? artifact.deployment?.status ?? "").toLowerCase();
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
    "deployed-version": deployedVersion,
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

async function resolveAssetChecksum(expectedAsset, releaseAssets, token) {
  const manifestSha256 = normalizeSha256(expectedAsset.sha256, `manifest checksum for asset "${expectedAsset.name}"`);
  if (manifestSha256) {
    return { value: manifestSha256, source: "manifest" };
  }

  if (!expectedAsset.checksumRequired) {
    return null;
  }

  const sidecarName = expectedAsset.checksumSidecarName ?? `${expectedAsset.name}.sha256`;
  const sidecar = releaseAssets.find((asset) => asset.name === sidecarName);
  if (!sidecar) {
    throw new Error(`GitHub release asset "${expectedAsset.name}" is checksum-gated but has no manifest sha256 and is missing sidecar "${sidecarName}".`);
  }

  const buffer = await downloadBytes(sidecar.url, githubHeaders(token, { Accept: "application/octet-stream" }), `checksum sidecar download failed for ${sidecarName}`);
  const sha256 = parseSha256Sidecar(buffer.toString("utf8"), expectedAsset.name, sidecarName);
  return { value: sha256, source: `sidecar:${sidecarName}` };
}

async function verifyDownloadSha256(url, expected, token = "", githubAsset = false) {
  const expectedSha256 = normalizeSha256(expected, `expected sha256 for ${url}`);
  const buffer = await downloadBytes(
    url,
    githubAsset
      ? githubHeaders(token, { Accept: "application/octet-stream" })
      : baseHeaders(),
    `checksum download failed for ${url}`,
  );
  const actual = crypto.createHash("sha256").update(buffer).digest("hex");
  if (actual.toLowerCase() !== expectedSha256) {
    throw new Error(`sha256 mismatch for ${url}: expected ${expectedSha256}, got ${actual}.`);
  }
  return actual;
}

async function downloadBytes(url, headers, failurePrefix) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`${failurePrefix} with ${response.status}.`);
  }

  return Buffer.from(await response.arrayBuffer());
}

function parseSha256Sidecar(text, assetName, sidecarName) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) {
    throw new Error(`checksum sidecar "${sidecarName}" must contain exactly one sha256 line.`);
  }

  const match = lines[0].match(/^([a-fA-F0-9]{64})(?:\s+\*?(.+))?$/);
  if (!match) {
    throw new Error(`checksum sidecar "${sidecarName}" must contain a sha256 hex digest, optionally followed by the asset filename.`);
  }

  const filename = match[2]?.trim();
  if (filename && basename(filename) !== assetName) {
    throw new Error(`checksum sidecar "${sidecarName}" filename "${filename}" does not match asset "${assetName}".`);
  }

  return match[1].toLowerCase();
}

function normalizeSha256(value, label) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return "";
  }
  const text = String(value).trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(text)) {
    throw new Error(`${label} must be a 64-character sha256 hex digest.`);
  }
  return text;
}

function basename(value) {
  return String(value).split(/[\\/]/).pop();
}

async function runSelfCheck() {
  const digest = "a".repeat(64);
  assertSelfCheck(parseSha256Sidecar(`${digest}  asset.tgz\n`, "asset.tgz", "asset.tgz.sha256") === digest, "parses sha256sum sidecar format");
  assertSelfCheck(parseSha256Sidecar(`${digest}\n`, "asset.tgz", "asset.tgz.sha256") === digest, "parses bare sha256 sidecar format");
  assertSelfCheck(
    normalizeAssetList([{ name: "asset.tgz", checksum: { value: digest }, checksumRequired: true }])[0].sha256 === digest,
    "normalizes checksum.value metadata",
  );
  await assertSelfCheckRejects(
    () => resolveAssetChecksum({ name: "asset.tgz", checksumRequired: true }, [], ""),
    /missing sidecar "asset\.tgz\.sha256"/,
    "checksum-gated assets without manifest checksum require sidecars",
  );
  assertSelfCheckThrows(
    () => parseSha256Sidecar(`${digest}  other.tgz\n`, "asset.tgz", "asset.tgz.sha256"),
    /does not match asset/,
    "rejects sidecar filenames that do not match the asset",
  );
}

function assertSelfCheck(condition, message) {
  if (!condition) {
    throw new Error(`self-check failed: ${message}`);
  }
}

function assertSelfCheckThrows(fn, pattern, message) {
  try {
    fn();
  } catch (error) {
    assertSelfCheck(pattern.test(error.message), message);
    return;
  }
  throw new Error(`self-check failed: ${message}`);
}

async function assertSelfCheckRejects(fn, pattern, message) {
  try {
    await fn();
  } catch (error) {
    assertSelfCheck(pattern.test(error.message), message);
    return;
  }
  throw new Error(`self-check failed: ${message}`);
}

function inferType(artifact) {
  const explicit = String(artifact.type ?? "").trim().toLowerCase();
  if (explicit) {
    return explicit.replaceAll("_", "-");
  }
  if (artifact.package) {
    return "npm";
  }
  if (artifact.crate) {
    return "crate";
  }
  if ((artifact.repository || artifact.repo) && artifact.tag) {
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
      sha256: asset.sha256 ?? asset.checksum?.sha256 ?? asset.checksum?.value,
      checksumRequired: Boolean(asset.checksumRequired),
      checksumArtifactId: asset.checksumArtifactId,
      checksumSidecarName: asset.checksumSidecarName,
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
  return artifact.name ?? artifact.package ?? artifact.crate ?? artifact.url ?? artifact.tag ?? inferType(artifact);
}

function renderSummary(report, errors) {
  return [
    "## Release Artifact Verification",
    "",
    `- Train: ${report["train-id"]} (${report["train-version"]})`,
    `- Status: ${errors.length === 0 ? "passed" : "failed"}`,
    `- Artifacts: ${report["passed-count"]}/${report["artifact-count"]} passed`,
    "",
    "### Results",
    "",
    ...report.results.map((result) => `- ${result.status}: ${result.type} ${result.label}`),
    ...(errors.length === 0 ? [] : ["", "### Errors", "", ...errors.map((error) => `- ${error}`)]),
    "",
  ].join("\n");
}
