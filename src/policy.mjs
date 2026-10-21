import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

/** Resolves symlinks and 8.3 short names on the nearest existing ancestor, so a path that does not exist yet compares correctly. */
const realPath = (full) => {
  try {
    return realpathSync.native(full);
  } catch {
    const parent = dirname(full);
    return parent === full ? full : join(realPath(parent), basename(full));
  }
};

const normalize = (path) => {
  const full = realPath(resolve(path));
  return process.platform === "win32" ? full.toLowerCase() : full;
};

/** Which directories a client may work in. A path is allowed when it is a listed root or lies inside one. */
export function makePolicy(allowedDirs) {
  const roots = allowedDirs.map(normalize);
  const allowed = (dir) => {
    if (typeof dir !== "string" || !isAbsolute(dir)) return false;
    const candidate = normalize(dir);
    return roots.some((root) => candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep));
  };
  return {
    roots,
    allowed,
    assert(dir) {
      if (roots.length === 0) throw new Error("No project directory is authorized yet. Run `opencode-mcp setup --allow <directory>`.");
      if (!allowed(dir)) throw new Error(`The directory is not authorized for this server: ${dir}`);
    },
  };
}
