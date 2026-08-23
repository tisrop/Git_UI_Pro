import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import yaml from "js-yaml";

const ARCHITECTURES = ["x64", "arm64"];

export function mergeMacUpdateMetadata(documents) {
  if (!Array.isArray(documents) || documents.length !== ARCHITECTURES.length) {
    throw new Error("必须提供 x64 和 arm64 两份 macOS 更新元数据。");
  }

  const parsed = documents.map((document) => parseDocument(document));
  const versions = new Set(parsed.map((document) => document.version));
  if (versions.size !== 1) {
    throw new Error("macOS 更新元数据版本不一致。");
  }

  const byArchitecture = new Map(parsed.map((document) => [document.architecture, document]));
  for (const architecture of ARCHITECTURES) {
    if (!byArchitecture.has(architecture)) {
      throw new Error(`缺少 macOS ${architecture} 更新元数据。`);
    }
  }

  const ordered = ARCHITECTURES.map((architecture) => byArchitecture.get(architecture));
  const x64Zip = ordered[0].files.find((file) => file.url.endsWith(".zip"));
  const releaseDate = ordered
    .map((document) => document.releaseDate)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];

  return {
    version: ordered[0].version,
    files: ordered.flatMap((document) => document.files),
    path: x64Zip.url,
    sha512: x64Zip.sha512,
    releaseDate
  };
}

export async function mergeMacUpdateMetadataFiles(x64Path, arm64Path, outputPath) {
  const inputs = await Promise.all([x64Path, arm64Path].map(async (filePath) => yaml.load(await readFile(filePath, "utf8"))));
  const merged = mergeMacUpdateMetadata(inputs);
  await writeFile(outputPath, yaml.dump(merged, { lineWidth: -1, noRefs: true }), "utf8");
}

function parseDocument(value) {
  if (!isRecord(value) || typeof value.version !== "string" || !/^\d+\.\d+\.\d+$/.test(value.version)) {
    throw new Error("macOS 更新元数据版本无效。");
  }
  if (!Array.isArray(value.files) || value.files.length !== 2) {
    throw new Error(`macOS v${value.version} 更新元数据必须包含 DMG 和 ZIP。`);
  }
  if (typeof value.releaseDate !== "string" || !Number.isFinite(Date.parse(value.releaseDate))) {
    throw new Error(`macOS v${value.version} 更新元数据发布时间无效。`);
  }

  const files = value.files.map((file) => parseFile(file, value.version));
  const architectures = new Set(files.map((file) => file.architecture));
  if (architectures.size !== 1) {
    throw new Error(`macOS v${value.version} 单架构元数据混入了多个架构。`);
  }
  const extensions = new Set(files.map((file) => path.extname(file.url)));
  if (!extensions.has(".dmg") || !extensions.has(".zip")) {
    throw new Error(`macOS v${value.version} 更新元数据必须同时包含 DMG 和 ZIP。`);
  }

  return {
    version: value.version,
    architecture: files[0].architecture,
    files: files.map(({ architecture: _architecture, ...file }) => file),
    releaseDate: new Date(value.releaseDate).toISOString()
  };
}

function parseFile(value, version) {
  if (!isRecord(value) || typeof value.url !== "string") {
    throw new Error(`macOS v${version} 更新文件无效。`);
  }
  const match = new RegExp(`^Git-UI-Pro-${escapeRegExp(version)}-mac-(x64|arm64)\\.(dmg|zip)$`).exec(value.url);
  const sha512IsValid = typeof value.sha512 === "string" &&
    /^[A-Za-z\d+/]+={0,2}$/.test(value.sha512) &&
    Buffer.from(value.sha512, "base64").byteLength === 64;
  if (
    !match ||
    !sha512IsValid ||
    typeof value.size !== "number" ||
    !Number.isSafeInteger(value.size) ||
    value.size <= 0
  ) {
    throw new Error(`macOS v${version} 更新文件名称或摘要无效。`);
  }
  return { url: value.url, sha512: value.sha512, size: value.size, architecture: match[1] };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  const [, , x64Path, arm64Path, outputPath] = process.argv;
  if (!x64Path || !arm64Path || !outputPath) {
    throw new Error("用法: node scripts/merge-mac-update-metadata.mjs <x64.yml> <arm64.yml> <output.yml>");
  }
  await mergeMacUpdateMetadataFiles(x64Path, arm64Path, outputPath);
}
