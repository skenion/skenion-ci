import fs from "node:fs";
import path from "node:path";
import { ensureDir, trainIdFromVersion, writeJson } from "./github-actions.mjs";

export const REQUIRED_RUNTIME_TARGETS = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "aarch64-pc-windows-msvc",
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
];

export const EXPECTED_TRAIN_MANIFEST_SCHEMA = "skenion.release-train";
export const EXPECTED_TRAIN_MANIFEST_SCHEMA_VERSION = "0.1.0";
export const EXPECTED_RELEASE_ORDER = ["contracts", "runtime", "sdk", "studio", "examples", "docs"];

export function validateTrainManifestInvariants(manifest, expectedVersion) {
  const errors = [];
  const header = manifestHeader(manifest);
  const components = normalizeComponents(manifest);
  const order = releaseOrder(manifest);
  const targets = extractRuntimeTargets(manifest, components);
  const trainVersion = header.trainVersion ?? expectedVersion;
  const trainId = header.trainId ?? expectedTrainId(trainVersion);

  validateHeader(header, expectedVersion, errors);
  validateComponents(components, expectedVersion, errors);
  validateReleaseOrder(order, components, errors);
  validateTargetMatrix(targets, errors);

  return {
    errors,
    header,
    components,
    order,
    targets,
    trainVersion,
    trainId,
  };
}

function validateHeader(header, expectedVersion, errors) {
  if (header.schema !== EXPECTED_TRAIN_MANIFEST_SCHEMA) {
    errors.push(`Manifest schema must be exactly "${EXPECTED_TRAIN_MANIFEST_SCHEMA}".`);
  }
  if (header.schemaVersion !== EXPECTED_TRAIN_MANIFEST_SCHEMA_VERSION) {
    errors.push(`Manifest schemaVersion must be exactly "${EXPECTED_TRAIN_MANIFEST_SCHEMA_VERSION}".`);
  }
  if (!isNonEmptyString(header.name)) {
    errors.push("Manifest must include a non-empty name field.");
  }
  if (header.version === undefined || header.version === null || String(header.version).trim() === "") {
    errors.push("Manifest must include a non-empty version field.");
  }
  if (!isNonEmptyString(header.trainVersion)) {
    errors.push("Manifest must include a non-empty trainVersion field.");
  } else if (header.trainVersion !== expectedVersion) {
    errors.push(`Manifest trainVersion "${header.trainVersion}" does not match expected train version "${expectedVersion}".`);
  }
  if (!isNonEmptyString(header.trainId)) {
    errors.push("Manifest must include a non-empty trainId field.");
  } else {
    const expectedId = expectedTrainId(expectedVersion);
    if (expectedId && header.trainId !== expectedId) {
      errors.push(`Manifest trainId "${header.trainId}" does not match expected train id "${expectedId}".`);
    }
  }
}

function validateComponents(components, expectedVersion, errors) {
  if (components.length === 0) {
    errors.push("Manifest must include a non-empty components array or object.");
    return;
  }

  const seen = new Set();
  const componentNames = new Set();

  for (const component of components) {
    if (!isNonEmptyString(component.name)) {
      errors.push("Every component must include a non-empty name.");
      continue;
    }

    if (seen.has(component.name)) {
      errors.push(`Component "${component.name}" appears more than once.`);
    }
    seen.add(component.name);
    componentNames.add(component.name);

    if (component.version !== expectedVersion) {
      errors.push(`Component "${component.name}" version "${component.version}" must equal lockstep train version "${expectedVersion}".`);
    }
    if (!isNonEmptyString(component.repository)) {
      errors.push(`Component "${component.name}" must include a repository field.`);
    }
  }

  for (const name of EXPECTED_RELEASE_ORDER) {
    if (!componentNames.has(name)) {
      errors.push(`Manifest must include the "${name}" release train component.`);
    }
  }

  for (const name of componentNames) {
    if (!EXPECTED_RELEASE_ORDER.includes(name)) {
      errors.push(`Manifest includes unsupported release train component "${name}".`);
    }
  }
}

function validateReleaseOrder(order, components, errors) {
  if (!Array.isArray(order) || order.length === 0) {
    errors.push("Manifest must include a releaseOrder array.");
    return;
  }

  const componentNames = new Set(components.map((component) => component.name).filter(Boolean));
  const duplicates = new Set();
  const seenOrderNames = new Set();

  for (const name of order) {
    if (seenOrderNames.has(name)) {
      duplicates.add(name);
    }
    seenOrderNames.add(name);
    if (!componentNames.has(name)) {
      errors.push(`releaseOrder references unknown component "${name}".`);
    }
  }

  for (const name of duplicates) {
    errors.push(`releaseOrder includes duplicate component "${name}".`);
  }

  if (!arraysEqual(order, EXPECTED_RELEASE_ORDER)) {
    errors.push(`releaseOrder must be exactly ${EXPECTED_RELEASE_ORDER.join(" -> ")}.`);
  }
}

function validateTargetMatrix(targets, errors) {
  if (targets.length === 0) {
    errors.push("Manifest must include artifactTargets, targetMatrix, or runtime.targetMatrix.");
    return;
  }

  for (const target of REQUIRED_RUNTIME_TARGETS) {
    if (!targets.includes(target)) {
      errors.push(`Runtime artifact target matrix is missing "${target}".`);
    }
  }
}

