async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // clipboard access is blocked (plain http or an old browser), fall back to a selection
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.append(field);
    field.select();
    const copied = document.execCommand("copy");
    field.remove();
    return copied;
  }
}

export function initCopyButtons(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-copy]")) {
    const label = button.textContent ?? "";
    let reset: number | undefined;
    button.addEventListener("click", async () => {
      const copied = await copyText(button.dataset.copy ?? "");
      button.textContent = copied ? "Скопировано" : "Не получилось";
      const announcer = button.parentElement?.querySelector<HTMLElement>("[data-copy-status]");
      if (announcer) {
        announcer.textContent = copied ? "Адрес скопирован" : "Скопируйте адрес вручную";
      }
      window.clearTimeout(reset);
      reset = window.setTimeout(() => {
        button.textContent = label;
      }, 2000);
    });
  }
}
