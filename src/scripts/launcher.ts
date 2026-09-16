import { getJson, type DownloadId, type LauncherRelease } from "./api";
import { formatDate, formatSize } from "./format";

type Platform = "windows-x64" | "windows-arm64" | "macos" | "linux" | "mobile" | "unknown";

interface NavigatorUAData {
  platform: string;
  mobile: boolean;
  getHighEntropyValues(hints: string[]): Promise<{ architecture?: string }>;
}

async function detectPlatform(): Promise<Platform> {
  const uaData = (navigator as Navigator & { userAgentData?: NavigatorUAData }).userAgentData;
  const ua = navigator.userAgent;
  if (uaData?.mobile || /Android|iPhone|iPad|iPod/i.test(ua)) {
    return "mobile";
  }
  if (uaData?.platform === "Windows" || /Windows/i.test(ua)) {
    try {
      const { architecture } = (await uaData?.getHighEntropyValues(["architecture"])) ?? {};
      return architecture === "arm" ? "windows-arm64" : "windows-x64";
    } catch {
      return "windows-x64";
    }
  }
  if (uaData?.platform === "macOS" || /Mac OS X|Macintosh/i.test(ua)) {
    return "macos";
  }
  if (/Linux|X11/i.test(ua)) {
    return "linux";
  }
  return "unknown";
}

const RECOMMENDED: Partial<Record<Platform, { id: DownloadId; label: string; detail: string }>> = {
  "windows-x64": { id: "windows-x64-setup", label: "Скачать для Windows", detail: "Установщик" },
  "windows-arm64": { id: "windows-arm64-setup", label: "Скачать для Windows ARM", detail: "Установщик" },
  macos: { id: "macos-dmg", label: "Скачать для macOS", detail: "Образ .dmg" },
};

function fillPrimaryButtons(release: LauncherRelease, platform: Platform): void {
  for (const link of document.querySelectorAll<HTMLAnchorElement>("[data-download-primary]")) {
    const label = link.querySelector<HTMLElement>("[data-download-label]");
    const detail = link.parentElement?.querySelector<HTMLElement>("[data-download-detail]");
    const recommended = RECOMMENDED[platform];
    const download = recommended ? release.downloads.find((item) => item.id === recommended.id) : undefined;

    if (recommended && download) {
      link.href = download.url;
      if (label) {
        label.textContent = recommended.label;
      }
      if (detail) {
        detail.textContent = `${recommended.detail}, ${release.tag ?? ""}, ${formatSize(download.sizeBytes)}`;
      }
    } else if (platform === "linux" && detail) {
      detail.textContent = "Готовой сборки для Linux нет — ниже ссылка на все файлы релиза.";
    } else if (platform === "mobile" && detail) {
      detail.textContent = "Лаунчер работает на компьютере: Windows или macOS.";
    }
  }
}

function fillBuildCards(release: LauncherRelease): void {
  for (const card of document.querySelectorAll<HTMLElement>("[data-build]")) {
    const ids = (card.dataset.build ?? "").split(" ") as DownloadId[];
    for (const link of card.querySelectorAll<HTMLAnchorElement>("[data-build-file]")) {
      const download = release.downloads.find((item) => item.id === link.dataset.buildFile);
      const size = link.querySelector<HTMLElement>("[data-build-size]");
      if (download) {
        link.href = download.url;
        link.removeAttribute("aria-disabled");
        link.title = download.fileName;
        if (size) {
          size.textContent = formatSize(download.sizeBytes);
        }
      } else {
        link.removeAttribute("href");
        link.setAttribute("aria-disabled", "true");
        if (size) {
          size.textContent = "нет в релизе";
        }
      }
    }
    card.dataset.empty = String(!ids.some((id) => release.downloads.some((item) => item.id === id)));
  }

  const others = document.querySelector<HTMLElement>("[data-other-files]");
  const othersList = others?.querySelector<HTMLElement>("ul");
  if (others && othersList) {
    othersList.replaceChildren(
      ...release.otherFiles.map((file) => {
        const item = document.createElement("li");
        const link = document.createElement("a");
        link.className = "text-link";
        link.href = file.url;
        link.textContent = file.fileName;
        const size = document.createElement("span");
        size.className = "muted";
        size.textContent = ` ${formatSize(file.sizeBytes)}`;
        item.append(link, size);
        return item;
      }),
    );
    others.hidden = release.otherFiles.length === 0;
  }
}

function fillReleaseInfo(release: LauncherRelease): void {
  for (const element of document.querySelectorAll<HTMLElement>("[data-release-version]")) {
    element.textContent = release.tag ?? "—";
  }
  for (const element of document.querySelectorAll<HTMLElement>("[data-release-date]")) {
    element.textContent = release.publishedAt ? formatDate(release.publishedAt) : "—";
  }
  for (const link of document.querySelectorAll<HTMLAnchorElement>("[data-release-link]")) {
    link.href = release.htmlUrl ?? release.releasesUrl;
  }
  showReleaseState("ready");
}

/** Toggles the elements marked with data-release-show="ready" / "missing". */
function showReleaseState(state: "ready" | "missing"): void {
  for (const element of document.querySelectorAll<HTMLElement>("[data-release-show]")) {
    element.hidden = element.dataset.releaseShow !== state;
  }
}

export async function initLauncherDownloads(): Promise<void> {
  const needsRelease = document.querySelector("[data-download-primary], [data-build], [data-release-version]");
  if (!needsRelease) {
    return;
  }
  const [release, platform] = await Promise.all([getJson<LauncherRelease>("/api/launcher/release").catch(() => null), detectPlatform()]);
  if (!release || !release.available) {
    // links keep pointing to the GitHub releases page, which always works
    showReleaseState("missing");
    return;
  }
  fillReleaseInfo(release);
  fillPrimaryButtons(release, platform);
  fillBuildCards(release);
  for (const card of document.querySelectorAll<HTMLElement>("[data-platform]")) {
    card.classList.toggle("is-recommended", platform.startsWith(card.dataset.platform ?? "-"));
  }
}
