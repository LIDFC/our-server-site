import { createCachedLoader } from "../cache.ts";
import type { Config } from "../config.ts";

export type DownloadId =
  | "windows-x64-setup"
  | "windows-x64-portable"
  | "windows-x64-zip"
  | "windows-arm64-setup"
  | "windows-arm64-portable"
  | "windows-arm64-zip"
  | "windows-mingw-setup"
  | "windows-mingw-portable"
  | "windows-mingw-zip"
  | "macos-dmg"
  | "macos-zip"
  | "source";

export interface ReleaseFile {
  fileName: string;
  url: string;
  sizeBytes: number;
}

export interface LauncherRelease {
  available: boolean;
  repoUrl: string;
  releasesUrl: string;
  tag: string | null;
  name: string | null;
  publishedAt: string | null;
  htmlUrl: string | null;
  downloads: (ReleaseFile & { id: DownloadId })[];
  /** release files that match none of the known builds */
  otherFiles: ReleaseFile[];
}

// file names produced by .github/workflows/release.yml of the launcher repository
const VERSION = String.raw`v?\d[\w.]*`;
const BUILDS: { id: DownloadId; pattern: RegExp }[] = [
  { id: "windows-x64-setup", pattern: new RegExp(`^PrismLauncher-Windows-MSVC-Setup-${VERSION}\\.exe$`, "i") },
  { id: "windows-x64-portable", pattern: new RegExp(`^PrismLauncher-Windows-MSVC-Portable-${VERSION}\\.zip$`, "i") },
  { id: "windows-x64-zip", pattern: new RegExp(`^PrismLauncher-Windows-MSVC-${VERSION}\\.zip$`, "i") },
  { id: "windows-arm64-setup", pattern: new RegExp(`^PrismLauncher-Windows-MSVC-arm64-Setup-${VERSION}\\.exe$`, "i") },
  { id: "windows-arm64-portable", pattern: new RegExp(`^PrismLauncher-Windows-MSVC-arm64-Portable-${VERSION}\\.zip$`, "i") },
  { id: "windows-arm64-zip", pattern: new RegExp(`^PrismLauncher-Windows-MSVC-arm64-${VERSION}\\.zip$`, "i") },
  { id: "windows-mingw-setup", pattern: new RegExp(`^PrismLauncher-Windows-MinGW-w64-Setup-${VERSION}\\.exe$`, "i") },
  { id: "windows-mingw-portable", pattern: new RegExp(`^PrismLauncher-Windows-MinGW-w64-Portable-${VERSION}\\.zip$`, "i") },
  { id: "windows-mingw-zip", pattern: new RegExp(`^PrismLauncher-Windows-MinGW-w64-${VERSION}\\.zip$`, "i") },
  { id: "macos-dmg", pattern: new RegExp(`^PrismLauncher-macOS-${VERSION}\\.dmg$`, "i") },
  { id: "macos-zip", pattern: new RegExp(`^PrismLauncher-macOS-${VERSION}\\.zip$`, "i") },
  { id: "source", pattern: new RegExp(`^PrismLauncher-${VERSION}\\.tar\\.gz$`, "i") },
];

export function classifyAssets(assets: ReleaseFile[]): Pick<LauncherRelease, "downloads" | "otherFiles"> {
  const downloads: LauncherRelease["downloads"] = [];
  const otherFiles: ReleaseFile[] = [];
  for (const asset of assets) {
    const build = BUILDS.find((candidate) => candidate.pattern.test(asset.fileName));
    if (build && !downloads.some((download) => download.id === build.id)) {
      downloads.push({ id: build.id, ...asset });
    } else {
      otherFiles.push(asset);
    }
  }
  downloads.sort((a, b) => BUILDS.findIndex((build) => build.id === a.id) - BUILDS.findIndex((build) => build.id === b.id));
  return { downloads, otherFiles };
}

function isGitHubDownload(url: unknown): url is string {
  if (typeof url !== "string") {
    return false;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "github.com";
  } catch {
    return false;
  }
}

export function parseRelease(json: unknown, repo: string): LauncherRelease {
  const repoUrl = `https://github.com/${repo}`;
  const release = (json ?? {}) as {
    tag_name?: unknown;
    name?: unknown;
    published_at?: unknown;
    html_url?: unknown;
    assets?: unknown;
  };
  const assets: ReleaseFile[] = [];
  if (Array.isArray(release.assets)) {
    for (const entry of release.assets) {
      const asset = (entry ?? {}) as { name?: unknown; browser_download_url?: unknown; size?: unknown };
      if (typeof asset.name === "string" && isGitHubDownload(asset.browser_download_url) && typeof asset.size === "number") {
        assets.push({ fileName: asset.name, url: asset.browser_download_url, sizeBytes: asset.size });
      }
    }
  }
  return {
    available: typeof release.tag_name === "string",
    repoUrl,
    releasesUrl: `${repoUrl}/releases`,
    tag: typeof release.tag_name === "string" ? release.tag_name : null,
    name: typeof release.name === "string" ? release.name : null,
    publishedAt: typeof release.published_at === "string" ? release.published_at : null,
    htmlUrl: isGitHubDownload(release.html_url) ? release.html_url : null,
    ...classifyAssets(assets),
  };
}

export interface LauncherService {
  latest(): Promise<LauncherRelease>;
}

export function createLauncherService(config: Config): LauncherService {
  const { repo, token, cacheSeconds } = config.launcher;
  let lastGood: LauncherRelease | null = null;

  const loader = createCachedLoader(async (): Promise<LauncherRelease> => {
    try {
      const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "our-server-site",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new Error(`GitHub answered ${response.status}`);
      }
      lastGood = parseRelease(await response.json(), repo);
      return lastGood;
    } catch (error) {
      console.warn(`[launcher] Could not load the latest release: ${error}`);
      // an older answer is better than none, the links still work
      return lastGood ?? parseRelease(null, repo);
    }
  }, cacheSeconds * 1000);

  return { latest: async () => (await loader.get()).value };
}
