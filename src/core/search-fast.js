import { filterCandidates, isSkillTurnAllowedAtPosition, normalizeConstraints, skillTurnRangeForPosition, validateDeck } from "./filter.js";
import { buildRepresentativeEnemies, evaluateDeckDetailed, scoreDeckLight } from "./evaluate.js";

class TopDecks {
  constructor(limit) {
    this.limit = limit;
    this.items = [];
  }

  add(item) {
    if (this.items.length < this.limit) {
      this.items.push(item);
      this.up(this.items.length - 1);
    } else if (item.lightScore > this.items[0].lightScore) {
      this.items[0] = item;
      this.down(0);
    }
  }

  up(index) {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.items[parent].lightScore <= this.items[index].lightScore) break;
      [this.items[parent], this.items[index]] = [this.items[index], this.items[parent]];
      index = parent;
    }
  }

  down(index) {
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < this.items.length && this.items[left].lightScore < this.items[smallest].lightScore) smallest = left;
      if (right < this.items.length && this.items[right].lightScore < this.items[smallest].lightScore) smallest = right;
      if (smallest === index) break;
      [this.items[index], this.items[smallest]] = [this.items[smallest], this.items[index]];
      index = smallest;
    }
  }

  sorted() {
    return [...this.items].sort((left, right) => right.lightScore - left.lightScore);
  }
}

