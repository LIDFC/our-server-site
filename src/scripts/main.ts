import { initAuthForms, initAuthNav, initProfilePage } from "./auth";
import { initOnlineCharts } from "./chart";
import { initCopyButtons } from "./copy";
import { initGallery } from "./gallery";
import { initLauncherDownloads } from "./launcher";
import { initMap } from "./map";
import { initLeaderboardPreview, initStatsPage } from "./stats";
import { initStatusPanels } from "./status";

// every module only acts on the elements of its own page
initAuthNav();
initAuthForms();
initProfilePage();
initCopyButtons();
initStatusPanels();
initOnlineCharts();
void initLauncherDownloads();
void initLeaderboardPreview();
void initStatsPage();
void initGallery();
void initMap();

// close the mobile menu after choosing a page section on the same page
for (const link of document.querySelectorAll<HTMLAnchorElement>(".mobile-nav a")) {
  link.addEventListener("click", () => link.closest("details")?.removeAttribute("open"));
}
