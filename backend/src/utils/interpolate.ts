import type { Step } from '../types/step';
import { v4 as uuidv4 } from 'uuid';

const TEMPLATE_PATTERN = /\{\{(\w+)\}\}/g;
const UUID_PATTERN = /\{uuid\}/g;
const HAS_TEMPLATE_PATTERN = /\{\{\w+\}\}|\{uuid\}/;

export function interpolate(value: string, variables: Record<string, string>): string {
  let result = value;
  
  // Replace {{variable}} patterns
  result = result.replace(TEMPLATE_PATTERN, (match, key) => {
    if (key in variables) return variables[key];
    console.warn(`[interpolate] Variable {{${key}}} not found`);
    return match;
  });
  
  // Replace {uuid} patterns with generated UUIDs
  result = result.replace(UUID_PATTERN, () => uuidv4());
  
  return result;
}

export function hasUnresolvedVariables(value: string): boolean {
  return HAS_TEMPLATE_PATTERN.test(value);
}

export function interpolateStep(step: Step, variables: Record<string, string>): Step {
  return {
    ...step,
    value: step.value ? interpolate(step.value, variables) : step.value,
    expected: step.expected ? interpolate(step.expected, variables) : step.expected,
    selector: step.selector ? interpolate(step.selector, variables) : step.selector
  };
}
