import { describe, expect, it } from "vitest";
import { createApp } from "./server.js";

const DEFAULT_LOCAL_RADIUS_METERS = 1500;
const METERS_PER_DEGREE_LAT = 111_320;

describe("AyaTopos API", () => {
  it("responds to health checks", async () => {
    const app = createApp();
    const response = await app.inject({ method: "GET", url: "/health" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true });
  });

  it("resolves preset areas without Gemini", async () => {
    const app = createApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/geo/resolve-area",
      payload: { areaText: "ネパール" }
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "resolved" });
  });

  it("creates fallback placements without Gemini", async () => {
    const app = createApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/geo/placements",
      payload: {
        areaText: "Nepal",
        center: { lng: 85, lat: 28, label: "Nepal" },
        nodes: [
          {
            id: "a",
            label: "A",
            shortLabel: "A",
            type: "group",
            depth: 0,
            topAncestorId: "a"
          }
        ]
      }
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      mode: "fallback",
      placements: [expect.objectContaining({ nodeId: "a", source: "fallback" })]
    });
    const body = response.json();
    const center = { lng: 85, lat: 28, label: "Nepal" };
    expect(distanceFromCenterMeters(body.placements[0].lng, body.placements[0].lat, center)).toBeLessThanOrEqual(
      DEFAULT_LOCAL_RADIUS_METERS + 1
    );
  });
});

function distanceFromCenterMeters(
  lng: number,
  lat: number,
  center: { lng: number; lat: number; label: string }
): number {
  const eastMeters = (lng - center.lng) * METERS_PER_DEGREE_LAT * Math.cos((center.lat * Math.PI) / 180);
  const northMeters = (lat - center.lat) * METERS_PER_DEGREE_LAT;
  return Math.hypot(eastMeters, northMeters);
}
