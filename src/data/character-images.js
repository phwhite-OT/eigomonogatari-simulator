import { CHARACTER_IMAGE_BY_ID } from "./character-image-manifest.js";

export function resolveCharacterImageUrl(character) {
  const imageUrl = CHARACTER_IMAGE_BY_ID[String(character?.id ?? "")];
  return typeof imageUrl === "string" && imageUrl.trim() ? imageUrl : "";
}
