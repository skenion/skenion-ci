#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  appendStepSummary,
  ensureDir,
  parseArgs,
  setOutput,
  writeJson,
  writeText,
} from "./lib/github-actions.mjs";

const EXPECTED_SCHEMA = "skenion.compatibility-matrix";
const EXPECTED_SCHEMA_VERSION = "0.1.0";
const DEFAULT_OUT_DIR = ".skenion-compatibility";
const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";
const DEFAULT_CRATES_REGISTRY = "https://crates.io";
const USER_AGENT = "skenion-ci-compatibility-matrix/0.1 (+https://github.com/skenion/skenion-ci)";

try {
  const args = parseArgs();

  if (args["self-check"] === "true") {
    await runSelfCheck();
    console.log("verify-compatibility-matrix self-check passed.");
    process.exit(0);
  }

  const matrixInput = args.matrix ?? args["matrix-json"];
  if (matrixInput === undefined || String(matrixInput).trim() === "") {
    throw new Error("Missing required argument --matrix.");
  }

  const outDir = args["out-dir"] ?? DEFAULT_OUT_DIR;
  const matrixRoot = args["matrix-root"] ?? ".";
  const token = process.env.GH_TOKEN ?? "";

  ensureDir(outDir);
  const loaded = readMatrixSource(matrixInput, { matrixRoot, outDir });
  const report = await verifyCompatibilityMatrix(loaded.matrix, {
    source: loaded.label,
    normalizedPath: loaded.normalizedPath,
    token,
    fetchImpl: globalThis.fetch,
  });

  const reportPath = path.join(outDir, "compatibility-matrix-verification.json");
  const summaryPath = path.join(outDir, "compatibility-matrix-verification.md");
  const summary = renderSummary(report);

  writeJson(reportPath, report);
  writeText(summaryPath, summary);
  appendStepSummary(summary);

  setOutput("status", report.status);
  setOutput("verified-count", String(report["passed-count"]));
  setOutput("failure-count", String(report["failed-count"]));
  setOutput("report-path", reportPath);
  setOutput("summary-path", summaryPath);
  setOutput("summary", `${report.status}: ${report["passed-count"]}/${report["check-count"]} compatibility matrix checks passed.`);

  if (report.status !== "passed") {
    console.error("Compatibility matrix verification failed:");
    for (const error of report.errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(`Verified compatibility matrix for Contracts line ${report["contracts-line"]}.`);
} catch (error) {
  console.error(`::error::${error.message}`);
  process.exit(1);
}

async function verifyCompatibilityMatrix(matrix, options) {
  const checks = [];
  const errors = [];
  const warnings = [];
  const context = {
    fetchImpl: options.fetchImpl,
    token: options.token ?? "",
    releaseCache: new Map(),
  };

  const record = (name, status, message, details = {}) => {
    checks.push({ name, status, message, ...details });
    if (status === "failed") {
      errors.push(`${name}: ${message}`);
    }
  };

  if (!isPlainObject(matrix)) {
    record("matrix shape", "failed", "Compatibility matrix must be a JSON object.");
    return buildReport(matrix, options, checks, errors, warnings);
  }

  validateHeader(matrix, record);
  const contractsLine = validateContractsLine(matrix, record);
  const packageRefs = validatePackages(matrix, contractsLine, record);
  validateSdkContractsRange(matrix, contractsLine, record);
  validatePromotedEvidence(matrix, record);

  for (const packageRef of packageRefs.npm) {
    await verifyWithCheck(
      `npm ${packageRef.name}@${packageRef.version}`,
      record,
      () => verifyNpmPackage(packageRef, context),
    );
  }

  for (const packageRef of packageRefs.crates) {
    await verifyWithCheck(
      `crate ${packageRef.name}@${packageRef.version}`,
      record,
      () => verifyCrate(packageRef, context),
    );
  }

  const artifactErrors = [];
  const githubArtifacts = collectGithubArtifacts(matrix, artifactErrors);
  if (artifactErrors.length > 0) {
    for (const error of artifactErrors) {
      record("github release artifact shape", "failed", error);
    }
  }

  if (githubArtifacts.length > 0 && context.token.trim() === "") {
    record("github release credentials", "failed", "GH_TOKEN is required to verify Runtime or Studio GitHub release artifacts.");
  } else {
    for (const artifact of githubArtifacts) {
      await verifyWithCheck(
        `github release asset ${artifact.repository}@${artifact.tag}/${artifact.assetName}`,
        record,
        () => verifyGitHubReleaseAsset(artifact, context),
      );
    }
  }

  if (githubArtifacts.length === 0) {
    record("github release artifacts", "passed", "No Runtime or Studio GitHub release artifacts were listed.");
  }

  return buildReport(matrix, options, checks, errors, warnings);
}

function buildReport(matrix, options, checks, errors, warnings) {
  const passedCount = checks.filter((check) => check.status === "passed").length;
  const failedCount = checks.filter((check) => check.status === "failed").length;
  const contractsLine = isPlainObject(matrix) ? matrix["contracts-line"] ?? null : null;
  const contractsRange = isPlainObject(matrix) ? matrix["contracts-range"] ?? null : null;

  return {
    schema: "skenion.compatibility-matrix-verification",
    "schema-version": "0.1.0",
    status: failedCount === 0 ? "passed" : "failed",
    "contracts-line": contractsLine,
    "contracts-range": contractsRange,
    "verified-at": new Date().toISOString(),
    "matrix-source": options.source,
    "normalized-matrix-path": options.normalizedPath,
    "check-count": checks.length,
    "passed-count": passedCount,
    "failed-count": failedCount,
    checks,
    warnings,
    errors,
  };
}

function validateHeader(matrix, record) {
  const errors = [];
  if (matrix.schema !== EXPECTED_SCHEMA) {
    errors.push(`schema must be exactly "${EXPECTED_SCHEMA}".`);
  }
  if (matrix["schema-version"] !== EXPECTED_SCHEMA_VERSION) {
    errors.push(`schema-version must be exactly "${EXPECTED_SCHEMA_VERSION}".`);
  }
  if (!isPlainObject(matrix.components)) {
    errors.push("components must be an object.");
  }
  recordFromErrors(record, "matrix header", errors, "Matrix header uses the expected compatibility schema.");
}

function validateContractsLine(matrix, record) {
  const errors = [];
  const line = matrix["contracts-line"];
  const range = matrix["contracts-range"];
  const parsed = parseV0Line(line);

  if (!parsed) {
    errors.push('contracts-line must use a v0 line such as "0.45".');
  }

  const expectedRange = parsed ? canonicalRangeForLine(parsed) : "";
  if (range !== expectedRange) {
    errors.push(`contracts-range must be exactly "${expectedRange || ">=0.MINOR.0 <0.NEXT.0"}".`);
  }

  recordFromErrors(
    record,
    "contracts line",
    errors,
    `Contracts line ${line} uses canonical v0 range ${range}.`,
  );

  return parsed ? { ...parsed, line, range } : null;
}

function validatePackages(matrix, contractsLine, record) {
  const errors = [];
  const components = matrix.components ?? {};
  const contracts = components.contracts;
  const sdk = components.sdk;

  const contractsNpm = normalizePackageRef(contracts?.npm, "components.contracts.npm", {
    ecosystem: "npm",
    expectedName: "@skenion/contracts",
    required: true,
    errors,
  });
  const contractsCrate = normalizePackageRef(contracts?.crate ?? contracts?.["crate-package"], "components.contracts.crate", {
    ecosystem: "crates.io",
    expectedName: "skenion-contracts",
    required: true,
    errors,
  });
  const sdkNpm = normalizePackageRef(sdk?.npm, "components.sdk.npm", {
    ecosystem: "npm",
    expectedName: "@skenion/sdk",
    required: false,
    errors,
  });

  for (const packageRef of [contractsNpm, contractsCrate].filter(Boolean)) {
    validatePackageVersionOnLine(packageRef, contractsLine, errors);
  }

  if (sdkNpm) {
    assertSemverLike(sdkNpm.version, `${sdkNpm.label}.version`, errors);
  }

  recordFromErrors(
    record,
    "registry package shape",
    errors,
    "Contracts npm/crate package refs and optional SDK npm package ref are well formed.",
  );

  return {
    npm: [contractsNpm, sdkNpm].filter(Boolean),
    crates: [contractsCrate].filter(Boolean),
  };
}

function validateSdkContractsRange(matrix, contractsLine, record) {
  const sdk = matrix.components?.sdk;
  if (sdk === undefined) {
    record("sdk contracts range", "passed", "No SDK component was listed.");
    return;
  }

  const errors = [];
  const range = firstNonEmptyString(
    sdk["contracts-range"],
    sdk["supported-contracts-range"],
    sdk.supportedContractsRange,
    sdk.contracts?.range,
    sdk.contracts?.["supported-range"],
    sdk.npm?.["contracts-range"],
  );

  if (!range) {
    errors.push("components.sdk must declare the supported Contracts range when SDK is listed.");
  } else if (contractsLine && range !== contractsLine.range) {
    errors.push(`components.sdk supported Contracts range must be exactly "${contractsLine.range}".`);
  }

  recordFromErrors(
    record,
    "sdk contracts range",
    errors,
    "SDK declares the same Contracts line range as the compatibility matrix.",
  );
}

function validatePromotedEvidence(matrix, record) {
  if (!isPromotedMatrix(matrix)) {
    record("promotion evidence", "passed", "Matrix is not promoted; examples and docs promotion flags are not required.");
    return;
  }

  const errors = [];
  const examplesStatus = evidenceStatus(
    matrix.components?.examples?.conformance?.status,
    matrix.components?.examples?.["conformance-status"],
    matrix["examples-conformance"]?.status,
    matrix["release-gates"]?.["examples-conformance"]?.status,
  );
  if (!isPassedStatus(examplesStatus)) {
    errors.push("promoted matrices require examples conformance status to be passed.");
  }

  const manual = matrix.components?.docs?.manual;
  if (!isPlainObject(manual)) {
    errors.push("promoted matrices require components.docs.manual.");
  } else {
    const pagesUrl = firstNonEmptyString(manual["pages-url"], manual.url, manual.pages?.url);
    if (!pagesUrl) {
      errors.push("promoted matrix docs manual must include a Pages URL.");
    }

    const pagesStatus = evidenceStatus(
      manual["pages-status"],
      manual["deployment-status"],
      manual.pages?.status,
      manual.deployment?.status,
      matrix["release-gates"]?.["docs-pages-deployment"]?.status,
    );
    const pagesDeployed = manual["pages-deployed"] === true || manual.pages?.deployed === true || isPassedStatus(pagesStatus);
    if (!pagesDeployed) {
      errors.push("promoted matrix docs manual must mark Pages deployment as deployed or passed.");
    }

    const manualPromoted =
      manual.promoted === true ||
      manual["latest-promoted"] === true ||
      isPassedStatus(evidenceStatus(manual["promotion-status"], manual.promotion?.status));
    if (!manualPromoted) {
      errors.push("promoted matrix docs manual must be marked promoted.");
    }
  }

  recordFromErrors(
    record,
    "promotion evidence",
    errors,
    "Promoted matrix has passed examples conformance and promoted Manual Pages evidence.",
  );
}

async function verifyWithCheck(name, record, fn) {
  try {
    const details = await fn();
    record(name, "passed", "Verified.", details);
  } catch (error) {
    record(name, "failed", error.message);
  }
}

async function verifyNpmPackage(packageRef, context) {
  const registry = stripTrailingSlash(packageRef.registry ?? DEFAULT_NPM_REGISTRY);
  const metadata = await fetchJson(`${registry}/${npmPackagePath(packageRef.name)}`, {
    fetchImpl: context.fetchImpl,
    headers: baseHeaders(),
  });

  if (!metadata.versions?.[packageRef.version]) {
    throw new Error(`npm package ${packageRef.name}@${packageRef.version} was not found in ${registry}.`);
  }

  return { registry, package: packageRef.name, version: packageRef.version };
}

async function verifyCrate(packageRef, context) {
  const registry = stripTrailingSlash(packageRef.registry ?? DEFAULT_CRATES_REGISTRY);
  await fetchJson(`${registry}/api/v1/crates/${encodeURIComponent(packageRef.name)}/${encodeURIComponent(packageRef.version)}`, {
    fetchImpl: context.fetchImpl,
    headers: baseHeaders(),
  });
  return { registry, crate: packageRef.name, version: packageRef.version };
}

async function verifyGitHubReleaseAsset(artifact, context) {
  const release = await loadGitHubRelease(artifact.repository, artifact.tag, context);
  if (release.draft) {
    throw new Error(`GitHub release ${artifact.repository}@${artifact.tag} is still a draft.`);
  }

  const asset = Array.isArray(release.assets)
    ? release.assets.find((candidate) => candidate.name === artifact.assetName)
    : undefined;
  if (!asset) {
    throw new Error(`GitHub release ${artifact.repository}@${artifact.tag} is missing asset "${artifact.assetName}".`);
  }

  const assetUrl = asset.url ?? asset.browser_download_url;
  if (!assetUrl) {
    throw new Error(`GitHub release asset "${artifact.assetName}" has no downloadable URL.`);
  }

  const bytes = await downloadBytes(assetUrl, {
    fetchImpl: context.fetchImpl,
    headers: githubHeaders(context.token, { Accept: "application/octet-stream" }),
  });
  const actual = sha256Hex(bytes);
  if (actual !== artifact.sha256) {
    throw new Error(`sha256 mismatch for ${artifact.assetName}: expected ${artifact.sha256}, got ${actual}.`);
  }

  return {
    component: artifact.component,
    artifact: artifact.id ?? artifact.assetName,
    repository: artifact.repository,
    tag: artifact.tag,
    sha256: actual,
  };
}

async function loadGitHubRelease(repository, tag, context) {
  const cacheKey = `${repository}\0${tag}`;
  if (context.releaseCache.has(cacheKey)) {
    return context.releaseCache.get(cacheKey);
  }

  const release = await fetchJson(
    `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
    {
      fetchImpl: context.fetchImpl,
      headers: githubHeaders(context.token),
    },
  );
  context.releaseCache.set(cacheKey, release);
  return release;
}

function collectGithubArtifacts(matrix, errors) {
  const components = matrix.components ?? {};
  const artifacts = [];
  const sources = [
    ["runtime", "components.runtime.artifacts", components.runtime?.artifacts],
    ["runtime", "components.runtime.binaries", components.runtime?.binaries],
    ["runtime", "components.runtime.assets", components.runtime?.assets],
    ["studio", "components.studio.artifacts", components.studio?.artifacts],
    ["studio", "components.studio.desktop-packages", components.studio?.["desktop-packages"]],
    ["studio", "components.studio.runtime-sidecars", components.studio?.["runtime-sidecars"]],
    ["studio", "components.studio.web-bundle", components.studio?.["web-bundle"]],
    ["studio", "components.studio.assets", components.studio?.assets],
  ];

  for (const [component, label, value] of sources) {
    collectGithubArtifactsFrom(value, { component, label }, artifacts, errors);
  }

  return dedupeArtifacts(artifacts);
}

function collectGithubArtifactsFrom(value, context, artifacts, errors) {
  if (value === undefined || value === null) {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectGithubArtifactsFrom(item, {
      ...context,
      label: `${context.label}[${index}]`,
    }, artifacts, errors));
    return;
  }

  if (!isPlainObject(value)) {
    return;
  }

  if (isGithubReleaseArtifact(value)) {
    const artifact = normalizeGithubArtifact(value, context.component, context.label, errors);
    if (artifact) {
      artifacts.push(artifact);
    }
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    collectGithubArtifactsFrom(child, {
      ...context,
      label: `${context.label}.${key}`,
    }, artifacts, errors);
  }
}

function isGithubReleaseArtifact(value) {
  return (
    value.source?.kind === "github-release-asset" ||
    value["source-kind"] === "github-release-asset" ||
    (firstNonEmptyString(value.repository, value.repo, value.source?.repository) &&
      firstNonEmptyString(value.tag, value["release-tag"], value.source?.tag) &&
      firstNonEmptyString(value["asset-name"], value.asset, value.source?.["asset-name"], value.name))
  );
}

function normalizeGithubArtifact(value, component, label, errors) {
  const repository = firstNonEmptyString(value.source?.repository, value.repository, value.repo);
  const tag = firstNonEmptyString(value.source?.tag, value.tag, value["release-tag"]);
  const assetName = firstNonEmptyString(value.source?.["asset-name"], value["asset-name"], value.asset, value.name);
  const sha256 = normalizeSha256(
    firstNonEmptyString(
      value.checksum?.value,
      value.checksum?.sha256,
      value.checksums?.sha256,
      value.sha256,
    ),
  );
  const localErrors = [];

  if (!isRepositoryName(repository)) {
    localErrors.push(`${label}.repository must be in owner/repo form.`);
  }
  if (!tag) {
    localErrors.push(`${label}.tag must be a non-empty string.`);
  }
  if (!assetName) {
    localErrors.push(`${label}.asset-name must be a non-empty string.`);
  }
  if (value.checksum?.algorithm !== undefined && value.checksum.algorithm !== "sha256") {
    localErrors.push(`${label}.checksum.algorithm must be "sha256" when provided.`);
  }
  if (!sha256) {
    localErrors.push(`${label} must include a sha256 checksum value.`);
  }

  errors.push(...localErrors);
  if (localErrors.length > 0) {
    return null;
  }

  return {
    component,
    label,
    id: value.id,
    repository,
    tag,
    assetName,
    sha256,
  };
}

function dedupeArtifacts(artifacts) {
  const seen = new Set();
  return artifacts.filter((artifact) => {
    const key = `${artifact.component}\0${artifact.repository}\0${artifact.tag}\0${artifact.assetName}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function normalizePackageRef(value, label, options) {
  const { ecosystem, expectedName, required, errors } = options;
  if (value === undefined || value === null) {
    if (required) {
      errors.push(`${label} is required.`);
    }
    return null;
  }
  if (!isPlainObject(value)) {
    errors.push(`${label} must be an object with name and version.`);
    return null;
  }

  const name = firstNonEmptyString(value.name, value.package, value.crate);
  const version = firstNonEmptyString(value.version);
  const declaredEcosystem = firstNonEmptyString(value.ecosystem);
  if (declaredEcosystem && declaredEcosystem !== ecosystem) {
    errors.push(`${label}.ecosystem must be "${ecosystem}" when provided.`);
  }
  if (name !== expectedName) {
    errors.push(`${label}.name must be exactly "${expectedName}".`);
  }
  assertSemverLike(version, `${label}.version`, errors);

  if (!name || !version) {
    return null;
  }

  return {
    label,
    ecosystem,
    name,
    version,
    registry: value.registry ?? value["registry-url"],
  };
}

function validatePackageVersionOnLine(packageRef, contractsLine, errors) {
  if (!contractsLine) {
    return;
  }
  const parsed = parseSemver(packageRef.version);
  if (!parsed) {
    return;
  }
  if (parsed.major !== 0 || parsed.minor !== contractsLine.minor) {
    errors.push(`${packageRef.label}.version must be inside Contracts line ${contractsLine.line}.`);
  }
}

function assertSemverLike(value, label, errors) {
  if (!isSemver(value)) {
    errors.push(`${label} must be registry-compatible SemVer.`);
  }
}

function recordFromErrors(record, name, errors, successMessage) {
  if (errors.length > 0) {
    record(name, "failed", errors.join(" "));
    return;
  }
  record(name, "passed", successMessage);
}

function parseV0Line(value) {
  const match = String(value ?? "").trim().match(/^0\.([1-9][0-9]*)$/);
  if (!match) {
    return null;
  }
  return { major: 0, minor: Number(match[1]) };
}

function canonicalRangeForLine(line) {
  return `>=0.${line.minor}.0 <0.${line.minor + 1}.0`;
}

function parseSemver(value) {
  const match = String(value ?? "").trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function isSemver(value) {
  return parseSemver(value) !== null;
}

function isPromotedMatrix(matrix) {
  return (
    matrix.promoted === true ||
    matrix["promoted-at"] !== undefined ||
    String(matrix.status ?? "").toLowerCase() === "promoted" ||
    String(matrix["promotion-state"] ?? "").toLowerCase() === "promoted" ||
    isPassedStatus(evidenceStatus(matrix.promotion?.status))
  );
}

function evidenceStatus(...values) {
  return firstNonEmptyString(...values)?.toLowerCase() ?? "";
}

function isPassedStatus(value) {
  return new Set(["passed", "success", "succeeded", "verified", "deployed", "published", "promoted"]).has(String(value ?? "").toLowerCase());
}

async function fetchJson(url, options) {
  const response = await checkedFetch(url, options);
  return response.json();
}

async function downloadBytes(url, options) {
  const response = await checkedFetch(url, options);
  return Buffer.from(await response.arrayBuffer());
}

async function checkedFetch(url, options) {
  const fetchImpl = options.fetchImpl;
  if (typeof fetchImpl !== "function") {
    throw new Error("This verifier requires a Node.js runtime with fetch support.");
  }

  const response = await fetchImpl(url, {
    method: options.method ?? "GET",
    headers: options.headers ?? baseHeaders(),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`request failed for ${url} with ${response.status}: ${body}`);
  }
  return response;
}

function baseHeaders(extra = {}) {
  return {
    Accept: "application/json",
    "User-Agent": USER_AGENT,
    ...extra,
  };
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

function readMatrixSource(source, options = {}) {
  const matrixRoot = options.matrixRoot ?? ".";
  const outDir = options.outDir ?? DEFAULT_OUT_DIR;
  const rawSource = String(source ?? "").trim();
  const looksLikeJson = rawSource.startsWith("{") || rawSource.startsWith("[");
  const loaded = looksLikeJson
    ? readInlineJson(rawSource)
    : readMatrixFile(rawSource, matrixRoot);
  const normalizedPath = path.join(outDir, "compatibility-matrix.normalized.json");

  writeJson(normalizedPath, loaded.matrix);
  return {
    ...loaded,
    normalizedPath,
  };
}

function readInlineJson(rawSource) {
  try {
    return {
      kind: "json",
      label: "inline-json",
      matrix: JSON.parse(rawSource),
      sourcePath: "",
    };
  } catch (error) {
    throw new Error(`Compatibility matrix JSON input could not be parsed: ${error.message}`);
  }
}

function readMatrixFile(rawSource, matrixRoot) {
  const sourcePath = path.isAbsolute(rawSource)
    ? rawSource
    : path.resolve(matrixRoot, rawSource);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Compatibility matrix file does not exist: ${sourcePath}`);
  }

  try {
    return {
      kind: "path",
      label: rawSource,
      matrix: JSON.parse(fs.readFileSync(sourcePath, "utf8")),
      sourcePath,
    };
  } catch (error) {
    throw new Error(`Compatibility matrix file could not be parsed as JSON: ${sourcePath}: ${error.message}`);
  }
}

function renderSummary(report) {
  return [
    "## skenion Compatibility Matrix Verification",
    "",
    `- Status: ${report.status}`,
    `- Contracts line: ${report["contracts-line"] ?? "(missing)"}`,
    `- Contracts range: ${report["contracts-range"] ?? "(missing)"}`,
    `- Checks: ${report["passed-count"]}/${report["check-count"]} passed`,
    `- Normalized matrix: ${report["normalized-matrix-path"]}`,
    "",
    "### Checks",
    "",
    ...report.checks.map((check) => `- ${check.status}: ${check.name} - ${check.message}`),
    ...(report.errors.length === 0 ? [] : ["", "### Errors", "", ...report.errors.map((error) => `- ${error}`)]),
    "",
  ].join("\n");
}

async function runSelfCheck() {
  const runtimeBytes = Buffer.from("skenion runtime artifact\n");
  const runtimeSha = sha256Hex(runtimeBytes);
  const valid = selfCheckMatrix(runtimeSha);
  const cases = [
    {
      name: "valid matrix",
      matrix: valid,
      expectedStatus: "passed",
    },
    {
      name: "bad SDK range",
      matrix: mutateMatrix(valid, (matrix) => {
        matrix.components.sdk["contracts-range"] = ">=0.44.0 <0.45.0";
      }),
      expectedStatus: "failed",
      errorPattern: /SDK declares|sdk contracts range/i,
    },
    {
      name: "missing runtime artifact",
      matrix: mutateMatrix(valid, (matrix) => {
        matrix.components.runtime.binaries["aarch64-apple-darwin"].source["asset-name"] = "missing-runtime.tar.gz";
        matrix.components.runtime.binaries["aarch64-apple-darwin"].name = "missing-runtime.tar.gz";
      }),
      expectedStatus: "failed",
      errorPattern: /missing asset "missing-runtime\.tar\.gz"/,
    },
    {
      name: "checksum mismatch",
      matrix: mutateMatrix(valid, (matrix) => {
        matrix.components.runtime.binaries["aarch64-apple-darwin"].checksum.value = "b".repeat(64);
      }),
      expectedStatus: "failed",
      errorPattern: /sha256 mismatch/,
    },
    {
      name: "unpromoted docs",
      matrix: mutateMatrix(valid, (matrix) => {
        matrix.components.docs.manual.promoted = false;
      }),
      expectedStatus: "failed",
      errorPattern: /docs manual must be marked promoted/,
    },
  ];

  for (const selfCheckCase of cases) {
    const report = await verifyCompatibilityMatrix(selfCheckCase.matrix, {
      source: `self-check:${selfCheckCase.name}`,
      normalizedPath: "",
      token: "self-check-token",
      fetchImpl: selfCheckFetch(runtimeBytes),
    });
    assertSelfCheck(
      report.status === selfCheckCase.expectedStatus,
      `${selfCheckCase.name} expected ${selfCheckCase.expectedStatus}, got ${report.status}: ${report.errors.join("; ")}`,
    );
    if (selfCheckCase.errorPattern) {
      assertSelfCheck(
        selfCheckCase.errorPattern.test(report.errors.join("\n")),
        `${selfCheckCase.name} did not report expected error: ${report.errors.join("; ")}`,
      );
    }
  }
}

function selfCheckMatrix(runtimeSha) {
  return {
    schema: EXPECTED_SCHEMA,
    "schema-version": EXPECTED_SCHEMA_VERSION,
    promoted: true,
    "contracts-line": "0.45",
    "contracts-range": ">=0.45.0 <0.46.0",
    components: {
      contracts: {
        npm: {
          ecosystem: "npm",
          name: "@skenion/contracts",
          version: "0.45.0",
        },
        crate: {
          ecosystem: "crates.io",
          name: "skenion-contracts",
          version: "0.45.0",
        },
      },
      runtime: {
        binaries: {
          "aarch64-apple-darwin": {
            id: "runtime-aarch64-apple-darwin",
            name: "skenion-runtime-aarch64-apple-darwin.tar.gz",
            source: {
              kind: "github-release-asset",
              repository: "skenion/skenion-runtime",
              tag: "skenion-runtime-v0.45.0",
              "asset-name": "skenion-runtime-aarch64-apple-darwin.tar.gz",
            },
            checksum: {
              algorithm: "sha256",
              value: runtimeSha,
            },
          },
        },
      },
      sdk: {
        "contracts-range": ">=0.45.0 <0.46.0",
        npm: {
          ecosystem: "npm",
          name: "@skenion/sdk",
          version: "0.45.0",
        },
      },
      examples: {
        conformance: {
          status: "passed",
        },
      },
      docs: {
        manual: {
          version: "0.45.0",
          path: "/manual/0.45/",
          "pages-url": "https://skenion.github.io/skenion-docs/manual/0.45/",
          "pages-deployed": true,
          promoted: true,
        },
      },
    },
  };
}

function selfCheckFetch(runtimeBytes) {
  return async (url) => {
    const textUrl = String(url);
    if (textUrl.includes("registry.npmjs.org")) {
      const name = textUrl.includes("%40skenion%2Fsdk") ? "@skenion/sdk" : "@skenion/contracts";
      return jsonResponse({ name, versions: { "0.45.0": {} } });
    }
    if (textUrl.includes("crates.io/api/v1/crates/skenion-contracts/0.45.0")) {
      return jsonResponse({ version: { num: "0.45.0" } });
    }
    if (textUrl.includes("api.github.com/repos/skenion/skenion-runtime/releases/tags/skenion-runtime-v0.45.0")) {
      return jsonResponse({
        draft: false,
        prerelease: false,
        assets: [
          {
            name: "skenion-runtime-aarch64-apple-darwin.tar.gz",
            url: "https://api.github.com/assets/runtime-aarch64-apple-darwin",
          },
        ],
      });
    }
    if (textUrl === "https://api.github.com/assets/runtime-aarch64-apple-darwin") {
      return bytesResponse(runtimeBytes);
    }
    return textResponse("not found", 404);
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function bytesResponse(value, status = 200) {
  return new Response(value, { status });
}

function textResponse(value, status = 200) {
  return new Response(value, { status });
}

function mutateMatrix(matrix, fn) {
  const next = JSON.parse(JSON.stringify(matrix));
  fn(next);
  return next;
}

function assertSelfCheck(condition, message) {
  if (!condition) {
    throw new Error(`self-check failed: ${message}`);
  }
}

function normalizeSha256(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(text) ? text : "";
}

function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function npmPackagePath(name) {
  return encodeURIComponent(name);
}

function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/, "");
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return "";
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRepositoryName(value) {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value ?? "");
}
