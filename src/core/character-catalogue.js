function categoryName(character) {
  const sheet = String(character?.source?.sheet ?? "").trim();
  if (sheet) return sheet;

  const region = String(character?.region ?? "").trim();
  if (region) return region;
  return "追加キャラ・その他";
}

export function groupCharactersForCatalogue(characters) {
  const groups = new Map();
  for (const [sourceIndex, character] of (Array.isArray(characters) ? characters : []).entries()) {
    const name = categoryName(character);
    if (!groups.has(name)) {
      groups.set(name, {
        id: `catalogue-${groups.size + 1}`,
        name,
        items: [],
      });
    }
    groups.get(name).items.push({ character, sourceIndex });
  }
  return [...groups.values()];
}