export function readManifestSource(source, options = {}) {
  const manifestRoot = options.manifestRoot ?? ".";
  const outDir = options.outDir ?? ".skenion-train";
  const rawSource = String(source ?? "").trim();

  if (rawSource === "") {
    throw new Error("Manifest input is required.");
  }

  ensureDir(outDir);

  const looksLikeJson = rawSource.startsWith("{") || rawSource.startsWith("[");
  const loaded = looksLikeJson
    ? readInlineJson(rawSource)
    : readManifestFile(rawSource, manifestRoot);
  const normalizedPath = path.join(outDir, "manifest.normalized.json");

  writeJson(normalizedPath, loaded.manifest);

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
      manifest: JSON.parse(rawSource),
      sourcePath: "",
    };
  } catch (error) {
    throw new Error(`Manifest JSON input could not be parsed: ${error.message}`);
  }
}

function readManifestFile(rawSource, manifestRoot) {
  const sourcePath = path.isAbsolute(rawSource)
    ? rawSource
    : path.resolve(manifestRoot, rawSource);

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Manifest file does not exist: ${sourcePath}`);
  }

  try {
    return {
      kind: "path",
      label: rawSource,
      manifest: JSON.parse(fs.readFileSync(sourcePath, "utf8")),
      sourcePath,
    };
  } catch (error) {
    throw new Error(`Manifest file could not be parsed as JSON: ${sourcePath}: ${error.message}`);
  }
}

export function manifestHeader(manifest) {
  return {
    schema: manifest.schema,
    schemaVersion: manifest.schemaVersion,
    name: manifest.name,
    version: manifest.version,
    trainId: manifest.trainId,
    trainVersion: manifest.trainVersion,
  };
}

export function normalizeComponents(manifest) {
  const value = manifest.components;
  if (Array.isArray(value)) {
    return value.map((component) => normalizeComponent(component));
  }

  if (isPlainObject(value)) {
    return Object.entries(value).map(([name, component]) => {
      if (!isPlainObject(component)) {
        return normalizeComponent({ name, version: component });
      }
      return normalizeComponent({ name, ...component });
    });
  }

  return [];
}

function normalizeComponent(component) {
  const name = component.name ?? component.id ?? component.component;
  return {
    ...component,
    name: typeof name === "string" ? name.trim() : name,
    version: component.version ?? component.releaseVersion ?? component.packageVersion,
    repository: component.repository ?? component.repo,
  };
}

export function releaseOrder(manifest) {
  const value = manifest.releaseOrder ?? manifest.release?.order;
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}

export function extractRuntimeTargets(manifest, components = normalizeComponents(manifest)) {
  const runtime = components.find((component) => component.name === "runtime");
  const candidates = [
    manifest.artifactTargets,
    manifest.targetMatrix,
    manifest.artifactTargetMatrix,
    manifest.runtime?.artifactTargets,
    manifest.runtime?.targetMatrix,
    runtime?.artifactTargets,
    runtime?.targetMatrix,
    runtime?.targets,
  ];

  for (const candidate of candidates) {
    const targets = collectTargets(candidate);
    if (targets.length > 0) {
      return [...new Set(targets)].sort();
    }
  }

  return [];
}

function collectTargets(value) {
  if (value === undefined || value === null) {
    return [];
  }

  if (typeof value === "string") {
    return value.trim() ? [value.trim()] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectTargets(item));
  }

  if (!isPlainObject(value)) {
    return [];
  }

  const explicit = [value.target, value.triple, value.rustTarget]
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => item.trim());

  const nested = Object.entries(value).flatMap(([key, item]) => {
    const keyTarget = looksLikeRustTarget(key) ? [key] : [];
    return [...keyTarget, ...collectTargets(item)];
  });

  return [...explicit, ...nested];
}

function looksLikeRustTarget(value) {
  return /^[A-Za-z0-9_]+-[A-Za-z0-9_]+-[A-Za-z0-9_.-]+(?:-[A-Za-z0-9_.-]+)?$/.test(value);
}

export function extractArtifacts(manifest, components = normalizeComponents(manifest)) {
  const artifacts = [];
  collectArtifacts(manifest.artifacts, {}, artifacts);
  collectArtifacts(manifest.releaseArtifacts, {}, artifacts);
  collectArtifacts(manifest.verification?.artifacts, {}, artifacts);

  for (const component of components) {
    collectArtifacts(component.artifacts, { component: component.name }, artifacts);
    collectArtifacts(component.releaseArtifacts, { component: component.name }, artifacts);
  }

  return artifacts;
}

function collectArtifacts(value, inherited, artifacts) {
  if (value === undefined || value === null) {
    return;
  }

  if (typeof value === "string") {
    artifacts.push({ ...inherited, type: "url", url: value });
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectArtifacts(item, inherited, artifacts);
    }
    return;
  }

  if (!isPlainObject(value)) {
    return;
  }

  if (isArtifact(value)) {
    artifacts.push({ ...inherited, ...value });
    return;
  }

  for (const [name, nested] of Object.entries(value)) {
    collectArtifacts(nested, { ...inherited, component: inherited.component ?? name }, artifacts);
  }
}

function isArtifact(value) {
  return Boolean(
    value.type ||
      value.url ||
      value.package ||
      value.npmPackage ||
      value.crate ||
      value.repository ||
      value.repo ||
      value.tag ||
      value.sha256,
  );
}

export function expectedTrainId(trainVersion) {
  return trainIdFromVersion(trainVersion);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}
