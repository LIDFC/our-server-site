import { getCurrentUser, postJson, type AuthUser } from "./api";
import { formatDate } from "./format";
import { handleForm, messageFor, messageText, setMessage } from "./forms";

/** Only local paths are followed after signing in, so a link cannot send anyone to another site. */
function safeNext(): string {
  const next = new URLSearchParams(location.search).get("next") ?? "";
  return next.startsWith("/") && !next.startsWith("//") ? next : "/profile";
}

function show(element: Element | null, visible: boolean): void {
  if (element instanceof HTMLElement) {
    element.hidden = !visible;
  }
}

let userRequest: Promise<AuthUser | null> | null = null;

/** The signed in account, asked for once per page. */
export function currentUser(): Promise<AuthUser | null> {
  userRequest ??= getCurrentUser();
  return userRequest;
}

export function rememberUser(user: AuthUser): void {
  userRequest = Promise.resolve(user);
  for (const name of document.querySelectorAll("[data-account-name]")) {
    name.textContent = user.minecraftUsername;
  }
}

/** Sends a page that needs an account to the sign in page, keeping the way back. */
export function requireAccount(page: HTMLElement): Promise<AuthUser | null> {
  return currentUser().then(
    (user) => {
      if (!user) {
        location.replace(`/login?next=${encodeURIComponent(location.pathname)}`);
        return null;
      }
      return user;
    },
    () => {
      page.dataset.state = "error";
      return null;
    },
  );
}

function renderAccount(user: AuthUser | null): void {
  for (const block of document.querySelectorAll<HTMLElement>("[data-account]")) {
    for (const name of block.querySelectorAll("[data-account-name]")) {
      name.textContent = user?.minecraftUsername ?? "";
    }
    show(block.querySelector("[data-account-signin]"), user === null);
    show(block.querySelector("[data-account-user]"), user !== null);
    block.hidden = false;
  }
}

async function signOut(): Promise<void> {
  await postJson("/api/auth/logout", {});
  location.href = "/";
}

/** Account entry point in the site header: "Войти", or the player name with the profile and sign out. */
export function initAuthNav(): void {
  const blocks = document.querySelectorAll("[data-account]");
  if (blocks.length === 0) {
    return;
  }
  for (const button of document.querySelectorAll("[data-logout]")) {
    button.addEventListener("click", () => void signOut());
  }
  // a click anywhere else closes the account menu
  document.addEventListener("click", (event) => {
    for (const menu of document.querySelectorAll<HTMLDetailsElement>(".site-account__menu[open]")) {
      if (event.target instanceof Node && !menu.contains(event.target)) {
        menu.open = false;
      }
    }
  });
  void currentUser().then(
    (user) => renderAccount(user),
    // the site API is unreachable: offer signing in rather than a broken menu
    () => renderAccount(null),
  );
}

export function initAuthForms(): void {
  const signIn = document.querySelector("[data-form=login]");
  if (signIn instanceof HTMLFormElement) {
    handleForm(signIn, async (fields) => {
      const result = await postJson<{ user: AuthUser }>("/api/auth/login", { username: fields.username, password: fields.password });
      if (!result.ok) {
        return messageFor(result.error);
      }
      location.href = safeNext();
      return null;
    });
  }

  const signUp = document.querySelector("[data-form=register]");
  if (signUp instanceof HTMLFormElement) {
    handleForm(signUp, async (fields) => {
      if (fields.password !== fields.passwordConfirm) {
        return messageText("password-mismatch");
      }
      const result = await postJson<{ user: AuthUser }>("/api/auth/register", {
        username: fields.username,
        password: fields.password,
        passwordConfirm: fields.passwordConfirm,
        minecraftUsername: fields.minecraftUsername,
        inviteCode: fields.inviteCode,
      });
      if (!result.ok) {
        return messageFor(result.error);
      }
      location.href = "/profile";
      return null;
    });
  }
}

export function initProfilePage(): void {
  const page = document.querySelector("[data-profile]");
  if (!(page instanceof HTMLElement)) {
    return;
  }

  const fill = (user: AuthUser): void => {
    for (const element of page.querySelectorAll("[data-profile-username]")) {
      element.textContent = user.username;
    }
    for (const element of page.querySelectorAll("[data-profile-nick]")) {
      element.textContent = user.minecraftUsername;
    }
    for (const element of page.querySelectorAll("[data-profile-created]")) {
      element.textContent = formatDate(user.createdAt);
    }
    const nickInput = page.querySelector("input[name=minecraftUsername]");
    if (nickInput instanceof HTMLInputElement) {
      nickInput.value = user.minecraftUsername;
    }
    rememberUser(user);
  };

  void requireAccount(page).then((user) => {
    if (user) {
      fill(user);
      page.dataset.state = "ready";
    }
  });

  const nickForm = page.querySelector("[data-form=profile-nick]");
  if (nickForm instanceof HTMLFormElement) {
    handleForm(nickForm, async (fields) => {
      const result = await postJson<{ user: AuthUser }>("/api/auth/profile", { minecraftUsername: fields.minecraftUsername });
      if (!result.ok || !result.data) {
        return messageFor(result.error);
      }
      fill(result.data.user);
      setMessage(nickForm, "Ник обновлён", "success");
      return null;
    });
  }

  const passwordForm = page.querySelector("[data-form=profile-password]");
  if (passwordForm instanceof HTMLFormElement) {
    handleForm(passwordForm, async (fields) => {
      if (fields.newPassword !== fields.newPasswordConfirm) {
        return messageText("password-mismatch");
      }
      const result = await postJson("/api/auth/password", { currentPassword: fields.currentPassword, newPassword: fields.newPassword });
      if (!result.ok) {
        return messageFor(result.error);
      }
      passwordForm.reset();
      setMessage(passwordForm, "Пароль изменён. На других устройствах нужно войти заново", "success");
      return null;
    });
  }
}
