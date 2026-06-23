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

export const REQUIRED_STUDIO_TARGETS = REQUIRED_RUNTIME_TARGETS;

const EXPECTED_PROTOCOL_BASELINES = {
  graph: "0.1",
  project: "0.1",
  node: "0.1",
  extension: "0.1",
  runtimeHttp: "v0",
  runtimeCollaboration: "v0",
};

const EXPECTED_CONNECTION_PROFILES = ["local-managed", "local-shared", "remote"];

const EXPECTED_REGISTRY_PACKAGES = {
  "contracts.npm": { ecosystem: "npm", name: "@skenion/contracts" },
  "contracts.crate": { ecosystem: "crates.io", name: "skenion-contracts" },
  "sdk.npm": { ecosystem: "npm", name: "@skenion/sdk" },
};

const CANONICAL_COMPONENT_REPOSITORIES = {
  contracts: "skenion/skenion-contracts",
  runtime: "skenion/skenion-runtime",
  sdk: "skenion/skenion-sdk",
  studio: "skenion/skenion-studio",
  examples: "skenion/skenion-examples",
  docs: "skenion/skenion-docs",
};

const CANONICAL_DOCS_PAGES_ORIGIN = "https://skenion.github.io/skenion-docs";
const STUDIO_WEB_BUNDLE_ARTIFACT_ID = "studio-web-bundle";

const PRODUCT_REGISTRY_PACKAGE_POLICIES = {
  "components.runtime.crate":
    "Runtime distribution is a GitHub Release multi-arch binary surface unless a later policy adds a stable embeddable library crate.",
  "components.studio.web":
    "Studio web is a deployed or released web/static product artifact unless a later policy adds an embeddable library package.",
  "components.studio.desktop":
    "Studio desktop is a signed GitHub Release desktop artifact, not an npm package.",
};

const RELEASE_BLOCKING_TARGETS = new Set([
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "x86_64-unknown-linux-gnu",
]);

const GATE_STATUSES = new Set(["pending", "passed", "failed", "waived"]);

export function validateTrainManifestInvariants(manifest, expectedVersion) {
  const errors = [];
  const header = manifestHeader(manifest);
  const components = normalizeComponents(manifest);
  const order = releaseOrder(manifest);
  const targets = extractRuntimeTargets(manifest, components);
  const studioTargets = extractStudioTargets(manifest, components);
  const trainVersion = header.trainVersion ?? expectedVersion;
  const trainId = header.trainId ?? expectedTrainId(trainVersion);

  if (!isPlainObject(manifest)) {
    errors.push("Manifest must be a JSON object.");
  }

  validateHeader(header, expectedVersion, errors);
  validateContractsManifestShape(manifest, errors);
  validateProtocolBaselines(manifest?.protocolBaselines, "protocolBaselines", errors);
  validateCapabilitySet(manifest?.capabilitySet, errors);
  validateComponents(manifest, components, expectedVersion, trainId, errors);
  validateReleaseOrder(manifest, order, components, errors);
  validateTargetMatrix(targets, REQUIRED_RUNTIME_TARGETS, "Runtime artifact target matrix", errors);
  validateTargetMatrix(studioTargets.desktopPackages, REQUIRED_STUDIO_TARGETS, "Studio desktop package target matrix", errors);
  validateTargetMatrix(studioTargets.runtimeSidecars, REQUIRED_STUDIO_TARGETS, "Studio runtime sidecar target matrix", errors);
  validateReleaseGates(manifest, expectedVersion, errors);
  validateExplicitDownloadArtifacts(manifest, components, errors);

  return {
    errors,
    header,
    components,
    order,
    targets,
    studioTargets,
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

function validateContractsManifestShape(manifest, errors) {
  for (const field of ["protocolBaselines", "capabilitySet", "components", "releaseGates"]) {
    if (!isPlainObject(manifest?.[field])) {
      errors.push(`Manifest must include a ${field} object.`);
    }
  }

  if (Array.isArray(manifest?.components)) {
    errors.push("Manifest components must use the Contracts v0.1 object shape, not an array.");
  }
}

function validateProtocolBaselines(value, label, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${label} must be an object.`);
    return;
  }

  for (const [key, expected] of Object.entries(EXPECTED_PROTOCOL_BASELINES)) {
    if (value[key] !== expected) {
      errors.push(`${label}.${key} must be exactly "${expected}".`);
    }
  }
}

function validateCapabilitySet(value, errors) {
  if (!isPlainObject(value)) {
    return;
  }

  validateProtocolBaselines(value.protocolSurfaces, "capabilitySet.protocolSurfaces", errors);
  validateExactCapabilityObject(
    value.runtime,
    "capabilitySet.runtime",
    {
      sessionAddressing: true,
      eventReplay: true,
      multiWindow: true,
      collaboration: "server-authoritative-ot",
      operationLog: true,
      ioDiscovery: "raw-descriptor",
      authPolicy: "deferred",
    },
    errors,
  );
  validateConnectionProfiles(value.runtime?.connectionProfiles, "capabilitySet.runtime.connectionProfiles", errors);
  validateExactCapabilityObject(
    value.studio,
    "capabilitySet.studio",
    {
      graphEditor: true,
      patchLibrary: true,
      subpatches: true,
      livingHelp: true,
      graphClipboard: true,
      desktopShell: "tauri",
    },
    errors,
  );
  validateConnectionProfiles(value.studio?.connectionProfiles, "capabilitySet.studio.connectionProfiles", errors);
  validateExactCapabilityObject(
    value.marketplace,
    "capabilitySet.marketplace",
    {
      packageDiscovery: true,
      packageInstall: true,
      packageUpdate: true,
      extensionPackages: true,
    },
    errors,
  );
  validateExactCapabilityObject(
    value.manual,
    "capabilitySet.manual",
    {
      versionedPaths: true,
      pagesDeployment: true,
      latestPromotionRequiresMatrix: true,
      patchReleasesUseMajorMinorPath: true,
    },
    errors,
  );
}

function validateExactCapabilityObject(value, label, expectedValues, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${label} must be an object.`);
    return;
  }

  for (const [key, expected] of Object.entries(expectedValues)) {
    if (value[key] !== expected) {
      errors.push(`${label}.${key} must be exactly ${JSON.stringify(expected)}.`);
    }
  }
}

