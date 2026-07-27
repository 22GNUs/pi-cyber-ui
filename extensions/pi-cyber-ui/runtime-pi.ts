import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const PI_INDEX_MODULE = join("dist", "index.js");

/** Locate the package root of the Pi process that loaded this extension. */
export function findRunningPiRoot(requiredPath = PI_INDEX_MODULE): string | undefined {
  const entry = process.argv[1];
  if (!entry || !existsSync(entry)) return undefined;

  try {
    let dir = dirname(realpathSync(entry));
    while (true) {
      if (existsSync(join(dir, "package.json")) && existsSync(join(dir, requiredPath))) {
        return dir;
      }
      const parent = dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  } catch {
    return undefined;
  }
}

/** Import a module from the exact Pi package instance running this process. */
export async function importRunningPiModule(
  modulePath = PI_INDEX_MODULE,
): Promise<Record<string, unknown> | undefined> {
  const root = findRunningPiRoot(modulePath);
  if (!root) return undefined;

  try {
    return (await import(pathToFileURL(join(root, modulePath)).href)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
