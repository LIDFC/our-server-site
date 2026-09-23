/** Error codes of the API turned into something a player can act on. */
const MESSAGES: Record<string, string> = {
  // accounts
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
  // skins
  "file-too-large": "Файл слишком большой: максимум 8 МБ",
  "empty-file": "Файл пустой — выберите картинку со скином",
  "format-gif": "GIF не подходит: скин должен быть PNG или JPG",
  "format-webp": "WebP не подходит: скин должен быть PNG или JPG",
  "format-svg": "SVG не подходит: скин должен быть PNG или JPG",
  "format-bmp": "BMP не подходит: сохраните скин в PNG",
  "format-tiff": "TIFF не подходит: сохраните скин в PNG",
  "format-archive": "Это архив, а не скин",
  "format-executable": "Это программа, а не скин",
  "format-document": "Это документ, а не скин",
  "format-unknown": "Принимаются только файлы PNG и JPG",
  "type-mismatch": "Файл только переименован в PNG или JPG, внутри другой формат",
  "extension-mismatch": "Расширение файла не совпадает с его содержимым",
  "bad-size": "Файл не является корректным Minecraft-скином: нужен размер 64×64 или 64×32",
  "not-png": "Файл не является корректным Minecraft-скином",
  "not-jpeg": "Файл не является корректным Minecraft-скином",
  "broken-png": "Файл не является корректным Minecraft-скином: PNG не читается",
  "broken-jpeg": "Файл не является корректным Minecraft-скином: JPG не читается",
  "broken-image": "Файл не является корректным Minecraft-скином",
  "png-interlaced": "Сохраните PNG без чередования строк (interlace)",
  "jpeg-progressive": "Это прогрессивный JPG. Сохраните скин в PNG",
  "invalid-skin-name": "Имя скина: от 3 до 16 символов, латинские буквы, цифры или _",
  "skin-name-reserved": "Это слово — команда SkinsRestorer, выберите другое имя",
  "skin-name-taken": "Такое имя уже занято другим игроком",
  "upload-cooldown": "Слишком часто. Подождите немного и попробуйте снова",
  "save-failed": "Не удалось сохранить скин. Прежний остался на месте",
  "no-skin": "Скина пока нет",
  // marketplace
  "market-disabled": "Раздел рынка ещё не настроен",
  "market-unavailable": "Рынок сейчас не отвечает. Попробуйте позже",
  "market-failed": "Рынок не смог выполнить действие. Попробуйте позже",
  "market-unauthorized": "Сайт не смог представиться рынку. Напишите администратору",
  "minecraft-not-linked": "Зайдите один раз на сервер, чтобы рынок вас узнал",
  "listing-not-found": "Такого лота уже нет",
  "trade-not-found": "Такой сделки уже нет",
  "not-owner": "Это не ваш лот",
  "not-participant": "Вы не участник этой сделки",
  "not-recipient": "Этот подарок предназначен другому игроку",
  "listing-already-taken": "Лот уже забрали",
  "listing-not-active": "Лот уже не активен",
  "trade-not-accepted": "Сделку ещё не приняли",
  "player-not-found": "Такого игрока рынок не знает",
  "own-listing": "Это ваш собственный лот",
  "market-outdated": "На сервере стоит плагин прошлой версии, эта возможность там ещё не появилась",
  "empty-listing": "Выберите хотя бы одну вещь",
  "too-many-items": "Слишком много стопок в одном лоте",
  "chest-not-bound": "Сундук не привязан. В игре посмотрите на сундук и наберите /market chest",
  "chest-already-bound": "Этот сундук уже чей-то склад",
  "chest-missing": "Сундука больше нет на месте",
  "chest-changed": "Содержимое сундука изменилось. Посмотрите его заново и выберите ещё раз",
  "chest-in-use": "Сундук сейчас открыт в игре. Закройте его и повторите",
  "chest-busy": "С этим сундуком уже идёт операция",
  "chest-locked": "Рынок ещё сверяется с сундуком после перезапуска. Подождите минуту",
  "chest-unavailable": "До сундука сейчас не добраться. Попробуйте позже",
  // shared
  "rate-limited": "Слишком много попыток. Подождите несколько минут и попробуйте снова",
  "bad-origin": "Страница устарела. Обновите её и попробуйте снова",
  "body-too-large": "Слишком длинные данные",
  network: "Сайт не отвечает. Проверьте соединение и попробуйте снова",
};

const FALLBACK = "Не получилось. Попробуйте ещё раз";

export function messageFor(code: string | null): string {
  return (code && MESSAGES[code]) || FALLBACK;
}

export function messageText(code: string): string {
  return MESSAGES[code] ?? FALLBACK;
}

export function setMessage(form: HTMLFormElement, text: string, kind: "error" | "success"): void {
  const box = form.querySelector("[data-form-message]");
  if (box instanceof HTMLElement) {
    box.textContent = text;
    box.dataset.kind = kind;
    box.hidden = text.length === 0;
  }
}

function values(form: HTMLFormElement): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of new FormData(form).entries()) {
    if (typeof value === "string") {
      result[name] = value;
    }
  }
  return result;
}

/** Wires a form: one request at a time, errors shown in the form itself, no page reload. */
export function handleForm(form: HTMLFormElement, submit: (fields: Record<string, string>) => Promise<string | null>): void {
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
