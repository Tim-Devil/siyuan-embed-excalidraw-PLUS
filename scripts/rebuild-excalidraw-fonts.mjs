import { createHash } from "node:crypto";
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = join(root, "vendor", "excalidraw");
const patchesDir = join(vendorDir, "patches");
const artifactName = "excalidraw-0.18.0-local-fonts.1.tgz";
const artifactPath = join(vendorDir, artifactName);

const run = (command, args, cwd) => {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: false,
  });

  if (result.status !== 0) {
    const detail = result.error ? `: ${result.error.message}` : "";
    throw new Error(`${command} exited with status ${result.status}${detail}`);
  }
};

const runShell = (command, cwd) => {
  const result = spawnSync(command, {
    cwd,
    stdio: "inherit",
    shell: true,
  });

  if (result.status !== 0) {
    const detail = result.error ? `: ${result.error.message}` : "";
    throw new Error(`command exited with status ${result.status}${detail}`);
  }
};

const workDir = await mkdtemp(join(tmpdir(), "qyl-excalidraw-"));
const sourceDir = join(workDir, "excalidraw");
const packDir = join(workDir, "package");

try {
  run(
    "git",
    [
      "clone",
      "--depth",
      "1",
      "--branch",
      "v0.18.0",
      "https://github.com/excalidraw/excalidraw.git",
      sourceDir,
    ],
    workDir,
  );

  const patches = (await readdir(patchesDir))
    .filter((name) => name.endsWith(".patch"))
    .sort();

  for (const patch of patches) {
    run("git", ["am", join(patchesDir, patch)], sourceDir);
  }

  runShell(
    'npx --yes --package node@22.22.0 --package yarn@1.22.22 --call "yarn install --frozen-lockfile"',
    sourceDir,
  );
  runShell(
    'npx --yes --package node@22.22.0 --package yarn@1.22.22 --call "yarn build:package"',
    sourceDir,
  );

  await mkdir(packDir, { recursive: true });
  runShell(
    `npm pack . --pack-destination "${packDir}"`,
    join(sourceDir, "packages", "excalidraw"),
  );

  const packedName = (await readdir(packDir)).find((name) =>
    name.endsWith(".tgz"),
  );
  if (!packedName) {
    throw new Error("npm pack did not produce an archive");
  }

  await copyFile(join(packDir, packedName), artifactPath);
  const digest = createHash("sha256")
    .update(await readFile(artifactPath))
    .digest("hex");
  await writeFile(
    join(vendorDir, "SHA256SUMS"),
    `${digest}  ${basename(artifactPath)}\n`,
  );

  console.log(`Built ${artifactPath}`);
  console.log(`SHA256 ${digest}`);
} finally {
  await rm(workDir, { recursive: true, force: true });
}