function validateConnectionProfiles(value, label, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${label} must include ${EXPECTED_CONNECTION_PROFILES.join(", ")}.`);
    return;
  }

  const profiles = [...new Set(value.map((item) => String(item).trim()).filter(Boolean))].sort();
  const expected = [...EXPECTED_CONNECTION_PROFILES].sort();
  if (!arraysEqual(profiles, expected)) {
    errors.push(`${label} must be exactly ${EXPECTED_CONNECTION_PROFILES.join(", ")}.`);
  }
}

function validateComponents(manifest, components, expectedVersion, trainId, errors) {
  if (components.length === 0) {
    errors.push("Manifest must include a non-empty components object.");
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
    } else if (
      CANONICAL_COMPONENT_REPOSITORIES[component.name] &&
      component.repository !== CANONICAL_COMPONENT_REPOSITORIES[component.name]
    ) {
      errors.push(`Component "${component.name}" repository must be exactly "${CANONICAL_COMPONENT_REPOSITORIES[component.name]}".`);
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

  const rawComponents = isPlainObject(manifest?.components) ? manifest.components : {};
  validateRegistryPackage(rawComponents.contracts?.npm, "components.contracts.npm", expectedVersion, EXPECTED_REGISTRY_PACKAGES["contracts.npm"], errors);
  validateRegistryPackage(rawComponents.contracts?.crate, "components.contracts.crate", expectedVersion, EXPECTED_REGISTRY_PACKAGES["contracts.crate"], errors);
  validateRegistryPackage(rawComponents.sdk?.npm, "components.sdk.npm", expectedVersion, EXPECTED_REGISTRY_PACKAGES["sdk.npm"], errors);
  validateProductRegistryPackageAbsent(rawComponents.runtime?.crate, "components.runtime.crate", errors);
  validateProductRegistryPackageAbsent(rawComponents.studio?.web, "components.studio.web", errors);
  validateProductRegistryPackageAbsent(rawComponents.studio?.desktop, "components.studio.desktop", errors);

  validateArtifactMap(
    rawComponents.runtime?.binaries,
    "components.runtime.binaries",
    "runtime-binary",
    expectedVersion,
    CANONICAL_COMPONENT_REPOSITORIES.runtime,
    errors,
  );
  validateArtifactMap(
    rawComponents.studio?.desktopPackages,
    "components.studio.desktopPackages",
    "studio-desktop-package",
    expectedVersion,
    CANONICAL_COMPONENT_REPOSITORIES.studio,
    errors,
    {
      expectedName: (_artifact, target) => studioDesktopArchiveName(target),
    },
  );
  validateArtifactMap(
    rawComponents.studio?.runtimeSidecars,
    "components.studio.runtimeSidecars",
    "studio-runtime-sidecar",
    expectedVersion,
    CANONICAL_COMPONENT_REPOSITORIES.studio,
    errors,
  );
  validateStudioWebBundleArtifact(rawComponents.studio?.["web-bundle"], expectedVersion, errors);
  validateExamplesComponent(rawComponents.examples, expectedVersion, errors);
  validateDocsComponent(rawComponents.docs, expectedVersion, trainId, errors);
}

function validateRegistryPackage(packageRef, label, expectedVersion, expectedPackage, errors) {
  if (!isPlainObject(packageRef)) {
    errors.push(`${label} must be an object.`);
    return;
  }

  if (packageRef.ecosystem !== expectedPackage.ecosystem) {
    errors.push(`${label}.ecosystem must be exactly "${expectedPackage.ecosystem}".`);
  }
  if (packageRef.name !== expectedPackage.name) {
    errors.push(`${label}.name must be exactly "${expectedPackage.name}".`);
  }
  if (packageRef.version !== expectedVersion) {
    errors.push(`${label}.version "${packageRef.version}" must equal lockstep train version "${expectedVersion}".`);
  }
  if (packageRef.url !== undefined && packageRef.url !== null && !isNonEmptyString(packageRef.url)) {
    errors.push(`${label}.url must be null or a non-empty string.`);
  }
}

function validateProductRegistryPackageAbsent(packageRef, label, errors) {
  if (packageRef === undefined || packageRef === null) {
    return;
  }

  errors.push(`${label} is outside the v0 registry publish surface. ${PRODUCT_REGISTRY_PACKAGE_POLICIES[label]}`);
}

function validateArtifactMap(artifactMap, label, expectedKind, expectedVersion, expectedRepository, errors, options = {}) {
  if (!isPlainObject(artifactMap)) {
    errors.push(`${label} must be an object keyed by target triple.`);
    return;
  }

  for (const target of Object.keys(artifactMap)) {
    if (!REQUIRED_RUNTIME_TARGETS.includes(target)) {
      errors.push(`${label} includes unsupported target "${target}".`);
    }
  }

  for (const target of REQUIRED_RUNTIME_TARGETS) {
    const artifact = artifactMap[target];
    if (!isPlainObject(artifact)) {
      errors.push(`${label} must include "${target}".`);
      continue;
    }

    if (!isNonEmptyString(artifact.id)) {
      errors.push(`${label}.${target}.id must be a non-empty string.`);
    }
    if (artifact.target !== target) {
      errors.push(`${label}.${target}.target must match the map key.`);
    }
    if (artifact.supportTier !== expectedSupportTier(target)) {
      errors.push(`${label}.${target}.supportTier must be "${expectedSupportTier(target)}".`);
    }
    if (artifact.kind !== expectedKind) {
      errors.push(`${label}.${target}.kind must be "${expectedKind}".`);
    }
    if (!isNonEmptyString(artifact.name)) {
      errors.push(`${label}.${target}.name must be a non-empty string.`);
    }
    if (artifact.version !== expectedVersion) {
      errors.push(`${label}.${target}.version "${artifact.version}" must equal lockstep train version "${expectedVersion}".`);
    }
    if (expectedRepository && artifact.source?.kind !== "github-release-asset") {
      errors.push(`${label}.${target}.source.kind must be "github-release-asset".`);
    }
    if (typeof options.expectedName === "function") {
      const expectedName = options.expectedName(artifact, target);
      if (artifact.name !== expectedName) {
        errors.push(`${label}.${target}.name must be exactly "${expectedName}".`);
      }
      if (artifact.source?.kind === "github-release-asset" && artifact.source.assetName !== expectedName) {
        errors.push(`${label}.${target}.source.assetName must be exactly "${expectedName}".`);
      }
    }
    validateArtifactSource(artifact.source, `${label}.${target}.source`, artifact.checksum, errors, expectedRepository);
    validateChecksum(artifact.checksum, `${label}.${target}.checksum`, errors);
  }
}

function validateStudioWebBundleArtifact(artifact, expectedVersion, errors) {
  const label = `components.studio["web-bundle"]`;
  if (!isPlainObject(artifact)) {
    errors.push(`${label} must be an object.`);
    return;
  }

  const expectedName = `skenion-studio-web-bundle-v${expectedVersion}.tar.gz`;
  const expectedTag = `skenion-studio-v${expectedVersion}`;
  if (artifact.id !== STUDIO_WEB_BUNDLE_ARTIFACT_ID) {
    errors.push(`${label}.id must be exactly "${STUDIO_WEB_BUNDLE_ARTIFACT_ID}".`);
  }
  if (artifact.kind !== "studio-web-bundle") {
    errors.push(`${label}.kind must be exactly "studio-web-bundle".`);
  }
  if (artifact.name !== expectedName) {
    errors.push(`${label}.name must be exactly "${expectedName}".`);
  }
  if (artifact.version !== expectedVersion) {
    errors.push(`${label}.version "${artifact.version}" must equal lockstep train version "${expectedVersion}".`);
  }
  if (artifact.source?.kind !== "github-release-asset") {
    errors.push(`${label}.source.kind must be "github-release-asset".`);
  }
  validateArtifactSource(
    artifact.source,
    `${label}.source`,
    artifact.checksum,
    errors,
    CANONICAL_COMPONENT_REPOSITORIES.studio,
  );
  if (artifact.source?.kind === "github-release-asset") {
    if (artifact.source.tag !== expectedTag) {
      errors.push(`${label}.source.tag must be exactly "${expectedTag}".`);
    }
    if (artifact.source.assetName !== expectedName) {
      errors.push(`${label}.source.assetName must be exactly "${expectedName}".`);
    }
  }
  validateChecksum(artifact.checksum, `${label}.checksum`, errors);
}

function validateArtifactSource(source, label, checksum, errors, expectedRepository) {
  if (!isPlainObject(source)) {
    errors.push(`${label} must be an object.`);
    return;
  }

  if (source.kind === "github-release-asset") {
    if (!isRepositoryName(source.repository)) {
      errors.push(`${label}.repository must be in owner/repo form.`);
    } else if (expectedRepository && source.repository !== expectedRepository) {
      errors.push(`${label}.repository must be exactly "${expectedRepository}".`);
    }
    if (!isNonEmptyString(source.tag)) {
      errors.push(`${label}.tag must be a non-empty string.`);
    }
    if (!isNonEmptyString(source.assetName)) {
      errors.push(`${label}.assetName must be a non-empty string.`);
    }
    if (source.url !== undefined && source.url !== null && !isNonEmptyString(source.url)) {
      errors.push(`${label}.url must be null or a non-empty string.`);
    }
    return;
  }

  if (source.kind === "url") {
    if (!isNonEmptyString(source.url)) {
      errors.push(`${label}.url must be a non-empty string.`);
    }
    if (!isSha256(checksum?.value)) {
      errors.push(`${label} URL artifacts must include a sha256 checksum value.`);
    }
    return;
  }

  errors.push(`${label}.kind must be "github-release-asset" or "url".`);
}

function validateChecksum(checksum, label, errors) {
  if (!isPlainObject(checksum)) {
    errors.push(`${label} must be an object.`);
    return;
  }
  if (checksum.algorithm !== "sha256") {
    errors.push(`${label}.algorithm must be exactly "sha256".`);
  }
  if (checksum.value !== null && checksum.value !== undefined && !isSha256(checksum.value)) {
    errors.push(`${label}.value must be null or a 64-character sha256 hex digest.`);
  }
}

function validateExamplesComponent(examples, expectedVersion, errors) {
  if (!isPlainObject(examples)) {
    errors.push("components.examples must be an object.");
    return;
  }
  if (!isRepositoryName(examples.repository)) {
    errors.push("components.examples.repository must be in owner/repo form.");
  } else if (examples.repository !== CANONICAL_COMPONENT_REPOSITORIES.examples) {
    errors.push(`components.examples.repository must be exactly "${CANONICAL_COMPONENT_REPOSITORIES.examples}".`);
  }
  if (examples.version !== expectedVersion) {
    errors.push(`components.examples.version "${examples.version}" must equal lockstep train version "${expectedVersion}".`);
  }
  if (!isNonEmptyString(examples.tag)) {
    errors.push("components.examples.tag must be a non-empty string.");
  }
}

function validateDocsComponent(docs, expectedVersion, trainId, errors) {
  if (!isPlainObject(docs?.manual)) {
    errors.push("components.docs.manual must be an object.");
    return;
  }

  const manual = docs.manual;
  if (manual.version !== expectedVersion) {
    errors.push(`components.docs.manual.version "${manual.version}" must equal lockstep train version "${expectedVersion}".`);
  }
  const expectedPath = `/manual/${trainId}/`;
  if (manual.path !== expectedPath) {
    errors.push(`components.docs.manual.path must be exactly "${expectedPath}".`);
  }
  const expectedPagesUrl = `${CANONICAL_DOCS_PAGES_ORIGIN}${expectedPath}`;
  if (manual.pagesUrl !== expectedPagesUrl) {
    errors.push(`components.docs.manual.pagesUrl must be exactly "${expectedPagesUrl}".`);
  }
}

function validateReleaseOrder(manifest, order, components, errors) {
  const explicit = explicitReleaseOrder(manifest);
  if (explicit !== undefined && !Array.isArray(explicit)) {
    errors.push("releaseOrder must be an array when provided.");
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

function validateTargetMatrix(targets, requiredTargets, label, errors) {
  if (targets.length === 0) {
    errors.push(`${label} is missing.`);
    return;
  }

  for (const target of requiredTargets) {
    if (!targets.includes(target)) {
      errors.push(`${label} is missing "${target}".`);
    }
  }

  for (const target of targets) {
    if (!requiredTargets.includes(target)) {
      errors.push(`${label} includes unsupported target "${target}".`);
    }
  }
}

function validateReleaseGates(manifest, expectedVersion, errors) {
  const releaseGates = manifest?.releaseGates;
  const components = isPlainObject(manifest?.components) ? manifest.components : {};
  if (!isPlainObject(releaseGates)) {
    return;
  }

  validateRegistryPackageGates(releaseGates.registryPackages, components, expectedVersion, errors);

  const artifactsById = releaseTrainArtifactsById(manifest, errors);
  validateArtifactCollectionGate(
    releaseGates.githubReleaseAssets?.runtime,
    "releaseGates.githubReleaseAssets.runtime",
    artifactsById,
    CANONICAL_COMPONENT_REPOSITORIES.runtime,
    errors,
  );
  validateArtifactCollectionGate(
    releaseGates.githubReleaseAssets?.studio,
    "releaseGates.githubReleaseAssets.studio",
    artifactsById,
    CANONICAL_COMPONENT_REPOSITORIES.studio,
    errors,
  );
  validateChecksumGate(releaseGates.checksumVerification, artifactsById, errors);
  validateStudioWebBundleGateMembership(releaseGates, components.studio?.["web-bundle"], errors);
  validateRuntimeSmokeGates(releaseGates.runtimeSmoke, components.runtime?.binaries, artifactsById, errors);
  validateStudioSmokeGates(releaseGates.studioPackageSmoke, components.studio?.desktopPackages, components.studio?.runtimeSidecars, artifactsById, errors);
  validateExamplesConformanceGate(releaseGates.examplesConformance, components.examples, expectedVersion, errors);
  validateDocsPagesDeploymentGate(releaseGates.docsPagesDeployment, components.docs?.manual, expectedVersion, errors);
}

function validateRegistryPackageGates(registryPackages, components, expectedVersion, errors) {
  if (!isPlainObject(registryPackages)) {
    errors.push("releaseGates.registryPackages must be an object.");
    return;
  }

  const gates = [
    ["contractsNpm", "components.contracts.npm", components.contracts?.npm],
    ["contractsCrate", "components.contracts.crate", components.contracts?.crate],
    ["sdkNpm", "components.sdk.npm", components.sdk?.npm],
  ];
  const allowedGateNames = new Set(gates.map(([gateName]) => gateName));

  for (const gateName of Object.keys(registryPackages)) {
    if (!allowedGateNames.has(gateName)) {
      errors.push(`releaseGates.registryPackages.${gateName} is outside the v0 registry publish surface. Registry gates are only for importable library packages.`);
    }
  }

  for (const [gateName, componentLabel, componentPackage] of gates) {
    const gate = registryPackages[gateName];
    const gateLabel = `releaseGates.registryPackages.${gateName}`;
    validateGateBase(gate, gateLabel, errors);
    if (!isPlainObject(gate)) {
      continue;
    }
    if (!isPlainObject(gate.package)) {
      errors.push(`${gateLabel}.package must be an object.`);
      continue;
    }
    if (gate.package.version !== expectedVersion) {
      errors.push(`${gateLabel}.package.version must equal lockstep train version "${expectedVersion}".`);
    }
    if (packageIdentity(gate.package) !== packageIdentity(componentPackage)) {
      errors.push(`${gateLabel}.package must match ${componentLabel}.`);
    }
  }
}

function validateArtifactCollectionGate(gate, label, artifactsById, expectedRepository, errors) {
  validateGateBase(gate, label, errors);
  if (!isPlainObject(gate)) {
    return;
  }
  if (!isRepositoryName(gate.repository)) {
    errors.push(`${label}.repository must be in owner/repo form.`);
  } else if (expectedRepository && gate.repository !== expectedRepository) {
    errors.push(`${label}.repository must be exactly "${expectedRepository}".`);
  }
  if (!isNonEmptyString(gate.tag)) {
    errors.push(`${label}.tag must be a non-empty string.`);
  }
  if (!Array.isArray(gate.artifactIds) || gate.artifactIds.length === 0) {
    errors.push(`${label}.artifactIds must be a non-empty array.`);
    return;
  }

  validateUniqueStrings(gate.artifactIds, `${label}.artifactIds`, errors);
  for (const artifactId of gate.artifactIds) {
    const artifact = artifactsById.get(artifactId);
    if (!artifact) {
      errors.push(`${label}.artifactIds references unknown artifact "${artifactId}".`);
      continue;
    }
    if (artifact.source?.kind === "github-release-asset") {
      if (artifact.source.repository !== gate.repository) {
        errors.push(`${label}.repository must match artifact "${artifactId}" source repository.`);
      }
      if (artifact.source.tag !== gate.tag) {
        errors.push(`${label}.tag must match artifact "${artifactId}" source tag.`);
      }
    }
  }
}

function validateStudioWebBundleGateMembership(releaseGates, webBundleArtifact, errors) {
  if (!isPlainObject(webBundleArtifact)) {
    return;
  }
  const artifactId = webBundleArtifact.id;
  if (!Array.isArray(releaseGates.githubReleaseAssets?.studio?.artifactIds)) {
    return;
  }
  if (!releaseGates.githubReleaseAssets.studio.artifactIds.includes(artifactId)) {
    errors.push(`releaseGates.githubReleaseAssets.studio.artifactIds must include components.studio["web-bundle"].id.`);
  }
  if (Array.isArray(releaseGates.checksumVerification?.artifactIds) && !releaseGates.checksumVerification.artifactIds.includes(artifactId)) {
    errors.push(`releaseGates.checksumVerification.artifactIds must include components.studio["web-bundle"].id.`);
  }
}

function validateChecksumGate(gate, artifactsById, errors) {
  const label = "releaseGates.checksumVerification";
  validateGateBase(gate, label, errors);
  if (!isPlainObject(gate)) {
    return;
  }
  if (!Array.isArray(gate.artifactIds) || gate.artifactIds.length === 0) {
    errors.push(`${label}.artifactIds must be a non-empty array.`);
    return;
  }

  validateUniqueStrings(gate.artifactIds, `${label}.artifactIds`, errors);
  for (const artifactId of gate.artifactIds) {
    if (!artifactsById.has(artifactId)) {
      errors.push(`${label}.artifactIds references unknown artifact "${artifactId}".`);
    }
  }

  if (gate.expectedChecksums !== undefined && !isPlainObject(gate.expectedChecksums)) {
    errors.push(`${label}.expectedChecksums must be an object when provided.`);
    return;
  }

  for (const [artifactId, expectedChecksum] of Object.entries(gate.expectedChecksums ?? {})) {
    const artifact = artifactsById.get(artifactId);
    if (!artifact) {
      errors.push(`${label}.expectedChecksums references unknown artifact "${artifactId}".`);
      continue;
    }
    validateChecksum(expectedChecksum, `${label}.expectedChecksums.${artifactId}`, errors);
    if (artifact.checksum?.value === null && expectedChecksum.value !== null) {
      errors.push(`${label}.expectedChecksums.${artifactId} cannot pin a checksum while the artifact checksum is null.`);
    }
    if (
      isSha256(artifact.checksum?.value) &&
      isSha256(expectedChecksum.value) &&
      artifact.checksum.value.toLowerCase() !== expectedChecksum.value.toLowerCase()
    ) {
      errors.push(`${label}.expectedChecksums.${artifactId} must match the artifact checksum.`);
    }
  }
}

function validateRuntimeSmokeGates(runtimeSmoke, runtimeBinaries, artifactsById, errors) {
  if (!isPlainObject(runtimeSmoke)) {
    errors.push("releaseGates.runtimeSmoke must be an object.");
    return;
  }

  for (const target of Object.keys(runtimeSmoke)) {
    if (!REQUIRED_RUNTIME_TARGETS.includes(target)) {
      errors.push(`releaseGates.runtimeSmoke includes unsupported target "${target}".`);
    }
  }

  for (const target of REQUIRED_RUNTIME_TARGETS) {
    const gate = runtimeSmoke[target];
    const label = `releaseGates.runtimeSmoke.${target}`;
    validateGateBase(gate, label, errors);
    if (!isPlainObject(gate)) {
      continue;
    }
    if (gate.target !== target) {
      errors.push(`${label}.target must match the map key.`);
    }
    if (!artifactsById.has(gate.artifactId)) {
      errors.push(`${label}.artifactId references unknown artifact "${gate.artifactId}".`);
    }
    const artifact = runtimeBinaries?.[target];
    if (isPlainObject(artifact) && gate.artifactId !== artifact.id) {
      errors.push(`${label}.artifactId must match components.runtime.binaries.${target}.id.`);
    }
  }
}

function validateStudioSmokeGates(studioSmoke, desktopPackages, runtimeSidecars, artifactsById, errors) {
  if (!isPlainObject(studioSmoke)) {
    errors.push("releaseGates.studioPackageSmoke must be an object.");
    return;
  }

  for (const target of Object.keys(studioSmoke)) {
    if (!REQUIRED_STUDIO_TARGETS.includes(target)) {
      errors.push(`releaseGates.studioPackageSmoke includes unsupported target "${target}".`);
    }
  }

  for (const target of REQUIRED_STUDIO_TARGETS) {
    const gate = studioSmoke[target];
    const label = `releaseGates.studioPackageSmoke.${target}`;
    validateGateBase(gate, label, errors);
    if (!isPlainObject(gate)) {
      continue;
    }
    if (gate.target !== target) {
      errors.push(`${label}.target must match the map key.`);
    }
    if (!artifactsById.has(gate.desktopPackageArtifactId)) {
      errors.push(`${label}.desktopPackageArtifactId references unknown artifact "${gate.desktopPackageArtifactId}".`);
    }
    if (!artifactsById.has(gate.runtimeSidecarArtifactId)) {
      errors.push(`${label}.runtimeSidecarArtifactId references unknown artifact "${gate.runtimeSidecarArtifactId}".`);
    }
    const desktopPackage = desktopPackages?.[target];
    if (isPlainObject(desktopPackage) && gate.desktopPackageArtifactId !== desktopPackage.id) {
      errors.push(`${label}.desktopPackageArtifactId must match components.studio.desktopPackages.${target}.id.`);
    }
    const runtimeSidecar = runtimeSidecars?.[target];
    if (isPlainObject(runtimeSidecar) && gate.runtimeSidecarArtifactId !== runtimeSidecar.id) {
      errors.push(`${label}.runtimeSidecarArtifactId must match components.studio.runtimeSidecars.${target}.id.`);
    }
  }
}

function validateExamplesConformanceGate(gate, examples, expectedVersion, errors) {
  const label = "releaseGates.examplesConformance";
  validateGateBase(gate, label, errors);
  if (!isPlainObject(gate)) {
    return;
  }
  if (gate.version !== expectedVersion) {
    errors.push(`${label}.version must equal lockstep train version "${expectedVersion}".`);
  }
  if (gate.version !== examples?.version) {
    errors.push(`${label}.version must match components.examples.version.`);
  }
  if (gate.repository !== examples?.repository) {
    errors.push(`${label}.repository must match components.examples.repository.`);
  }
  if (gate.ref !== examples?.tag) {
    errors.push(`${label}.ref must match components.examples.tag.`);
  }
}

function validateDocsPagesDeploymentGate(gate, manual, expectedVersion, errors) {
  const label = "releaseGates.docsPagesDeployment";
  validateGateBase(gate, label, errors);
  if (!isPlainObject(gate)) {
    return;
  }
  if (gate.manualVersion !== expectedVersion) {
    errors.push(`${label}.manualVersion must equal lockstep train version "${expectedVersion}".`);
  }
  if (gate.manualVersion !== manual?.version) {
    errors.push(`${label}.manualVersion must match components.docs.manual.version.`);
  }
  if (gate.manualPath !== manual?.path) {
    errors.push(`${label}.manualPath must match components.docs.manual.path.`);
  }
  if (gate.pagesUrl !== manual?.pagesUrl) {
    errors.push(`${label}.pagesUrl must match components.docs.manual.pagesUrl.`);
  }
}

function validateGateBase(gate, label, errors) {
  if (!isPlainObject(gate)) {
    errors.push(`${label} must be an object.`);
    return;
  }
  if (!isNonEmptyString(gate.id)) {
    errors.push(`${label}.id must be a non-empty string.`);
  }
  if (!GATE_STATUSES.has(gate.status)) {
    errors.push(`${label}.status must be one of ${[...GATE_STATUSES].join(", ")}.`);
  }
  if (typeof gate.required !== "boolean") {
    errors.push(`${label}.required must be a boolean.`);
  }
}

function validateExplicitDownloadArtifacts(manifest, components, errors) {
  for (const artifact of extractExplicitArtifacts(manifest, components)) {
    const type = String(artifact.type ?? "").trim().toLowerCase().replaceAll("_", "-");
    const hasDownloadUrl = artifact.url || artifact.href;
    const isPage = type === "page" || type === "github-pages";
    const isDownload = type === "url" || type === "binary" || (!type && hasDownloadUrl && !isPage);
    if (isDownload && !artifactSha256(artifact)) {
      errors.push(`${artifactLabel(artifact)} must include sha256 checksum metadata.`);
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
  if (!isPlainObject(manifest)) {
    return {};
  }

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
  const value = manifest?.components;
  if (Array.isArray(value)) {
    return value.map((component) => normalizeComponent(component));
  }

  if (isPlainObject(value)) {
    return Object.entries(value).map(([name, component]) => {
      if (!isPlainObject(component)) {
        return normalizeComponent({ name, version: component });
      }
      return normalizeComponentFromContractsShape(name, component);
    });
  }

  return [];
}

function normalizeComponentFromContractsShape(name, component) {
  if (name === "contracts") {
    return normalizeComponent({
      ...component,
      name,
      version: firstValue(component.npm?.version, component.crate?.version),
      repository: component.repository ?? component.repo ?? CANONICAL_COMPONENT_REPOSITORIES.contracts,
    });
  }

  if (name === "runtime") {
    return normalizeComponent({
      ...component,
      name,
      version: firstValue(firstArtifactVersion(component.binaries), component.crate?.version),
      repository: component.repository ?? component.repo ?? repositoryFromArtifacts(component.binaries) ?? CANONICAL_COMPONENT_REPOSITORIES.runtime,
    });
  }

  if (name === "sdk") {
    return normalizeComponent({
      ...component,
      name,
      version: component.npm?.version,
      repository: component.repository ?? component.repo ?? CANONICAL_COMPONENT_REPOSITORIES.sdk,
    });
  }

  if (name === "studio") {
    return normalizeComponent({
      ...component,
      name,
      version: firstValue(
        firstArtifactVersion(component.desktopPackages),
        firstArtifactVersion(component.runtimeSidecars),
        component["web-bundle"]?.version,
        component.web?.version,
        component.desktop?.version,
      ),
      repository:
        component.repository ??
        component.repo ??
        repositoryFromArtifacts(component.desktopPackages, component.runtimeSidecars) ??
        repositoryFromArtifacts({ "web-bundle": component["web-bundle"] }) ??
        CANONICAL_COMPONENT_REPOSITORIES.studio,
    });
  }

  if (name === "examples") {
    return normalizeComponent({
      ...component,
      name,
      version: component.version,
      repository: component.repository ?? component.repo ?? CANONICAL_COMPONENT_REPOSITORIES.examples,
    });
  }

  if (name === "docs") {
    return normalizeComponent({
      ...component,
      name,
      version: component.manual?.version,
      repository:
        component.repository ??
        component.repo ??
        repositoryFromGitHubPagesUrl(component.manual?.pagesUrl) ??
        CANONICAL_COMPONENT_REPOSITORIES.docs,
    });
  }

  return normalizeComponent({ name, ...component });
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
  const value = explicitReleaseOrder(manifest);
  if (value === undefined) {
    return [...EXPECTED_RELEASE_ORDER];
  }
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}

export function extractRuntimeTargets(manifest, components = normalizeComponents(manifest)) {
  const runtime = components.find((component) => component.name === "runtime");
  const candidates = [
    manifest?.components?.runtime?.binaries,
    runtime?.binaries,
    manifest?.artifactTargets,
    manifest?.targetMatrix,
    manifest?.artifactTargetMatrix,
    manifest?.runtime?.artifactTargets,
    manifest?.runtime?.targetMatrix,
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

export function extractStudioTargets(manifest, components = normalizeComponents(manifest)) {
  const studio = components.find((component) => component.name === "studio");
  return {
    desktopPackages: collectTargetSet(manifest?.components?.studio?.desktopPackages, studio?.desktopPackages),
    runtimeSidecars: collectTargetSet(manifest?.components?.studio?.runtimeSidecars, studio?.runtimeSidecars),
  };
}

function collectTargetSet(...candidates) {
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
    if (looksLikeRustTarget(key)) {
      return [key];
    }
    if (Array.isArray(item)) {
      return collectTargets(item);
    }
    if (isPlainObject(item) && [item.target, item.triple, item.rustTarget].some((target) => isNonEmptyString(target))) {
      return collectTargets(item);
    }
    return [];
  });

  return [...explicit, ...nested];
}

function looksLikeRustTarget(value) {
  return /^[A-Za-z0-9_]+-[A-Za-z0-9_]+-[A-Za-z0-9_.-]+(?:-[A-Za-z0-9_.-]+)?$/.test(value);
}

export function extractArtifacts(manifest, components = normalizeComponents(manifest)) {
  return [
    ...extractExplicitArtifacts(manifest, components),
    ...extractContractsReleaseArtifacts(manifest),
  ];
}

function extractExplicitArtifacts(manifest, components = normalizeComponents(manifest)) {
  const artifacts = [];
  collectArtifacts(manifest?.artifacts, {}, artifacts);
  collectArtifacts(manifest?.releaseArtifacts, {}, artifacts);
  collectArtifacts(manifest?.verification?.artifacts, {}, artifacts);

  for (const component of components) {
    collectArtifacts(component.artifacts, { component: component.name }, artifacts);
    collectArtifacts(component.releaseArtifacts, { component: component.name }, artifacts);
  }

  return artifacts;
}

function extractContractsReleaseArtifacts(manifest) {
  const artifacts = [];
  const releaseGates = manifest?.releaseGates;
  if (!isPlainObject(releaseGates)) {
    return artifacts;
  }

  for (const [gateName, gate] of Object.entries(releaseGates.registryPackages ?? {})) {
    if (!isPlainObject(gate?.package)) {
      continue;
    }
    const packageRef = gate.package;
    const component = componentNameFromRegistryGate(gateName);
    if (packageRef.ecosystem === "npm") {
      artifacts.push({
        component,
        type: "npm",
        package: packageRef.name,
        version: packageRef.version,
      });
    }
    if (packageRef.ecosystem === "crates.io") {
      artifacts.push({
        component,
        type: "crate",
        crate: packageRef.name,
        version: packageRef.version,
      });
    }
  }

  const artifactsById = releaseTrainArtifactsById(manifest);
  const checksumGate = checksumGateArtifacts(releaseGates.checksumVerification);
  collectGitHubReleaseGateArtifact(releaseGates.githubReleaseAssets?.runtime, "runtime", artifactsById, manifest.trainVersion, artifacts, checksumGate);
  collectGitHubReleaseGateArtifact(releaseGates.githubReleaseAssets?.studio, "studio", artifactsById, manifest.trainVersion, artifacts, checksumGate);

  for (const artifact of releaseTrainArtifacts(manifest)) {
    if (artifact.source?.kind === "url") {
      artifacts.push({
        component: componentNameFromArtifactKind(artifact.kind),
        type: "binary",
        url: artifact.source.url,
        version: artifact.version,
        sha256: artifact.checksum?.value,
      });
    }
  }

  const docsGate = releaseGates.docsPagesDeployment;
  if (isPlainObject(docsGate)) {
    artifacts.push({
      component: "docs",
      type: "github-pages",
      url: docsGate.pagesUrl,
      version: manifest.trainVersion,
      deployedVersion: docsGate.manualVersion,
      status: docsGate.status,
    });
  }

  return artifacts;
}

function collectGitHubReleaseGateArtifact(gate, component, artifactsById, trainVersion, artifacts, checksumGate) {
  if (!isPlainObject(gate) || !Array.isArray(gate.artifactIds)) {
    return;
  }

  const assets = gate.artifactIds.flatMap((artifactId) => {
    const artifact = artifactsById.get(artifactId);
    if (!artifact || artifact.source?.kind !== "github-release-asset") {
      return [];
    }
    const name = artifact.source.assetName ?? artifact.name;
    const sha256 = artifact.checksum?.value ?? checksumGate.expectedChecksums.get(artifactId)?.value ?? undefined;
    return [
      {
        name,
        sha256,
        checksumRequired: checksumGate.artifactIds.has(artifactId),
        checksumArtifactId: artifactId,
        checksumSidecarName: `${name}.sha256`,
      },
    ];
  });

  artifacts.push({
    component,
    type: "github-release",
    repository: gate.repository,
    tag: gate.tag,
    version: trainVersion,
    assets,
  });
}

function checksumGateArtifacts(gate) {
  const artifactIds = new Set(Array.isArray(gate?.artifactIds) ? gate.artifactIds.filter(isNonEmptyString) : []);
  const expectedChecksums = new Map();
  if (isPlainObject(gate?.expectedChecksums)) {
    for (const [artifactId, checksum] of Object.entries(gate.expectedChecksums)) {
      if (isSha256(checksum?.value)) {
        expectedChecksums.set(artifactId, checksum);
      }
    }
  }
  return { artifactIds, expectedChecksums };
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

function explicitReleaseOrder(manifest) {
  if (manifest?.releaseOrder !== undefined) {
    return manifest.releaseOrder;
  }
  if (manifest?.release?.order !== undefined) {
    return manifest.release.order;
  }
  return undefined;
}

function releaseTrainArtifactsById(manifest, errors = []) {
  const byId = new Map();
  for (const artifact of releaseTrainArtifacts(manifest)) {
    if (!isNonEmptyString(artifact.id)) {
      continue;
    }
    if (byId.has(artifact.id)) {
      errors.push(`Release artifact id "${artifact.id}" appears more than once.`);
    }
    byId.set(artifact.id, artifact);
  }
  return byId;
}

function releaseTrainArtifacts(manifest) {
  const components = isPlainObject(manifest?.components) ? manifest.components : {};
  return [
    ...objectValues(components.runtime?.binaries),
    ...objectValues(components.studio?.desktopPackages),
    ...objectValues(components.studio?.runtimeSidecars),
    components.studio?.["web-bundle"],
  ].filter(isPlainObject);
}

function repositoryFromArtifacts(...artifactMaps) {
  for (const artifactMap of artifactMaps) {
    for (const artifact of objectValues(artifactMap)) {
      if (isRepositoryName(artifact.source?.repository)) {
        return artifact.source.repository;
      }
    }
  }
  return undefined;
}

function repositoryFromGitHubPagesUrl(value) {
  if (!isNonEmptyString(value)) {
    return undefined;
  }

  try {
    const parsed = new URL(value);
    const suffix = ".github.io";
    if (!parsed.hostname.endsWith(suffix)) {
      return undefined;
    }
    const owner = parsed.hostname.slice(0, -suffix.length);
    const repo = parsed.pathname.split("/").filter(Boolean)[0];
    return owner && repo ? `${owner}/${repo}` : undefined;
  } catch {
    return undefined;
  }
}

function expectedSupportTier(target) {
  return RELEASE_BLOCKING_TARGETS.has(target) ? "release-blocking" : "preview";
}

function studioDesktopArchiveName(target) {
  const extension = target.includes("windows-msvc") ? "zip" : "tar.gz";
  return `skenion-studio-${target}.${extension}`;
}

function packageIdentity(packageRef) {
  if (!isPlainObject(packageRef)) {
    return "";
  }
  return [packageRef.ecosystem, packageRef.name, packageRef.version].join("\0");
}

function validateUniqueStrings(values, label, errors) {
  const seen = new Set();
  for (const value of values) {
    if (!isNonEmptyString(value)) {
      errors.push(`${label} must contain only non-empty strings.`);
      continue;
    }
    if (seen.has(value)) {
      errors.push(`${label} includes duplicate "${value}".`);
    }
    seen.add(value);
  }
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== "");
}

function firstArtifactVersion(...artifactMaps) {
  for (const artifactMap of artifactMaps) {
    for (const artifact of objectValues(artifactMap)) {
      if (isNonEmptyString(artifact.version)) {
        return artifact.version;
      }
    }
  }
  return undefined;
}

function objectValues(value) {
  return isPlainObject(value) ? Object.values(value) : [];
}

function artifactSha256(artifact) {
  return artifact.sha256 ?? artifact.checksum?.sha256 ?? artifact.checksum?.value;
}

function artifactLabel(artifact) {
  return artifact.name ?? artifact.package ?? artifact.npmPackage ?? artifact.crate ?? artifact.url ?? artifact.href ?? artifact.tag ?? "download artifact";
}

function componentNameFromRegistryGate(gateName) {
  if (gateName.startsWith("contracts")) {
    return "contracts";
  }
  if (gateName.startsWith("runtime")) {
    return "runtime";
  }
  if (gateName.startsWith("sdk")) {
    return "sdk";
  }
  if (gateName.startsWith("studio")) {
    return "studio";
  }
  return "";
}

function componentNameFromArtifactKind(kind) {
  if (kind === "runtime-binary") {
    return "runtime";
  }
  if (kind === "studio-desktop-package" || kind === "studio-runtime-sidecar") {
    return "studio";
  }
  if (kind === "studio-web-bundle") {
    return "studio";
  }
  return "";
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isRepositoryName(value) {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value ?? "");
}

function isSha256(value) {
  return typeof value === "string" && /^[a-fA-F0-9]{64}$/.test(value);
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}
