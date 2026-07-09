import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const INSTALL_ROOT = path.resolve(__dirname, "..");

function bundledExe(name) {
  const ext = process.platform === "win32" ? ".exe" : "";
  return path.join(INSTALL_ROOT, "vendor", `${name}${ext}`);
}

export function rgPath() {
  const bundled = bundledExe("rg");
  if (fs.existsSync(bundled)) return bundled;
  return process.platform === "win32" ? "rg.exe" : "rg";
}

export function fdPath() {
  const bundled = bundledExe("fd");
  if (fs.existsSync(bundled)) return bundled;
  return process.platform === "win32" ? "fd.exe" : "fd";
}

export function jqPath() {
  const bundled = bundledExe("jq");
  if (fs.existsSync(bundled)) return bundled;
  return process.platform === "win32" ? "jq.exe" : "jq";
}
