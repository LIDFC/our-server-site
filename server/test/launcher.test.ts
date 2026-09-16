import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseRelease } from "../src/services/launcher.ts";

// the files of the real v1.0.0 release of LIDFC/MkeiitLauncher, including manually uploaded ones
const NAMES = [
  "PrismLauncher-ARM64-Setup.exe",
  "PrismLauncher-macOS-v1.0.0.dmg",
  "PrismLauncher-macOS-v1.0.0.zip",
  "PrismLauncher-Setup.exe",
  "PrismLauncher-v1.0.0.tar.gz",
  "PrismLauncher-Windows-MinGW-w64-Portable-v1.0.0.zip",
  "PrismLauncher-Windows-MinGW-w64-Setup-v1.0.0.exe",
  "PrismLauncher-Windows-MinGW-w64-v1.0.0.zip",
  "PrismLauncher-Windows-MSVC-62fcaf5-Release.zip",
  "PrismLauncher-Windows-MSVC-arm64-62fcaf5-Release.zip",
  "PrismLauncher-Windows-MSVC-arm64-Portable-v1.0.0.zip",
  "PrismLauncher-Windows-MSVC-arm64-Setup-v1.0.0.exe",
  "PrismLauncher-Windows-MSVC-arm64-v1.0.0.zip",
  "PrismLauncher-Windows-MSVC-Portable-v1.0.0.zip",
  "PrismLauncher-Windows-MSVC-Setup-v1.0.0.exe",
  "PrismLauncher-Windows-MSVC-v1.0.0.zip",
  "PrismLauncher.dmg",
];

function releaseJson(names: string[]) {
  return {
    tag_name: "v1.0.0",
    name: "Prism Launcher v1.0.0",
    published_at: "2026-09-15T21:17:28Z",
    html_url: "https://github.com/LIDFC/MkeiitLauncher/releases/tag/v1.0.0",
    assets: names.map((name, index) => ({
      name,
      size: 1000 + index,
      browser_download_url: `https://github.com/LIDFC/MkeiitLauncher/releases/download/v1.0.0/${name}`,
    })),
  };
}

describe("launcher release", () => {
  it("recognizes every build of the release workflow", () => {
    const release = parseRelease(releaseJson(NAMES), "LIDFC/MkeiitLauncher");
    const byId = Object.fromEntries(release.downloads.map((download) => [download.id, download.fileName]));
    assert.deepEqual(byId, {
      "windows-x64-setup": "PrismLauncher-Windows-MSVC-Setup-v1.0.0.exe",
      "windows-x64-portable": "PrismLauncher-Windows-MSVC-Portable-v1.0.0.zip",
      "windows-x64-zip": "PrismLauncher-Windows-MSVC-v1.0.0.zip",
      "windows-arm64-setup": "PrismLauncher-Windows-MSVC-arm64-Setup-v1.0.0.exe",
      "windows-arm64-portable": "PrismLauncher-Windows-MSVC-arm64-Portable-v1.0.0.zip",
      "windows-arm64-zip": "PrismLauncher-Windows-MSVC-arm64-v1.0.0.zip",
      "windows-mingw-setup": "PrismLauncher-Windows-MinGW-w64-Setup-v1.0.0.exe",
      "windows-mingw-portable": "PrismLauncher-Windows-MinGW-w64-Portable-v1.0.0.zip",
      "windows-mingw-zip": "PrismLauncher-Windows-MinGW-w64-v1.0.0.zip",
      "macos-dmg": "PrismLauncher-macOS-v1.0.0.dmg",
      "macos-zip": "PrismLauncher-macOS-v1.0.0.zip",
      source: "PrismLauncher-v1.0.0.tar.gz",
    });
    // files that do not follow the naming of the release workflow are listed separately, not guessed
    assert.deepEqual(release.otherFiles.map((file) => file.fileName).sort(), [
      "PrismLauncher-ARM64-Setup.exe",
      "PrismLauncher-Setup.exe",
      "PrismLauncher-Windows-MSVC-62fcaf5-Release.zip",
      "PrismLauncher-Windows-MSVC-arm64-62fcaf5-Release.zip",
      "PrismLauncher.dmg",
    ]);
    assert.equal(release.tag, "v1.0.0");
    assert.equal(release.available, true);
  });

  it("drops download links that do not point to GitHub", () => {
    const json = releaseJson(["PrismLauncher-Windows-MSVC-Setup-v1.0.0.exe"]);
    json.assets[0]!.browser_download_url = "https://evil.example.com/launcher.exe";
    assert.equal(parseRelease(json, "LIDFC/MkeiitLauncher").downloads.length, 0);
  });

  it("falls back to the releases page without data", () => {
    const release = parseRelease(null, "LIDFC/MkeiitLauncher");
    assert.equal(release.available, false);
    assert.equal(release.releasesUrl, "https://github.com/LIDFC/MkeiitLauncher/releases");
  });
});
