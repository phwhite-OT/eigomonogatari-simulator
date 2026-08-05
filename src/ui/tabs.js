export function initializeAppTabs(root = document) {
  const buttons = [...root.querySelectorAll("[data-tab-target]")];
  const panels = [...root.querySelectorAll("[data-tab-panel]")];
  if (!buttons.length || !panels.length) return;

  const targets = new Set(buttons.map((button) => button.dataset.tabTarget));
  const hashTargets = { "#pvp": "pvp", "#characters": "characters", "#lightest": "lightest" };
  const activate = (target, updateHash = false) => {
    const resolvedTarget = targets.has(target) ? target : "pvp";
    buttons.forEach((button) => {
      const selected = button.dataset.tabTarget === resolvedTarget;
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    panels.forEach((panel) => {
      panel.hidden = panel.dataset.tabPanel !== resolvedTarget;
    });
    if (updateHash) history.replaceState(null, "", `#${resolvedTarget}`);
  };

  buttons.forEach((button) => button.addEventListener("click", () => activate(button.dataset.tabTarget, true)));
  activate(hashTargets[location.hash] ?? "pvp");
}
