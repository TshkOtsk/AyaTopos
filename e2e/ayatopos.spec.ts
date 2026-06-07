import { expect, type Page, test } from "@playwright/test";

test("loads the sample graph and supports map blending plus hover focus", async ({ page }) => {
  test.setTimeout(180_000);
  await routePlacements(page, "fallback");
  await page.goto("/");

  await expect(page.locator(".brand")).toContainText("AyaTopos");
  await page.locator(".secondary-action").click();
  await page.locator(".area-row input").fill("Nepal");
  await page.locator(".primary-action").click();

  await expect(page.locator(".map-canvas")).toHaveAttribute("data-terrain", "ready");
  await expect(page.locator(".idea-hit-target.card")).toHaveCount(0);
  await expect(page.locator(".idea-hit-target")).toHaveCount(0);
  await expect(page.locator(".card-stem")).toHaveCount(0);
  await expect(page.locator(".node-card")).toHaveCount(0);
  await expect(page.locator(".map-canvas canvas")).toHaveCount(1);
  await expect(page.locator(".geo-point-glow")).toHaveCount(0);
  await expect(page.locator(".geo-point-hit-target")).toHaveCount(115);
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

  await page.locator(".geo-point-hit-target.card").first().focus();
  await expect(page.locator(".idea-tooltip")).toBeVisible();
  expect(await page.locator(".thread").count()).toBeGreaterThan(0);
});

test("renders node glows inside the MapLibre custom layer while keeping DOM hit targets", async ({ page }) => {
  test.setTimeout(180_000);
  await routePlacements(page, "gemini");

  await page.goto("/");
  await page.locator(".secondary-action").click();
  await page.locator(".area-row input").fill("Nepal");
  await page.locator(".primary-action").click();

  await expect(page.locator(".map-canvas")).toHaveAttribute("data-terrain", "ready");
  await expect(page.locator(".map-canvas canvas")).toHaveCount(1);
  await expect(page.locator(".geo-point-glow")).toHaveCount(0);
  await expect(page.locator(".geo-point-hit-target.card.mapped")).toHaveCount(65);
  await expect(page.locator(".geo-point-hit-target.group.mapped")).toHaveCount(50);
  await expect(page.locator(".geo-point-hit-target")).toHaveCount(115);

  await page.locator(".geo-point-hit-target.card.mapped").first().focus();
  await expect(page.locator(".idea-tooltip")).toBeVisible();
});

async function routePlacements(page: Page, source: "fallback" | "gemini"): Promise<void> {
  await page.route("**/api/geo/placements", async (route) => {
    const body = route.request().postDataJSON() as {
      center: { lng: number; lat: number };
      nodes: Array<{ id: string }>;
    };
    const placements = body.nodes.map((node, index) => ({
      nodeId: node.id,
      lng: body.center.lng + ((index % 9) - 4) * 0.0014,
      lat: body.center.lat + (Math.floor(index / 9) - 6) * 0.0011,
      confidence: 0.91,
      source
    }));

    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ mode: source, placements })
    });
  });
}
