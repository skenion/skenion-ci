import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function parseArgs(argv = process.argv.slice(2)) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${token}`);
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = "true";
      continue;
    }

    args[key] = next;
    index += 1;
  }

  return args;
}

export function requireArg(args, name) {
  const value = args[name];
  if (value === undefined || String(value).trim() === "") {
    throw new Error(`Missing required argument --${name}`);
  }
  return String(value);
}

export function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

export function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(`${filePath}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(`${filePath}.tmp`, filePath);
}

export function writeText(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(`${filePath}.tmp`, value);
  fs.renameSync(`${filePath}.tmp`, filePath);
}

export function boolValue(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase() === "true";
}

export function normalizeMode(value) {
  const mode = String(value ?? "prepare").trim().toLowerCase();
  const allowed = new Set(["prepare", "publish", "verify"]);
  if (!allowed.has(mode)) {
    throw new Error(`Invalid mode "${value}". Expected one of: prepare, publish, verify.`);
  }
  return mode;
}

export function setOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) {
    return;
  }

  const text = String(value ?? "");
  if (!text.includes("\n")) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${text}\n`);
    return;
  }

  const delimiter = `skenion_${crypto.randomBytes(8).toString("hex")}`;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${text}\n${delimiter}\n`);
}

export function appendStepSummary(markdown) {
  if (!process.env.GITHUB_STEP_SUMMARY) {
    return;
  }
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown.trimEnd()}\n\n`);
}

export function assertSemver(version, label = "version") {
  const text = String(version ?? "");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(text)) {
    throw new Error(`${label} must be registry-compatible SemVer, got "${text}".`);
  }
}

export function failClosed(message, details = []) {
  console.error(`::error::${message}`);
  for (const detail of details) {
    console.error(`- ${detail}`);
  }
  process.exitCode = 1;
}
