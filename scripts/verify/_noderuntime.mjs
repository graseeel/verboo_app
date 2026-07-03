// src/main/services/nodeRuntime.ts
import { constants, existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join, sep } from "node:path";
var cachedNodePath;
var cachedIsElectron = false;
async function resolveNodeRuntime(candidates, electronPath, check) {
  for (const candidate of candidates) {
    if (await check(candidate)) return { path: candidate, isElectron: false };
  }
  return { path: electronPath, isElectron: true };
}
async function resolveNodeRuntimePath() {
  if (cachedNodePath) return cachedNodePath;
  const resolved = await resolveNodeRuntime(nodeRuntimeCandidates(), process.execPath, isExecutable);
  cachedNodePath = resolved.path;
  cachedIsElectron = resolved.isElectron;
  return cachedNodePath;
}
function createNodeRuntimeEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  if (cachedIsElectron) {
    env.ELECTRON_RUN_AS_NODE = "1";
  } else {
    delete env.ELECTRON_RUN_AS_NODE;
  }
  return env;
}
function resolveExternalNodePath(filePath) {
  const asarMarker = `.asar${sep}`;
  const asarIndex = filePath.indexOf(asarMarker);
  if (asarIndex === -1) return filePath;
  const unpackedPath = `${filePath.slice(0, asarIndex)}.asar.unpacked${sep}${filePath.slice(asarIndex + asarMarker.length)}`;
  return existsSync(unpackedPath) ? unpackedPath : filePath;
}
function nodeRuntimeCandidates() {
  const envCandidates = [
    process.env.VERBOO_NODE_PATH,
    process.env.npm_node_execpath,
    process.env.NODE_BINARY,
    process.env.NODE
  ];
  const pathCandidates = (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((pathDir) => join(pathDir, "node"));
  return uniquePaths([
    ...envCandidates,
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
    ...pathCandidates
  ]);
}
function uniquePaths(paths) {
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  for (const path of paths) {
    if (!path || seen.has(path)) continue;
    seen.add(path);
    result.push(path);
  }
  return result;
}
async function isExecutable(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
export {
  createNodeRuntimeEnv,
  resolveExternalNodePath,
  resolveNodeRuntime,
  resolveNodeRuntimePath
};
