import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";


const CWD = process.cwd();

/** Make a throwaway project dir with the given files; auto-cleaned by the test. */
function makeProject(files) {
  const dir = mkdtempSync(join(tmpdir(), "harness-test-"));
  for (const [rel, content] of Object.entries(files ?? {})) {
    const p = join(dir, rel);
    mkdirSync(join(dir, rel.split("/").slice(0, -1).join("/")), { recursive: true });
    writeFileSync(p, content, "utf8");
  }
  return dir;
}

function rmProject(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/** All probes "installed" so no real runtimes spawn during detectVerify tests. */
const ALL_PROBES = (val = true) =>
  Object.fromEntries(["python", "python3", "pytest", "go", "cargo", "mvn", "gradle", "dotnet", "ruby", "bundle", "php"].map((k) => [k, val]));
export { CWD, makeProject, rmProject, ALL_PROBES };
