// Starts the API server (with restart on changes) and the Astro dev server together.
import { spawn } from "node:child_process";

const processes = [
  spawn(process.execPath, ["--watch", "--env-file-if-exists=.env", "server/src/index.ts"], { stdio: "inherit" }),
  spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["astro", "dev"], { stdio: "inherit", shell: process.platform === "win32" }),
];

const stop = () => {
  for (const child of processes) {
    child.kill();
  }
  process.exit(0);
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const child of processes) {
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(`A dev process exited with code ${code}, stopping.`);
      stop();
    }
  });
}
