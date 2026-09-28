import { expect } from '@playwright/test';

// Compare textContent, not normalized locator text. Failed checks need no text dump.
export async function exact(locator, text) {
  await expect(locator).toHaveCount(1);
  await expect.poll(async () => (await locator.textContent()) === text).toBe(true);
}
export async function occurrences(locator, text, expected) {
  await expect.poll(() => locator.locator('pre').evaluateAll((nodes, text) =>
    nodes.filter(node => node.textContent === text).length, text)).toBe(expected);
}
