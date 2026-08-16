export function initializeAppTabs(root = document, options = {}) {
  const buttons = [...root.querySelectorAll("[data-tab-target]")];
  const panels = [...root.querySelectorAll("[data-tab-panel]")];
  if (!buttons.length || !panels.length) return { activate() {}, setAccess() {}, isAccessible() { return false; } };

  const targets = new Set(buttons.map((button) => button.dataset.tabTarget));
  const hashTargets = { "#pvp": "pvp", "#characters": "characters", "#lightest": "lightest" };
  const access = new Map([...targets].map((target) => [target, options.initialAccess?.[target] !== false]));
  let activeTarget = null;

  const isAccessible = (target) => targets.has(target) && access.get(target) !== false;
  const fallbackTarget = () => (isAccessible("pvp") ? "pvp" : [...targets].find(isAccessible));
  const activate = (target, updateHash = false) => {
    const resolvedTarget = isAccessible(target) ? target : fallbackTarget();
    if (!resolvedTarget) return;
    activeTarget = resolvedTarget;
    buttons.forEach((button) => {
      const selected = button.dataset.tabTarget === resolvedTarget;
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    panels.forEach((panel) => {
      panel.hidden = panel.dataset.tabPanel !== resolvedTarget || !isAccessible(panel.dataset.tabPanel);
    });
    if (updateHash) history.replaceState(null, "", `#${resolvedTarget}`);
  };

  buttons.forEach((button) => button.addEventListener("click", () => activate(button.dataset.tabTarget, true)));
  const setAccess = (target, allowed) => {
    if (!targets.has(target)) return;
    const isAllowed = Boolean(allowed);
    access.set(target, isAllowed);
    const button = buttons.find((entry) => entry.dataset.tabTarget === target);
    const panel = panels.find((entry) => entry.dataset.tabPanel === target);
    if (button) {
      button.hidden = !isAllowed;
      button.disabled = !isAllowed;
      button.setAttribute("aria-hidden", String(!isAllowed));
    }
    if (panel && !isAllowed) panel.hidden = true;
    if (!isAllowed && activeTarget === target) activate(fallbackTarget(), true);
  };

  for (const target of targets) setAccess(target, isAccessible(target));
  activate(hashTargets[location.hash] ?? "pvp");
  return { activate, setAccess, isAccessible };
}
