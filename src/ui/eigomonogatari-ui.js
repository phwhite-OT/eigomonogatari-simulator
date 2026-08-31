import { resolveCharacterImageUrl } from "../data/character-images.js";

// Presentation-only wrapper around the existing metagame slot renderer.
// It keeps every existing data point and interaction, but adds the card-art-first
// visual structure used by the game itself: character art, attribute frame and
// compact visible stats, while verbose matchup reasoning stays one tap away.
const baseMetagameUiSlot = metagameUiSlot;
metagameUiSlot = function eigomonogatariMetagameUiSlot(character, ...args) {
  const card = baseMetagameUiSlot(character, ...args);
  card.classList.add("yuru-card");
  card.dataset.attribute = (character?.attributes ?? []).join("-");

  const portrait = document.createElement("div");
  portrait.className = "metagame-slot-portrait";
  const imageUrl = resolveCharacterImageUrl(character);
  if (imageUrl) {
    const image = document.createElement("img");
    image.src = imageUrl;
    image.alt = character.name ?? "キャラクター";
    image.loading = "lazy";
    image.decoding = "async";
    portrait.append(image);
  } else {
    const fallback = document.createElement("span");
    fallback.textContent = String(character?.name ?? "?").slice(0, 1) || "?";
    portrait.append(fallback);
  }

  const stats = document.createElement("div");
  stats.className = "metagame-slot-quick-stats";
  [
    ["Cost", character?.cost],
    ["HP", character?.hp],
    ["Pow", character?.pow],
    ["Skill", `${character?.skillTurn ?? "-"}T`],
  ].forEach(([label, value]) => {
    const item = document.createElement("span");
    const key = document.createElement("small");
    const data = document.createElement("strong");
    key.textContent = label;
    data.textContent = value ?? "-";
    item.append(key, data);
    stats.append(item);
  });

  const number = card.querySelector(":scope > .metagame-slot-number");
  const copy = card.querySelector(":scope > .metagame-slot-copy");
  if (copy) {
    card.insertBefore(portrait, copy);
    card.insertBefore(stats, copy);

    const matchup = copy.querySelector(".metagame-concrete-matchups");
    if (matchup && !matchup.closest("details")) {
      const details = document.createElement("details");
      details.className = "metagame-card-details";
      const summary = document.createElement("summary");
      summary.textContent = "このキャラの対戦例";
      matchup.replaceWith(details);
      details.append(summary, matchup);
    }
  } else if (number) {
    number.after(portrait, stats);
  } else {
    card.prepend(portrait, stats);
  }
  return card;
};
