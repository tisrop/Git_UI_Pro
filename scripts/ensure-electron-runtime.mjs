import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRootDir = path.resolve(path.dirname(scriptPath), "..");

export function electronRuntimePaths(options = {}) {
  const rootDir = options.rootDir ?? defaultRootDir;
  const platform = options.platform ?? process.platform;
  const packageDir = path.join(rootDir, "node_modules", "electron");
  const executableRelativePath = platform === "win32"
    ? "electron.exe"
    : platform === "darwin"
      ? path.join("Electron.app", "Contents", "MacOS", "Electron")
      : "electron";
  return {
    packageDir,
    packageJson: path.join(packageDir, "package.json"),
    installScript: path.join(packageDir, "install.js"),
    pathFile: path.join(packageDir, "path.txt"),
    versionFile: path.join(packageDir, "dist", "version"),
    executable: path.join(packageDir, "dist", executableRelativePath),
    executableRelativePath
  };
}

export function isElectronRuntimeReady(options = {}) {
  const fileExists = options.fileExists ?? existsSync;
  const readText = options.readText ?? ((filePath) => readFileSync(filePath, "utf8"));
  const paths = electronRuntimePaths(options);
  if (!fileExists(paths.packageJson) || !fileExists(paths.pathFile) || !fileExists(paths.versionFile) || !fileExists(paths.executable)) {
    return false;
  }
  try {
    const packageVersion = JSON.parse(readText(paths.packageJson)).version;
    const runtimeVersion = readText(paths.versionFile).trim().replace(/^v/u, "");
    return packageVersion === runtimeVersion &&
      readText(paths.pathFile).trim() === paths.executableRelativePath.replaceAll(path.sep, "/");
  } catch {
    return false;
  }
}

export async function ensureElectronRuntime(options = {}) {
  if (isElectronRuntimeReady(options)) {
    options.onLog?.("Electron runtime 已就绪");
    return { repaired: false };
  }

  const fileExists = options.fileExists ?? existsSync;
  const paths = electronRuntimePaths(options);
  if (!fileExists(paths.installScript)) {
    throw new Error("Electron npm 包不完整，缺少 node_modules/electron/install.js，请先执行 npm install。");
  }

  options.onLog?.("检测到 Electron runtime 缺失，正在自动恢复");
  const runInstaller = options.runInstaller ?? defaultRunInstaller;
  await runInstaller(paths.installScript, options);
  if (!isElectronRuntimeReady(options)) {
    throw new Error("Electron 安装脚本已结束，但 node_modules/electron/dist 仍不完整，请删除 node_modules/electron 后重新执行 npm install。");
  }
  options.onLog?.("Electron runtime 已恢复");
  return { repaired: true };
}

function defaultRunInstaller(installScript, options) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    const registry = env.npm_config_registry ?? "";
    if (!env.ELECTRON_MIRROR && /(?:^|\.)npmmirror\.com\/?$/iu.test(new URL(registry || "https://registry.npmjs.org").hostname)) {
      env.ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/";
    }
    const child = spawn(process.execPath, [installScript], {
      cwd: options.rootDir ?? defaultRootDir,
      env,
      stdio: "inherit",
      shell: false,
      windowsHide: true
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Electron runtime 安装失败（退出码 ${code ?? 1}）。`));
      }
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await ensureElectronRuntime({ onLog: (message) => console.log(`[electron-runtime] ${message}`) }).catch((error) => {
    console.error(`[electron-runtime] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
