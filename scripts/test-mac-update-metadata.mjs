import assert from "node:assert/strict";
import test from "node:test";
import { mergeMacUpdateMetadata } from "./merge-mac-update-metadata.mjs";

const SHA512 = Buffer.alloc(64, 1).toString("base64");

function metadata(architecture, overrides = {}) {
  const version = overrides.version ?? "0.2.0";
  return {
    version,
    files: overrides.files ?? [
      { url: `Git-UI-Pro-${version}-mac-${architecture}.zip`, sha512: SHA512, size: 100 },
      { url: `Git-UI-Pro-${version}-mac-${architecture}.dmg`, sha512: SHA512, size: 120 }
    ],
    path: `Git-UI-Pro-${version}-mac-${architecture}.zip`,
    sha512: SHA512,
    releaseDate: overrides.releaseDate ?? "2026-08-23T12:00:00.000Z"
  };
}

test("合并 x64 与 arm64 macOS 更新元数据", () => {
  const merged = mergeMacUpdateMetadata([
    metadata("x64"),
    metadata("arm64", { releaseDate: "2026-08-23T12:01:00.000Z" })
  ]);

  assert.equal(merged.version, "0.2.0");
  assert.deepEqual(merged.files.map((file) => file.url), [
    "Git-UI-Pro-0.2.0-mac-x64.zip",
    "Git-UI-Pro-0.2.0-mac-x64.dmg",
    "Git-UI-Pro-0.2.0-mac-arm64.zip",
    "Git-UI-Pro-0.2.0-mac-arm64.dmg"
  ]);
  assert.equal(merged.path, "Git-UI-Pro-0.2.0-mac-x64.zip");
  assert.equal(merged.releaseDate, "2026-08-23T12:01:00.000Z");
});

test("拒绝版本不一致、架构重复或缺少 ZIP 的元数据", () => {
  assert.throws(
    () => mergeMacUpdateMetadata([metadata("x64"), metadata("arm64", { version: "0.2.1" })]),
    /版本不一致/
  );
  assert.throws(
    () => mergeMacUpdateMetadata([metadata("x64"), metadata("x64")]),
    /缺少 macOS arm64/
  );
  assert.throws(
    () => mergeMacUpdateMetadata([
      metadata("x64"),
      metadata("arm64", {
        files: [
          { url: "Git-UI-Pro-0.2.0-mac-arm64.dmg", sha512: SHA512, size: 120 },
          { url: "Git-UI-Pro-0.2.0-mac-arm64.dmg", sha512: SHA512, size: 120 }
        ]
      })
    ]),
    /同时包含 DMG 和 ZIP/
  );
});