export function createSeededRandom(seed = Date.now()) {
  let state = Number(seed) >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function prepare(candidates, deckSize) {
  const pools = {};
  const minimumCosts = {};
  for (let position = 1; position <= deckSize; position += 1) {
    pools[position] = candidates.filter((character) => character.allowedPositions.includes(position) && isSkillTurnAllowedAtPosition(character, position));
    minimumCosts[position] = pools[position].reduce(
      (minimum, character) => Math.min(minimum, character.cost),
      Number.POSITIVE_INFINITY,
    );
  }
  return {
    byId: new Map(candidates.map((character) => [String(character.id), character])),
    pools,
    minimumCosts,
  };
}

function isReusable(character, deck, constraints) {
  return constraints.allowDuplicates || !deck.some((placed) => String(placed?.id) === String(character.id));
}

function weight(character, position) {
  const tier = { exclude: 0.3, low: 0.8, normal: 1.8, priority: 3.2 }[character.pvpTier] ?? 1;
  const placement = character.preferredPositions.includes(position) ? 2.1 : 1;
  return tier * placement * (character.roleTags.length ? 1.15 : 0.85);
}

function pick(pool, position, deck, constraints, maximumCost, random) {
  const eligible = (character) => isReusable(character, deck, constraints) && character.cost <= maximumCost;
  for (let attempt = 0; attempt < 28; attempt += 1) {
    const character = pool[Math.floor(random() * pool.length)];
    if (character && eligible(character) && random() * 7 <= weight(character, position)) return character;
  }
  const fallback = pool.filter(eligible);
  if (!fallback.length) return null;
  return fallback[Math.floor(random() * fallback.length)];
}

function placeCharacter(deck, character, random) {
  const available = deck.flatMap((placed, index) =>
    !placed && character.allowedPositions.includes(index + 1) && isSkillTurnAllowedAtPosition(character, index + 1) ? [index + 1] : [],
  );
  if (!available.length) return false;
  const preferred = available.filter((position) => character.preferredPositions.includes(position));
  const choices = preferred.length ? preferred : available;
  deck[choices[Math.floor(random() * choices.length)] - 1] = character;
  return true;
}

export function constructDeck(candidates, rawConstraints, random = Math.random, prepared) {
  const constraints = normalizeConstraints(rawConstraints);
  const construction = prepared ?? prepare(candidates, constraints.deckSize);
  const deck = Array(constraints.deckSize).fill(null);

  for (const [rawPosition, id] of Object.entries(constraints.fixedPositions)) {
    const position = Number(rawPosition);
    const character = construction.byId.get(String(id));
    if (!character || !character.allowedPositions.includes(position) || !isSkillTurnAllowedAtPosition(character, position) || !isReusable(character, deck, constraints)) return null;
    deck[position - 1] = character;
  }

  for (const id of constraints.requiredIds) {
    if (deck.some((character) => String(character?.id) === id)) continue;
    const character = construction.byId.get(id);
    if (!character || !isReusable(character, deck, constraints) || !placeCharacter(deck, character, random)) return null;
  }

  if (constraints.requiredRole && !deck.some((character) => character?.roleTags.includes(constraints.requiredRole))) {
    const rolePool = candidates.filter(
      (character) => character.roleTags.includes(constraints.requiredRole) && isReusable(character, deck, constraints),
    );
    const viable = rolePool.filter((character) =>
      deck.some((placed, index) => !placed && character.allowedPositions.includes(index + 1)),
    );
    if (!viable.length || !placeCharacter(deck, viable[Math.floor(random() * viable.length)], random)) return null;
  }

  const positions = deck
    .flatMap((character, index) => (character ? [] : [index + 1]))
    .sort((left, right) => construction.pools[left].length - construction.pools[right].length);
  for (const position of positions) {
    const currentCost = deck.reduce((sum, character) => sum + (character?.cost ?? 0), 0);
    const reserve = positions
      .filter((nextPosition) => nextPosition !== position && !deck[nextPosition - 1])
      .reduce((sum, nextPosition) => sum + construction.minimumCosts[nextPosition], 0);
    const maximumCost = constraints.totalCost - currentCost - reserve;
    const character = pick(construction.pools[position], position, deck, constraints, maximumCost, random);
    if (!character) return null;
    deck[position - 1] = character;
  }

  return validateDeck(deck, constraints).valid ? deck : null;
}

function preflight(candidates, constraints) {
  const errors = [];
  const ids = new Set(candidates.map((character) => String(character.id)));
  if (!constraints.allowDuplicates && candidates.length < constraints.deckSize) errors.push(`条件に合うキャラが${constraints.deckSize}体未満です。`);
  for (const id of constraints.requiredIds) {
    if (!ids.has(id)) errors.push(`必須キャラ ${id} は現在の条件では使用できません。`);
  }
  for (const [position, id] of Object.entries(constraints.fixedPositions)) {
    const character = candidates.find((candidate) => String(candidate.id) === id);
    if (!character) errors.push(`${position}枠固定キャラ ${id} は現在の条件では使用できません。`);
    else if (!character.allowedPositions.includes(Number(position))) errors.push(`${character.name} は${position}枠目に配置できません。`);
    else if (!isSkillTurnAllowedAtPosition(character, Number(position))) {
      const [minimum, maximum] = skillTurnRangeForPosition(position);
      errors.push(`${character.name}のスキルターン${character.skillTurn}は${position}枠目の許容範囲${minimum}〜${maximum}ではありません。`);
    }
  }
  if (constraints.requiredRole && !candidates.some((character) => character.roleTags.includes(constraints.requiredRole))) {
    errors.push(`必須役割 ${constraints.requiredRole} を持つ候補がありません。`);
  }
  for (let position = 1; position <= constraints.deckSize; position += 1) {
    const positionCandidates = candidates.filter((character) =>
      character.allowedPositions.includes(position) && isSkillTurnAllowedAtPosition(character, position),
    );
    if (!positionCandidates.length) {
      const range = skillTurnRangeForPosition(position);
      const description = range ? `スキルターン${range[0]}〜${range[1]}` : "スキルターン不問";
      errors.push(`${position}枠目に配置できるキャラがありません（${description}）。`);
    }
  }
  const cheapest = [...candidates].sort((left, right) => left.cost - right.cost).slice(0, constraints.deckSize);
  if (cheapest.length === constraints.deckSize && cheapest.reduce((sum, character) => sum + character.cost, 0) > constraints.totalCost) {
    errors.push("総コスト上限が低すぎてデッキを構成できません。");
  }
  return errors;
}

function addAlternatives(results) {
  return results.map((result, resultIndex) => {
    const alternatives = [];
    for (let index = 0; index < results.length && alternatives.length < 3; index += 1) {
      if (index === resultIndex) continue;
      const changed = result.deck.flatMap((character, position) =>
        String(character.id) === String(results[index].deck[position].id) ? [] : [position],
      );
      if (changed.length === 1) {
        const position = changed[0];
        alternatives.push({ position: position + 1, from: result.deck[position], to: results[index].deck[position], score: results[index].score });
      }
    }
    return { ...result, alternatives };
  });
}

function pause() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function searchDecks(characters, rawConstraints, rules, options = {}) {
  const { candidates, constraints, excludedCounts } = filterCandidates(characters, rawConstraints);
  const errors = preflight(candidates, constraints);
  if (errors.length) return { results: [], candidates, constraints, excludedCounts, errors, stats: null };

  const iterations = options.iterations ?? rules.search.modes[constraints.mode];
  const chunkSize = options.chunkSize ?? rules.search.chunkSize;
  const topLimit = Math.min(options.topLimit ?? rules.search.topLimit, iterations);
  const detailedLimit = Math.min(options.detailedLimit ?? rules.search.detailedLimit, topLimit);
  const random = createSeededRandom(options.seed ?? Date.now());
  const construction = prepare(candidates, constraints.deckSize);
  const profiles = buildRepresentativeEnemies(candidates, rules);
  const context = { constraints, rules, profiles };
  const topDecks = new TopDecks(topLimit);
  const signatures = new Set();
  const startedAt = performance.now();
  let valid = 0;

  for (let offset = 0; offset < iterations; offset += chunkSize) {
    if (options.signal?.aborted) throw new DOMException("探索をキャンセルしました。", "AbortError");
    const end = Math.min(iterations, offset + chunkSize);
    for (let index = offset; index < end; index += 1) {
      const deck = constructDeck(candidates, constraints, random, construction);
      if (!deck) continue;
      const signature = deck.map((character) => character.id).join(">");
      if (signatures.has(signature)) continue;
      signatures.add(signature);
      valid += 1;
      topDecks.add({ deck, lightScore: scoreDeckLight(deck, context) });
    }
    options.onProgress?.({ phase: "search", current: end, total: iterations, valid });
    await pause();
  }

  const finalists = topDecks.sorted().slice(0, detailedLimit);
  const detailed = [];
  for (let index = 0; index < finalists.length; index += 1) {
    if (options.signal?.aborted) throw new DOMException("探索をキャンセルしました。", "AbortError");
    detailed.push(evaluateDeckDetailed(finalists[index].deck, context));
    if ((index + 1) % 12 === 0 || index === finalists.length - 1) {
      options.onProgress?.({ phase: "detail", current: index + 1, total: finalists.length, valid });
      await pause();
    }
  }
  detailed.sort((left, right) => right.score - left.score);
  return {
    results: addAlternatives(detailed),
    candidates,
    constraints,
    excludedCounts,
    errors: [],
    profiles,
    stats: {
      generated: iterations,
      valid,
      unique: signatures.size,
      detailed: detailed.length,
      elapsedMs: performance.now() - startedAt,
    },
  };
}
