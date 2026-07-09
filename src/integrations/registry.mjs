// Package registry + installer for NimAgent.
//
// Resolves packages from a hosted registry.json, downloads the .zip, extracts
// it, and places the payload where NimAgent can see it:
//   - skill      -> skills/<name>/        (auto-discovered, no config edit)
//   - extension  -> extensions/<name>.js  (+ added to nimagent.config.json)
//   - mcp        -> mcpServers.<name>      (written to nimagent.config.json)
//
// Installed packages are tracked in <HOME>/packages.json so uninstall can undo
// exactly what was added. No third-party dependencies — unzip shells out to the
// platform's archiver (see extractZip).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { INSTALL_ROOT } from "../paths.mjs";
import { HOME } from "../core/config.mjs";
import { loadProjectConfig, writeProjectConfig } from "./extras.mjs";

export const DEFAULT_REGISTRY = "https://globalwarningnetworks.com/repo";

const PACKAGES_PATH = path.join(HOME, "packages.json");

// ---- installed-package bookkeeping -----------------------------------------

function readInstalled() {
  try {
    return JSON.parse(fs.readFileSync(PACKAGES_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeInstalled(obj) {
  fs.mkdirSync(path.dirname(PACKAGES_PATH), { recursive: true });
  fs.writeFileSync(PACKAGES_PATH, JSON.stringify(obj, null, 2));
}

export function listInstalled() {
  return Object.values(readInstalled());
}

// ---- registry access -------------------------------------------------------

function registryBase(opts = {}) {
  const config = loadProjectConfig();
  // Precedence: explicit arg > NIMAGENT_REGISTRY env > config > default.
  return (opts.baseUrl || process.env.NIMAGENT_REGISTRY || config.registry || DEFAULT_REGISTRY).replace(/\/+$/, "");
}

export async function fetchRegistry(baseUrl) {
  const url = baseUrl.replace(/\/+$/, "") + "/registry.json";
  let raw;
  if (/^https?:/i.test(url)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`registry fetch failed: HTTP ${res.status} (${url})`);
    raw = await res.text();
  } else {
    // local path / file:// — used by the test loop
    raw = fs.readFileSync(url.replace(/^file:\/\//, ""), "utf8");
  }
  const reg = JSON.parse(raw);
  if (!Array.isArray(reg.packages)) throw new Error("registry.json has no packages array");
  return reg;
}

export function resolvePackage(reg, name) {
  return (reg.packages || []).find((p) => p.name === name) || null;
}

export async function searchRegistry(query, opts = {}) {
  const reg = await fetchRegistry(registryBase(opts));
  const q = (query || "").toLowerCase();
  return (reg.packages || []).filter(
    (p) =>
      !q ||
      p.name.toLowerCase().includes(q) ||
      (p.description || "").toLowerCase().includes(q) ||
      (p.type || "").toLowerCase().includes(q)
  );
}

// ---- download + extract ----------------------------------------------------

async function downloadZip(url, dest) {
  if (/^https?:/i.test(url)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status} (${url})`);
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  } else {
    fs.copyFileSync(url.replace(/^file:\/\//, ""), dest);
  }
  return dest;
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// Cross-platform unzip with no dependencies. Windows uses PowerShell's
// Expand-Archive; elsewhere we try unzip, then fall back to tar (bsdtar reads
// zip). Throws if none is available.
function extractZip(zip, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (process.platform === "win32") {
    const cmd = `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`;
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`unzip failed: ${r.stderr || r.error?.message || "Expand-Archive error"}`);
    return;
  }
  let r = spawnSync("unzip", ["-o", zip, "-d", destDir], { encoding: "utf8" });
  if (!r.error && r.status === 0) return;
  r = spawnSync("tar", ["-xf", zip, "-C", destDir], { encoding: "utf8" });
  if (!r.error && r.status === 0) return;
  throw new Error("unzip failed: need `unzip` or `tar` on PATH");
}

// The zip may extract flat or under a single top-level folder. Find nimpkg.json
// at the root or one level down, and return that directory as the payload root.
function findManifestRoot(dir) {
  if (fs.existsSync(path.join(dir, "nimpkg.json"))) return dir;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && fs.existsSync(path.join(dir, e.name, "nimpkg.json"))) {
      return path.join(dir, e.name);
    }
  }
  throw new Error("nimpkg.json not found in package");
}

function readManifest(root) {
  const m = JSON.parse(fs.readFileSync(path.join(root, "nimpkg.json"), "utf8"));
  if (!m.name) throw new Error("manifest missing 'name'");
  if (!m.type) throw new Error("manifest missing 'type'");
  return m;
}

function copyDirExcept(src, dest, exclude = []) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (exclude.includes(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDirExcept(s, d, []);
    else fs.copyFileSync(s, d);
  }
}

// ---- placement per package type --------------------------------------------

function placePackage(manifest, root) {
  const config = loadProjectConfig();
  const paths = [];

  if (manifest.type === "skill") {
    const dest = path.join(INSTALL_ROOT, "skills", manifest.name);
    if (!fs.existsSync(path.join(root, "SKILL.md"))) {
      throw new Error("skill package has no SKILL.md");
    }
    copyDirExcept(root, dest, ["nimpkg.json"]);
    paths.push(`skills/${manifest.name}`);
  } else if (manifest.type === "extension") {
    if (!manifest.entry) throw new Error("extension package missing 'entry'");
    const src = path.join(root, manifest.entry);
    if (!fs.existsSync(src)) throw new Error(`entry file not found: ${manifest.entry}`);
    const destRel = `extensions/${manifest.name}.js`;
    const dest = path.join(INSTALL_ROOT, destRel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    paths.push(destRel);
    const extensions = [...new Set([...(config.extensions || []), destRel])];
    writeProjectConfig({ extensions });
  } else if (manifest.type === "mcp") {
    if (!manifest.mcp) throw new Error("mcp package missing 'mcp' block");
    const mcpServers = { ...(config.mcpServers || {}), [manifest.name]: manifest.mcp };
    writeProjectConfig({ mcpServers });
    paths.push(`mcpServers.${manifest.name}`);
  } else {
    throw new Error(`unknown package type: ${manifest.type}`);
  }

  return paths;
}

// ---- public install / uninstall --------------------------------------------

export async function installPackage(name, opts = {}) {
  const baseUrl = registryBase(opts);
  const reg = await fetchRegistry(baseUrl);
  const pkg = resolvePackage(reg, name);
  if (!pkg) throw new Error(`package "${name}" not found in registry`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nimpkg-"));
  try {
    const zipPath = path.join(tmp, `${pkg.name}.zip`);
    const url = /^https?:/i.test(pkg.url)
      ? pkg.url
      : baseUrl + "/" + String(pkg.url).replace(/^\/+/, "");
    await downloadZip(url, zipPath);

    if (pkg.sha256) {
      const got = sha256(zipPath);
      if (got !== pkg.sha256) {
        throw new Error(`sha256 mismatch for ${pkg.name}: expected ${pkg.sha256}, got ${got}`);
      }
    }

    const extractDir = path.join(tmp, "x");
    extractZip(zipPath, extractDir);
    const root = findManifestRoot(extractDir);
    const manifest = readManifest(root);
    if (manifest.name !== pkg.name) {
      throw new Error(`manifest name "${manifest.name}" != registry name "${pkg.name}"`);
    }

    const installedPaths = placePackage(manifest, root);

    const installed = readInstalled();
    installed[manifest.name] = {
      name: manifest.name,
      type: manifest.type,
      version: manifest.version || pkg.version || "0.0.0",
      description: manifest.description || pkg.description || "",
      command: manifest.command || pkg.command || "",
      source: url,
      installedPaths,
      installedAt: new Date().toISOString(),
    };
    writeInstalled(installed);

    return { manifest, installedPaths, needsRestart: manifest.type !== "skill" };
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

export function uninstallPackage(name) {
  const installed = readInstalled();
  const rec = installed[name];
  if (!rec) throw new Error(`package "${name}" is not installed`);

  for (const p of rec.installedPaths || []) {
    if (p.startsWith("mcpServers.")) {
      const key = p.slice("mcpServers.".length);
      const config = loadProjectConfig();
      const mcpServers = { ...(config.mcpServers || {}) };
      delete mcpServers[key];
      writeProjectConfig({ mcpServers });
    } else {
      try {
        fs.rmSync(path.join(INSTALL_ROOT, p), { recursive: true, force: true });
      } catch {
        /* already gone */
      }
      if (p.startsWith("extensions/")) {
        const config = loadProjectConfig();
        const extensions = (config.extensions || []).filter((x) => x !== p);
        writeProjectConfig({ extensions });
      }
    }
  }

  delete installed[name];
  writeInstalled(installed);
  return rec;
}
