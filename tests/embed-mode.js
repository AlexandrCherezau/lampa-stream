// An embedded player opens with its own controls; checks of ours switch them on first.
import { expect } from "@playwright/test";

export async function useOurs(page) {
  const native = page.locator(".torrplayer--embed-native");
  await expect(page.locator(".torrplayer-embed")).toBeVisible();
  if (!(await native.count())) return;
  await page.locator(".torrplayer-embed-hotzone").hover();
  // A click right after the button appears only reveals it: that is how a tap behaves.
  await page.waitForTimeout(500);
  await page.locator(".torrplayer-embed-mode").click();
  await expect(native).toHaveCount(0);
}
