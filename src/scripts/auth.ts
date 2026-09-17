import { getCurrentUser, postJson, type AuthUser } from "./api";
import { formatDate } from "./format";

/** Error codes of the API turned into something a player can act on. */
const MESSAGES: Record<string, string> = {
  "invalid-username": "Логин: от 3 до 20 символов, латинские буквы, цифры или _",
  "username-reserved": "Такой логин занять нельзя, придумайте другой",
  "username-taken": "Этот логин уже занят",
  "invalid-password": "Пароль: от 8 до 128 символов",
  "password-too-obvious": "Пароль не должен совпадать с логином",
  "password-mismatch": "Пароли не совпадают",
  "invalid-minecraft-username": "Ник Minecraft: от 3 до 16 символов, латинские буквы, цифры или _",
  "minecraft-username-taken": "Этот ник уже привязан к другому аккаунту",
  "invalid-invite": "Неверный код приглашения",
  "registration-closed": "Регистрация закрыта. Спросите код приглашения у администратора",
  "invalid-credentials": "Неверный логин или пароль",
  unauthenticated: "Нужно войти в аккаунт",
  "rate-limited": "Слишком много попыток. Подождите несколько минут и попробуйте снова",
  "bad-origin": "Страница устарела. Обновите её и попробуйте снова",
  "body-too-large": "Слишком длинные данные",
  network: "Сайт не отвечает. Проверьте соединение и попробуйте снова",
};

const FALLBACK = "Не получилось. Попробуйте ещё раз";

function messageFor(code: string | null): string {
  return (code && MESSAGES[code]) || FALLBACK;
}

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

function setMessage(form: HTMLFormElement, text: string, kind: "error" | "success"): void {
  const box = form.querySelector("[data-form-message]");
  if (box instanceof HTMLElement) {
    box.textContent = text;
    box.dataset.kind = kind;
    box.hidden = text.length === 0;
  }
}

function values(form: HTMLFormElement): Record<string, string> {
  const data = new FormData(form);
  const result: Record<string, string> = {};
  for (const [name, value] of data.entries()) {
    if (typeof value === "string") {
      result[name] = value;
    }
  }
  return result;
}

/** Wires a form: one request at a time, errors in the form, no page reload. */
function handleForm(form: HTMLFormElement, submit: (fields: Record<string, string>) => Promise<string | null>): void {
  const button = form.querySelector("button[type=submit]");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (form.dataset.busy === "true") {
      return;
    }
    form.dataset.busy = "true";
    if (button instanceof HTMLButtonElement) {
      button.disabled = true;
    }
    setMessage(form, "", "error");
    void submit(values(form))
      .then((error) => {
        if (error) {
          setMessage(form, error, "error");
        }
      })
      .finally(() => {
        form.dataset.busy = "false";
        if (button instanceof HTMLButtonElement) {
          button.disabled = false;
        }
      });
  });
}

let userRequest: Promise<AuthUser | null> | null = null;

function currentUser(): Promise<AuthUser | null> {
  userRequest ??= getCurrentUser();
  return userRequest;
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
        return MESSAGES["password-mismatch"]!;
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
    for (const name of document.querySelectorAll("[data-account-name]")) {
      name.textContent = user.minecraftUsername;
    }
  };

  void currentUser().then(
    (user) => {
      if (!user) {
        location.replace(`/login?next=${encodeURIComponent(location.pathname)}`);
        return;
      }
      fill(user);
      page.dataset.state = "ready";
    },
    () => {
      page.dataset.state = "error";
    },
  );

  const nickForm = page.querySelector("[data-form=profile-nick]");
  if (nickForm instanceof HTMLFormElement) {
    handleForm(nickForm, async (fields) => {
      const result = await postJson<{ user: AuthUser }>("/api/auth/profile", { minecraftUsername: fields.minecraftUsername });
      if (!result.ok || !result.data) {
        return messageFor(result.error);
      }
      fill(result.data.user);
      userRequest = Promise.resolve(result.data.user);
      setMessage(nickForm, "Ник обновлён", "success");
      return null;
    });
  }

  const passwordForm = page.querySelector("[data-form=profile-password]");
  if (passwordForm instanceof HTMLFormElement) {
    handleForm(passwordForm, async (fields) => {
      if (fields.newPassword !== fields.newPasswordConfirm) {
        return MESSAGES["password-mismatch"]!;
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
