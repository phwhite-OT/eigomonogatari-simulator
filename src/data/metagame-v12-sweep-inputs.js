import { METAGAME_V7_INPUTS } from "./metagame-v7-inputs.js";
import { METAGAME_V8_COST_200_INPUTS } from "./metagame-v8-cost-200-inputs.js";

export const METAGAME_V12_SWEEP_MIN_COST = 100;
export const METAGAME_V12_SWEEP_MAX_COST = 200;
export const METAGAME_V12_SWEEP_COST_STEP = 1;

export const METAGAME_V12_SWEEP_ATTRIBUTE_GROUPS = Object.freeze([
  Object.freeze(["fire"]),
  Object.freeze(["water"]),
  Object.freeze(["wind"]),
  Object.freeze(["fire", "water"]),
  Object.freeze(["fire", "wind"]),
  Object.freeze(["water", "wind"]),
  Object.freeze(["fire", "water", "wind"]),
]);

export const METAGAME_V12_REPRESENTATIVE_INPUTS = Object.freeze([
  ...METAGAME_V7_INPUTS,
  ...METAGAME_V8_COST_200_INPUTS,
]);

const ATTRIBUTE_ORDER = Object.freeze(["fire", "water", "wind"]);
const ATTRIBUTE_LABEL = Object.freeze({ fire: "火", water: "水", wind: "風" });

function normalizedAttributes(attributes) {
  const values = new Set((attributes ?? []).map(String));
  return ATTRIBUTE_ORDER.filter((attribute) => values.has(attribute));
}

export function metagameV12SweepAttributeKey(attributes) {
  return normalizedAttributes(attributes).join("-");
}

function attributeLabel(attributes) {
  return normalizedAttributes(attributes).map((attribute) => ATTRIBUTE_LABEL[attribute] ?? attribute).join("");
}

function parseSweepInputId(inputId) {
  const match = /^([a-z-]+):(\d+)$/.exec(String(inputId ?? ""));
  if (!match) return null;
  const totalCost = Number(match[2]);
  const allowedAttributes = match[1].split("-").filter(Boolean);
  const normalizedKey = metagameV12SweepAttributeKey(allowedAttributes);
  if (normalizedKey !== match[1]) return null;
  return { attributeKey: normalizedKey, allowedAttributes, totalCost };
}

function anchorsFor(attributeKey) {
  return METAGAME_V12_REPRESENTATIVE_INPUTS
    .filter((entry) => metagameV12SweepAttributeKey(entry.allowedAttributes) === attributeKey)
    .sort((left, right) => Number(left.totalCost) - Number(right.totalCost));
}

function nearestEnvironmentAnchor(attributeKey, totalCost) {
  const anchors = anchorsFor(attributeKey);
  if (!anchors.length) {
    throw new Error(`No metagame environment anchor exists for ${attributeKey}`);
  }
  return anchors.reduce((best, candidate) => {
    if (!best) return candidate;
    const candidateDistance = Math.abs(Number(candidate.totalCost) - totalCost);
    const bestDistance = Math.abs(Number(best.totalCost) - totalCost);
    if (candidateDistance !== bestDistance) return candidateDistance < bestDistance ? candidate : best;
    // At the exact midpoint, keep the lower-cost environment until the higher
    // representative environment becomes closer. This avoids jumping early.
    return Number(candidate.totalCost) < Number(best.totalCost) ? candidate : best;
  }, null);
}

export function resolveMetagameV12SweepInput(inputId) {
  const parsed = parseSweepInputId(inputId);
  if (!parsed) return null;
  if (parsed.totalCost < METAGAME_V12_SWEEP_MIN_COST || parsed.totalCost > METAGAME_V12_SWEEP_MAX_COST) {
    return null;
  }
  const supported = METAGAME_V12_SWEEP_ATTRIBUTE_GROUPS.some(
    (attributes) => metagameV12SweepAttributeKey(attributes) === parsed.attributeKey,
  );
  if (!supported) return null;

  const exact = METAGAME_V12_REPRESENTATIVE_INPUTS.find((entry) => (
    Number(entry.totalCost) === parsed.totalCost
    && metagameV12SweepAttributeKey(entry.allowedAttributes) === parsed.attributeKey
  ));
  const template = exact ?? nearestEnvironmentAnchor(parsed.attributeKey, parsed.totalCost);
  const templateCost = Number(template.totalCost);

  return Object.freeze({
    ...template,
    id: `${parsed.attributeKey}:${parsed.totalCost}`,
    label: `${attributeLabel(parsed.allowedAttributes)}・コスト${parsed.totalCost}`,
    allowedAttributes: Object.freeze([...parsed.allowedAttributes]),
    totalCost: parsed.totalCost,
    source: exact
      ? template.source
      : `${template.source} / nearest representative environment C${templateCost}`,
    environmentTemplateCost: templateCost,
    environmentTemplateInputId: template.id,
    syntheticCostInput: !exact,
  });
}

export function buildMetagameV12SweepInputs() {
  const inputs = [];
  for (
    let totalCost = METAGAME_V12_SWEEP_MIN_COST;
    totalCost <= METAGAME_V12_SWEEP_MAX_COST;
    totalCost += METAGAME_V12_SWEEP_COST_STEP
  ) {
    for (const attributes of METAGAME_V12_SWEEP_ATTRIBUTE_GROUPS) {
      const inputId = `${metagameV12SweepAttributeKey(attributes)}:${totalCost}`;
      const input = resolveMetagameV12SweepInput(inputId);
      if (!input) throw new Error(`Unable to resolve V12 sweep input ${inputId}`);
      inputs.push(input);
    }
  }
  return Object.freeze(inputs);
}

export const METAGAME_V12_SWEEP_INPUTS = buildMetagameV12SweepInputs();
export const METAGAME_V12_SWEEP_INPUT_IDS = Object.freeze(METAGAME_V12_SWEEP_INPUTS.map((input) => input.id));
