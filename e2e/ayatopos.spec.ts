import { expect, type Locator, type Page, test } from "@playwright/test";

test("loads the sample graph and supports map blending plus hover focus", async ({ page }) => {
  test.setTimeout(180_000);
  await routePlacements(page, "fallback");
  await page.goto("/");

  await expect(page.locator(".drop-zone")).toBeVisible();
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
  await expect(page.locator(".idea-tooltip").first()).toBeVisible();
  await expect(page.locator(".thread")).toHaveCount(0);
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
  await expect(page.locator(".idea-tooltip").first()).toBeVisible();
});

test("keeps map wheel zoom available over custom-layer hover affordances", async ({ page }) => {
  test.setTimeout(180_000);
  await routePlacements(page, "gemini");

  await page.goto("/");
  await page.locator(".secondary-action").click();
  await page.locator(".area-row input").fill("Nepal");
  await page.locator(".primary-action").click();

  await expect(page.locator(".map-canvas")).toHaveAttribute("data-terrain", "ready");
  await expect(page.locator(".geo-point-hit-target.card.mapped")).toHaveCount(65);

  const hitPoint = await visiblePointFor(page, ".geo-point-hit-target.card.mapped");
  await page.mouse.move(hitPoint.x, hitPoint.y);
  await expect(page.locator(".idea-tooltip").first()).toBeVisible();
  await expectWheelReachesMapAt(page, hitPoint);
  expect(await overlapCount(page, ".idea-tooltip", ".idea-tooltip")).toBe(0);
  expect(await overlapCount(page, ".idea-tooltip", ".geo-point-hit-target.related")).toBe(0);

  await expectElementWheelReachesMap(page, page.locator(".idea-tooltip").first());
});

test("allows card geographic coordinates to be edited and restored from local storage", async ({ page }) => {
  test.setTimeout(180_000);
  await routePlacements(page, "fallback");

  await page.goto("/");
  await page.locator(".secondary-action").click();
  await page.locator(".area-row input").fill("Nepal");
  await page.locator(".primary-action").click();

  await expect(page.locator(".geo-point-hit-target.card")).toHaveCount(65);
  await setBlend(page, "1");
  await page.getByTestId("geo-edit-toggle").click();
  await expect(page.locator(".geo-point-hit-target.card.geo-edit-target")).toHaveCount(65);

  const editableCard = page.locator(".geo-point-hit-target.card.geo-edit-target.depth-0").first();
  await editableCard.click();
  const lngInput = page.locator(".geo-edit-fields input").nth(0);
  const latInput = page.locator(".geo-edit-fields input").nth(1);
  const editedLng = (Number(await lngInput.inputValue()) + 0.000321).toFixed(6);
  const editedLat = (Number(await latInput.inputValue()) + 0.000123).toFixed(6);

  await lngInput.fill(editedLng);
  await latInput.fill(editedLat);
  await expect(page.locator(".geo-edit-panel")).toContainText("1 saved");

  const saved = await page.evaluate(() =>
    Object.entries(window.localStorage).find(([key]) => key.startsWith("ayatopos:manual-geo:"))
  );
  expect(saved?.[1]).toContain('"source":"manual"');

  await page.reload();
  await page.locator(".secondary-action").click();
  await page.locator(".area-row input").fill("Nepal");
  await page.locator(".primary-action").click();
  await setBlend(page, "1");
  await page.getByTestId("geo-edit-toggle").click();
  await expect(page.locator(".geo-edit-panel")).toContainText("1 saved");

  await editableCard.click();
  await expect(page.locator(".geo-edit-fields input").nth(0)).toHaveValue(editedLng);
  await expect(page.locator(".geo-edit-fields input").nth(1)).toHaveValue(editedLat);
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

async function setBlend(page: Page, value: string): Promise<void> {
  await page.locator(".blend-control input").evaluate(
    (element, nextValue) => {
      const input = element as HTMLInputElement;
      const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      valueSetter?.call(input, nextValue);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },
    value
  );
  await expect(page.locator(".blend-control input")).toHaveValue(value);
}

async function visiblePointFor(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const point = await page.locator(selector).evaluateAll((elements) => {
    for (const element of elements) {
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      if (
        rect.width > 0 &&
        rect.height > 0 &&
        x > 430 &&
        x < window.innerWidth - 120 &&
        y > 120 &&
        y < window.innerHeight - 150
      ) {
        return { x, y };
      }
    }
    return null;
  });

  if (!point) {
    throw new Error(`No visible point found for ${selector}`);
  }
  return point;
}

async function expectWheelReachesMapAt(page: Page, point: { x: number; y: number }): Promise<void> {
  const before = await mapCanvasWheelCount(page);
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, -700);
  await expect.poll(() => mapCanvasWheelCount(page), { timeout: 5_000 }).toBeGreaterThan(before);
}

async function expectElementWheelReachesMap(page: Page, locator: Locator): Promise<void> {
  const before = await mapCanvasWheelCount(page);
  await locator.evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -700 }));
  });
  await expect.poll(() => mapCanvasWheelCount(page), { timeout: 5_000 }).toBeGreaterThan(before);
}

async function mapCanvasWheelCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const windowWithCounter = window as Window & {
      ayatoposMapCanvasWheelCount?: number;
      ayatoposMapCanvasWheelListenerReady?: boolean;
    };
    if (!windowWithCounter.ayatoposMapCanvasWheelListenerReady) {
      windowWithCounter.ayatoposMapCanvasWheelCount = 0;
      document.querySelector(".map-canvas canvas")?.addEventListener("wheel", () => {
        windowWithCounter.ayatoposMapCanvasWheelCount = (windowWithCounter.ayatoposMapCanvasWheelCount ?? 0) + 1;
      });
      windowWithCounter.ayatoposMapCanvasWheelListenerReady = true;
    }
    return windowWithCounter.ayatoposMapCanvasWheelCount ?? 0;
  });
}

async function overlapCount(page: Page, selector: string, obstacleSelector: string): Promise<number> {
  return page.evaluate(
    ([tooltipSelector, targetSelector]) => {
      const rectsFor = (currentSelector: string) =>
        [...document.querySelectorAll(currentSelector)].map((element) => element.getBoundingClientRect());
      const tooltips = rectsFor(tooltipSelector);
      const targets = rectsFor(targetSelector);

      let overlaps = 0;
      tooltips.forEach((tooltip, tooltipIndex) => {
        targets.forEach((target, targetIndex) => {
          if (tooltipSelector === targetSelector && targetIndex <= tooltipIndex) return;
          const width = Math.max(0, Math.min(tooltip.right, target.right) - Math.max(tooltip.left, target.left));
          const height = Math.max(0, Math.min(tooltip.bottom, target.bottom) - Math.max(tooltip.top, target.top));
          if (width * height > 1) overlaps += 1;
        });
      });

      return overlaps;
    },
    [selector, obstacleSelector]
  );
}
