import { expect, test } from "@playwright/test";

test("loads the sample graph and supports map blending plus hover focus", async ({ page }, testInfo) => {
  await page.goto("/");

  await expect(page.locator(".brand")).toContainText("AyaTopos");
  await page.getByRole("button", { name: /サンプル/ }).click();
  await page.getByPlaceholder(/中心エリア/).fill("ネパール");
  await page.getByRole("button", { name: /可視化/ }).click();

  await expect(page.locator(".node-card")).toHaveCount(14);
  await expect(page.locator(".geo-point-glow")).toHaveCount(65);
  await expect(page.locator(".group-outline")).toHaveCount(14);
  await expect(page.locator(".thread")).toHaveCount(4);
  await expect(page.locator(".inspector-strip")).toContainText("115 nodes");

  const slider = page.locator(".blend-control input");
  await slider.evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = "0.88";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });

  await page.locator(".node-card.group").last().hover();
  await expect(page.locator(".node-tooltip")).toBeVisible();
  await page.screenshot({
    path: `test-results/ayatopos-${testInfo.project.name}.png`,
    fullPage: true
  });
});
