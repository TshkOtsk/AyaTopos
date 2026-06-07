import { expect, test } from "@playwright/test";

test("loads the sample graph and supports map blending plus hover focus", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");

  await expect(page.locator(".brand")).toContainText("AyaTopos");
  await page.getByRole("button", { name: /サンプル/ }).click();
  await page.getByPlaceholder(/中心エリア/).fill("ネパール");
  await page.getByRole("button", { name: /可視化/ }).click();

  await expect(page.locator(".map-canvas")).toHaveAttribute("data-terrain", "ready");
  await expect(page.locator(".idea-hit-target.card")).toHaveCount(0);
  await expect(page.locator(".idea-hit-target")).toHaveCount(0);
  await expect(page.locator(".card-stem")).toHaveCount(0);
  await expect(page.locator(".node-card")).toHaveCount(0);
  await expect(page.locator(".map-canvas canvas")).toHaveCount(1);
  await expect(page.locator(".geo-point-glow")).toHaveCount(115);
  await expect(page.locator(".group-outline")).toHaveCount(14);
  await expect(page.locator(".thread")).toHaveCount(0);
  await expect(page.locator(".idea-tooltip")).toHaveCount(0);
  await expect(page.locator(".inspector-strip")).toContainText("115 nodes");

  const slider = page.locator(".blend-control input");
  await slider.evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = "0.88";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });

  await page.locator(".geo-point-glow.card").first().focus();
  await expect(page.locator(".idea-tooltip")).toBeVisible();
  expect(await page.locator(".thread").count()).toBeGreaterThan(0);
});
