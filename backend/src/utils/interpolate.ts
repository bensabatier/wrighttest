import type { Step } from '../types/step';

const TEMPLATE_PATTERN = /\{\{(\w+)\}\}/g;
const UUID_PATTERN = /\{uuid\}/g;
const HAS_TEMPLATE_PATTERN = /\{\{\w+\}\}|\{uuid\}/;

export function interpolate(value: string, variables: Record<string, string>, randomUUID: string): string {
  let result = value;
  
  // Replace {{variable}} patterns
  result = result.replace(TEMPLATE_PATTERN, (match, key) => {
    if (key in variables) return variables[key];
    console.warn(`[interpolate] Variable {{${key}}} not found`);
    return match;
  });
  
  // Replace {uuid} patterns with generated UUID per run
  result = result.replace(UUID_PATTERN, () => randomUUID);
  
  return result;
}

export function hasUnresolvedVariables(value: string): boolean {
  return HAS_TEMPLATE_PATTERN.test(value);
}

export function interpolateStep(step: Step, variables: Record<string, string>, randomUUID: string): Step {
  return {
    ...step,
    value: step.value ? interpolate(step.value, variables, randomUUID) : step.value,
    expected: step.expected ? interpolate(step.expected, variables, randomUUID) : step.expected,
    selector: step.selector ? interpolate(step.selector, variables, randomUUID) : step.selector
  };
}
