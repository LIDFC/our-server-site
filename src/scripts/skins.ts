import { getJson, postFile, postJson, type PublicSkin, type SkinState } from "./api";
import { requireAccount } from "./auth";
import { formatDate, formatNumber, formatSize, formatTime } from "./format";
import { handleForm, messageFor, messageText, setMessage } from "./forms";

const ACCEPTED = ["image/png", "image/jpeg"];

/** Skins weigh a few kilobytes, so megabytes would always read as "0 МБ". */
function fileSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${formatNumber(Math.max(1, Math.round(bytes / 1024)))} КБ` : formatSize(bytes);
}

function field(page: HTMLElement, name: string): HTMLElement | null {
  return page.querySelector<HTMLElement>(`[data-skin-${name}]`);
}

function setText(page: HTMLElement, name: string, text: string): void {
  const element = field(page, name);
  if (element) {
    element.textContent = text;
  }
}

function show(element: Element | null, visible: boolean): void {
  if (element instanceof HTMLElement) {
    element.hidden = !visible;
  }
}

/** Checked in the browser too, only so the player hears about an obvious problem before the upload starts. */
function quickCheck(file: File, maxBytes: number): string | null {
  if (!ACCEPTED.includes(file.type)) {
    return messageText("format-unknown");
  }
  if (file.size > maxBytes) {
    return messageText("file-too-large");
  }
  if (file.size === 0) {
    return messageText("empty-file");
  }
  return null;
}

const DROP_HINT = "или перетащите картинку сюда";

/** The native file input is hidden inside its label: this keeps the shown file name and the drop zone in step. */
function initFilePicker(page: HTMLElement): void {
  const drop = page.querySelector("[data-skin-drop]");
  const input = page.querySelector("input[type=file]");
  const name = field(page, "file");
  if (!(drop instanceof HTMLElement) || !(input instanceof HTMLInputElement) || !name) {
    return;
  }

  const showChoice = (): void => {
    const file = input.files?.[0];
    name.textContent = file ? `${file.name} · ${fileSize(file.size)}` : DROP_HINT;
    name.dataset.chosen = file ? "true" : "false";
  };
  input.addEventListener("change", showChoice);
  page.addEventListener("reset", () => setTimeout(showChoice));

  for (const event of ["dragenter", "dragover"]) {
    drop.addEventListener(event, (dragEvent) => {
      dragEvent.preventDefault();
      drop.dataset.dragging = "true";
    });
  }
  for (const event of ["dragleave", "dragend"]) {
    drop.addEventListener(event, () => {
      drop.dataset.dragging = "false";
    });
  }
  drop.addEventListener("drop", (dragEvent) => {
    dragEvent.preventDefault();
    drop.dataset.dragging = "false";
    const dropped = (dragEvent as DragEvent).dataTransfer?.files;
    if (dropped && dropped.length > 0) {
      input.files = dropped;
      showChoice();
    }
  });
}

export function initSkinsPage(): void {
  const page = document.querySelector("[data-skins]");
  if (!(page instanceof HTMLElement)) {
    return;
  }

  initFilePicker(page);
  let maxBytes = 8 * 1024 * 1024;

  const render = (skin: PublicSkin | null): void => {
    const preview = field(page, "preview");
    const links = field(page, "links");
    show(field(page, "empty"), skin === null);
    show(preview, skin !== null);
    show(links, skin !== null);
    show(field(page, "details"), skin !== null);
    if (!skin) {
      return;
    }
    const image = field(page, "image");
    if (image instanceof HTMLImageElement) {
      image.src = skin.url;
      image.width = skin.width;
      image.height = skin.height;
    }
    setText(page, "size", `${skin.width}×${skin.height}, ${fileSize(skin.fileSize)}`);
    setText(page, "source", skin.converted ? `${skin.originalFileName ?? "JPG"} — сохранён как PNG` : (skin.originalFileName ?? "PNG"));
    setText(page, "updated", `${formatDate(skin.updatedAt)}, ${formatTime(skin.updatedAt)}`);
    setText(page, "url", skin.url);
    setText(page, "command", skin.command);
    setText(page, "name", skin.skinName);
    for (const button of page.querySelectorAll<HTMLButtonElement>("[data-copy-url]")) {
      button.dataset.copy = skin.url;
    }
    for (const button of page.querySelectorAll<HTMLButtonElement>("[data-copy-command]")) {
      button.dataset.copy = skin.command;
    }
  };

  const load = async (): Promise<void> => {
    const state = await getJson<SkinState>("/api/skins/me");
    maxBytes = state.limits.maxBytes;
    setText(page, "nick", state.minecraftUsername);
    setText(page, "limit", `${Math.round(maxBytes / 1024 / 1024)} МБ`);
    render(state.skin);
    page.dataset.state = "ready";
  };

  void requireAccount(page).then((user) => {
    if (user) {
      load().catch(() => {
        page.dataset.state = "error";
      });
    }
  });

  const uploadForm = page.querySelector("[data-form=skin-upload]");
  if (uploadForm instanceof HTMLFormElement) {
    handleForm(uploadForm, async () => {
      const input = uploadForm.querySelector("input[type=file]");
      const file = input instanceof HTMLInputElement ? input.files?.[0] : undefined;
      if (!file) {
        return "Выберите файл со скином";
      }
      const problem = quickCheck(file, maxBytes);
      if (problem) {
        return problem;
      }
      const result = await postFile<{ skin: PublicSkin }>("/api/skins", file);
      if (!result.ok || !result.data) {
        return messageFor(result.error);
      }
      render(result.data.skin);
      uploadForm.reset();
      setMessage(
        uploadForm,
        result.data.skin.converted ? "Скин загружен и сохранён как PNG" : "Скин загружен",
        "success",
      );
      return null;
    });
  }

  const deleteForm = page.querySelector("[data-form=skin-delete]");
  if (deleteForm instanceof HTMLFormElement) {
    handleForm(deleteForm, async () => {
      if (!confirm("Удалить скин с сайта? Ссылка перестанет работать.")) {
        return null;
      }
      const result = await postJson("/api/skins/delete", {});
      if (!result.ok) {
        return messageFor(result.error);
      }
      render(null);
      setMessage(deleteForm, "", "success");
      if (uploadForm instanceof HTMLFormElement) {
        setMessage(uploadForm, "Скин удалён", "success");
      }
      return null;
    });
  }
}
