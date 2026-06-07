import { describe, expect, it } from "vitest";
import { interpolatePoint, normalizeHypoWeave, toPlacementInputs } from "../src/index.js";
import type { HypoWeaveExport } from "../src/index.js";

const fixture: HypoWeaveExport = {
  snapshot: {
    nodes: [
      {
        id: "root-a",
        type: "group",
        position: { x: 100, y: 200 },
        data: { label: "Root A", layoutTextBox: { text: "A" } }
      },
      {
        id: "child-a",
        type: "group",
        parentId: "root-a",
        position: { x: 50, y: -20 },
        data: { label: "Child A" }
      },
      {
        id: "card-a",
        type: "card",
        parentId: "child-a",
        position: { x: 12, y: 8 },
        data: { label: "Card A", layoutTextBox: { text: "Card" } }
      }
    ],
    edges: [{ source: "root-a", target: "card-a", type: "board" }]
  }
};

describe("normalizeHypoWeave", () => {
  it("resolves parent-relative positions and hierarchy metadata", () => {
    const graph = normalizeHypoWeave(fixture, {
      center: { lng: 85, lat: 28, label: "Nepal" }
    });
    const card = graph.nodes.find((node) => node.id === "card-a");

    expect(card?.semantic.x).toBe(162);
    expect(card?.semantic.y).toBe(188);
    expect(card?.depth).toBe(2);
    expect(card?.topAncestorId).toBe("root-a");
    expect(graph.edges).toHaveLength(1);
  });

  it("creates placement inputs for the backend boundary", () => {
    const graph = normalizeHypoWeave(fixture);
    expect(toPlacementInputs(graph)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "card-a", type: "card", depth: 2, topAncestorId: "root-a" })
      ])
    );
  });
});

describe("interpolatePoint", () => {
  it("interpolates semantic and geographic points", () => {
    const point = interpolatePoint(
      { x: 0, y: 0, lng: 10, lat: 20, altitude: 100 },
      { x: 10, y: 10, lng: 20, lat: 30, altitude: 0 },
      0.5
    );

    expect(point).toEqual({ x: 5, y: 5, lng: 15, lat: 25, altitude: 50 });
  });
});
