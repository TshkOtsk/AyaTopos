import { describe, expect, it } from "vitest";
import { createApp } from "./server.js";

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
  });
});
