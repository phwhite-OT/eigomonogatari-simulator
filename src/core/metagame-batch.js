export const DEFAULT_ATTRIBUTE_GROUPS = Object.freeze([
  Object.freeze(["fire"]),
  Object.freeze(["water"]),
  Object.freeze(["wind"]),
  Object.freeze(["fire", "water"]),
  Object.freeze(["fire", "wind"]),
  Object.freeze(["water", "wind"]),
  Object.freeze(["fire", "water", "wind"]),
]);

export const DEFAULT_REPRESENTATIVE_COSTS = Object.freeze([100, 200, 300, 500]);

export function buildMetagameBatchTasks({
  attributeGroups = DEFAULT_ATTRIBUTE_GROUPS,
  costs = DEFAULT_REPRESENTATIVE_COSTS,
  positions = [1, 2, 3, 4, 5],
  passes = 2,
} = {}) {
  const tasks = [];
  for (const cost of costs) {
    for (const allowedAttributes of attributeGroups) {
      const attributeKey = allowedAttributes.join("-");
      const combinations = positions.map((position) => ({
        allowedAttributes: [...allowedAttributes],
        attributeKey,
        cost,
        position,
      }));
      for (let pass = 1; pass <= passes; pass += 1) {
        const passCombinations = pass % 2 === 1 ? combinations : [...combinations].reverse();
        for (const combination of passCombinations) {
          tasks.push({
            ...combination,
            pass,
            constraintId: `${attributeKey}:${cost}`,
            id: `${pass}:${attributeKey}:${cost}:${combination.position}`,
          });
        }
      }
    }
  }
  return tasks;
}
