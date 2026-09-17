const env = import.meta.env;

const launcherRepo = env.PUBLIC_LAUNCHER_REPO || "LIDFC/MkeiitLauncher";

export const SITE = {
  name: env.PUBLIC_SERVER_NAME || "Our Server",
  address: env.PUBLIC_MC_ADDRESS || "mc.vin-off.site",
  minecraftVersion: "1.21.11",
  serverSoftware: "Paper",
  voiceChatPort: 24454,
  launcher: {
    name: "MkeiitLauncher",
    repo: launcherRepo,
    repoUrl: `https://github.com/${launcherRepo}`,
    releasesUrl: `https://github.com/${launcherRepo}/releases`,
    latestUrl: `https://github.com/${launcherRepo}/releases/latest`,
  },
};

export const NAV = [
  { href: "/", label: "Главная" },
  { href: "/launcher", label: "Лаунчер" },
  { href: "/map", label: "Карта" },
  { href: "/stats", label: "Статистика" },
  { href: "/gallery", label: "Галерея" },
  { href: "/skins", label: "Скины" },
  { href: "/rules", label: "Правила" },
];
