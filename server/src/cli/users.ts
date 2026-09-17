import { createInterface } from "node:readline";
import path from "node:path";

import { hashPassword } from "../auth/password.ts";
import { deleteSessionsForUser } from "../auth/sessions.ts";
import { checkMinecraftUsername, checkPassword, checkUsername } from "../auth/validate.ts";
import { ConfigError, loadConfig } from "../config.ts";
import { openDatabase, type Database } from "../db.ts";

const USAGE = `Account administration. Passwords are never printed or logged.

  node --env-file=.env server/src/cli/users.ts list
  node --env-file=.env server/src/cli/users.ts create <username> <minecraft-name>
  node --env-file=.env server/src/cli/users.ts set-password <username>
  node --env-file=.env server/src/cli/users.ts set-nick <username> <minecraft-name>
  node --env-file=.env server/src/cli/users.ts logout-all <username>
  node --env-file=.env server/src/cli/users.ts delete <username>`;

/** Reads a password without echoing it to the terminal. */
function askSecret(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    process.stdout.write(prompt);
    // readline has no official way to hide input, muting its own echo is the usual one
    (rl as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = () => {};
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function askNewPassword(username: string): Promise<string> {
  const password = await askSecret("New password: ");
  const checked = checkPassword(password, username);
  if (!checked.ok) {
    throw new Error(checked.message);
  }
  if ((await askSecret("Repeat password: ")) !== password) {
    throw new Error("The two passwords do not match");
  }
  return checked.value;
}

function findUser(db: Database, username: string): { id: number; username: string } {
  const row = db.prepare("SELECT id, username FROM users WHERE username_lower = ?").get(username.trim().toLowerCase());
  if (!row) {
    throw new Error(`There is no account named ${username}`);
  }
  return { id: Number(row["id"]), username: String(row["username"]) };
}

function requireArgument(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

async function run(db: Database, argv: string[]): Promise<void> {
  const command = argv[0];
  switch (command) {
    case "list": {
      const rows = db.prepare("SELECT id, username, minecraft_username, created_at FROM users ORDER BY id").all();
      if (rows.length === 0) {
        console.info("No accounts yet.");
        return;
      }
      for (const row of rows) {
        const sessions = db.prepare("SELECT COUNT(*) AS open FROM sessions WHERE user_id = ?").get(row["id"] as number);
        console.info(
          `#${String(row["id"])}  ${String(row["username"])}  nick=${String(row["minecraft_username"])}  ` +
            `created=${String(row["created_at"]).slice(0, 10)}  sessions=${String(sessions?.["open"] ?? 0)}`,
        );
      }
      return;
    }

    case "create": {
      const username = checkUsername(requireArgument(argv[1], "username"));
      if (!username.ok) {
        throw new Error(username.message);
      }
      const nick = checkMinecraftUsername(requireArgument(argv[2], "minecraft name"));
      if (!nick.ok) {
        throw new Error(nick.message);
      }
      const password = await askNewPassword(username.value);
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO users (username, username_lower, password_hash, minecraft_username, minecraft_username_lower, created_at, updated_at)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(username.value, username.value.toLowerCase(), await hashPassword(password), nick.value, nick.value.toLowerCase(), now, now);
      console.info(`Created ${username.value} with Minecraft name ${nick.value}.`);
      return;
    }

    case "set-password": {
      const user = findUser(db, requireArgument(argv[1], "username"));
      const password = await askNewPassword(user.username);
      db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(await hashPassword(password), new Date().toISOString(), user.id);
      deleteSessionsForUser(db, user.id);
      console.info(`Password of ${user.username} changed, all sessions closed.`);
      return;
    }

    case "set-nick": {
      const user = findUser(db, requireArgument(argv[1], "username"));
      const nick = checkMinecraftUsername(requireArgument(argv[2], "minecraft name"));
      if (!nick.ok) {
        throw new Error(nick.message);
      }
      db.prepare("UPDATE users SET minecraft_username = ?, minecraft_username_lower = ?, updated_at = ? WHERE id = ?").run(
        nick.value,
        nick.value.toLowerCase(),
        new Date().toISOString(),
        user.id,
      );
      console.info(`${user.username} now plays as ${nick.value}.`);
      return;
    }

    case "logout-all": {
      const user = findUser(db, requireArgument(argv[1], "username"));
      deleteSessionsForUser(db, user.id);
      console.info(`All sessions of ${user.username} closed.`);
      return;
    }

    case "delete": {
      const user = findUser(db, requireArgument(argv[1], "username"));
      const answer = await new Promise<string>((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.question(`Delete ${user.username} and everything it owns? Type the username to confirm: `, (value) => {
          rl.close();
          resolve(value);
        });
      });
      if (answer.trim().toLowerCase() !== user.username.toLowerCase()) {
        console.info("Nothing was deleted.");
        return;
      }
      db.prepare("DELETE FROM users WHERE id = ?").run(user.id);
      console.info(`${user.username} deleted.`);
      return;
    }

    default:
      console.info(USAGE);
      process.exitCode = command ? 1 : 0;
  }
}

let db: Database | null = null;
try {
  const config = loadConfig();
  db = openDatabase(path.join(config.dataDir, "site.db"));
  await run(db, process.argv.slice(2));
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  db?.close();
}
