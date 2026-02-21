import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import https from "node:https";

const TOOLCHAIN_URL =
  process.env.SVAI_TOOLCHAIN_WIN_X64_URL ||
  "https://github.com/ElioKarkar1/svAi/releases/download/toolchain-win-x64-v0.1.0/toolchain-win-x64.zip";

const TOOLCHAIN_SHA256 =
  (process.env.SVAI_TOOLCHAIN_WIN_X64_SHA256 ||
    "E8435F41285D5B1922240193278AB241F5D95A0BF75C3F6BFF2153BD226D25E9").toLowerCase();

const repoRoot = process.cwd();
const cacheDir = path.join(repoRoot, ".cache");
const zipPath = path.join(cacheDir, "toolchain-win-x64.zip");
const extractDir = path.join(repoRoot, "src-tauri", "resources", "toolchain", "win-x64");

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

function sha256File(p) {
  const h = crypto.createHash("sha256");
  const buf = fs.readFileSync(p);
  h.update(buf);
  return h.digest("hex");
}

function download(url, outFile) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "svAi-toolchain-fetch" } }, (res) => {
      // follow redirects
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(download(res.headers.location, outFile));
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`download failed: HTTP ${res.statusCode}`));
        res.resume();
        return;
      }

      const f = fs.createWriteStream(outFile);
      res.pipe(f);
      f.on("finish", () => f.close(resolve));
      f.on("error", reject);
    });
    req.on("error", reject);
  });
}

async function main() {
  if (process.platform !== "win32") {
    console.log("fetch-toolchain: skipping (not Windows)");
    return;
  }

  mkdirp(cacheDir);

  console.log(`fetch-toolchain: downloading ${TOOLCHAIN_URL}`);
  await download(TOOLCHAIN_URL, zipPath);

  const got = sha256File(zipPath);
  if (got !== TOOLCHAIN_SHA256) {
    throw new Error(`toolchain sha256 mismatch\nexpected: ${TOOLCHAIN_SHA256}\n     got: ${got}`);
  }

  console.log(`fetch-toolchain: sha256 OK (${got})`);

  // Extract using PowerShell Expand-Archive (Windows built-in)
  // Zip root must contain: msys/ and ucrt64/
  const tmp = path.join(cacheDir, "toolchain-extract");
  rmrf(tmp);
  mkdirp(tmp);

  const ps = [
    "powershell",
    "-NoProfile",
    "-Command",
    [
      `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${tmp.replace(/'/g, "''")}' -Force;`,
      "$root = Get-ChildItem -Path '" + tmp.replace(/'/g, "''") + "' | Select-Object -First 1;", // should contain msys/ ucrt64/
      "if (!(Test-Path (Join-Path $root.FullName 'msys')) -or !(Test-Path (Join-Path $root.FullName 'ucrt64'))) { throw 'zip root must contain msys/ and ucrt64/'; }",
    ].join(" "),
  ];

  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(ps[0], ps.slice(1), { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`Expand-Archive failed (${r.status})`);

  // Find extracted root directory (some zips extract files directly into tmp)
  const entries = fs.readdirSync(tmp);
  let srcRoot = tmp;
  if (!(fs.existsSync(path.join(tmp, "msys")) && fs.existsSync(path.join(tmp, "ucrt64")))) {
    if (entries.length !== 1) throw new Error("unexpected zip layout (expected msys/ and ucrt64/)");
    srcRoot = path.join(tmp, entries[0]);
  }

  if (!(fs.existsSync(path.join(srcRoot, "msys")) && fs.existsSync(path.join(srcRoot, "ucrt64")))) {
    throw new Error("zip layout invalid: missing msys/ or ucrt64/");
  }

  console.log(`fetch-toolchain: installing into ${extractDir}`);
  rmrf(extractDir);
  mkdirp(extractDir);

  // Copy msys + ucrt64 dirs
  fs.cpSync(path.join(srcRoot, "msys"), path.join(extractDir, "msys"), { recursive: true });
  fs.cpSync(path.join(srcRoot, "ucrt64"), path.join(extractDir, "ucrt64"), { recursive: true });

  console.log("fetch-toolchain: done");
}

main().catch((e) => {
  console.error(String(e?.stack || e));
  process.exit(1);
});
