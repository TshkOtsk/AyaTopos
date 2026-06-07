import { describe, expect, it } from "vitest";
import {
  createFallbackPlacements,
  DEFAULT_LOCAL_RADIUS_METERS,
  distanceFromCenterMeters,
  interpolatePoint,
  normalizeHypoWeave,
  toPlacementInputs
} from "../src/index.js";
import type { HypoWeaveExport } from "../src/index.js";

const fixture: HypoWeaveExport = {
  snapshot: {
    nodes: [
      {
        id: "root-a",
        type: "group",
        position: { x: 100, y: 200 },
        data: {
          label: "Root A",
          layoutTextBox: { text: "A" },
          w: 100,
          h: 80,
          layoutHullPoints: [
            { x: 0, y: 0 },
            { x: 100, y: 0 },
            { x: 100, y: 100 },
            { x: 0, y: 100 }
          ]
        }
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

  it("keeps semantic and geographic placements inside the local radius", () => {
    const center = { lng: 85, lat: 28, label: "Nepal" };
    const graph = normalizeHypoWeave(fixture, {
      center,
      placements: [{ nodeId: "card-a", lng: 88, lat: 31, confidence: 0.9, source: "gemini" }]
    });

    for (const node of graph.nodes) {
      expect(distanceFromCenterMeters(node.semantic.lng, node.semantic.lat, center)).toBeLessThanOrEqual(
        DEFAULT_LOCAL_RADIUS_METERS + 1
      );
      expect(distanceFromCenterMeters(node.geo.lng, node.geo.lat, center)).toBeLessThanOrEqual(
        DEFAULT_LOCAL_RADIUS_METERS + 1
      );
    }
  });

  it("creates group outlines from hull data and descendant bounds", () => {
    const graph = normalizeHypoWeave(fixture);
    const rootOutline = graph.outlines.find((outline) => outline.groupId === "root-a");
    const childOutline = graph.outlines.find((outline) => outline.groupId === "child-a");

    expect(rootOutline?.points).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ x: 100, y: 200 }),
        expect.objectContaining({ x: 200, y: 280 })
      ])
    );
    expect(childOutline?.points).toHaveLength(4);
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

describe("createFallbackPlacements", () => {
  it("keeps fallback placements inside the local radius", () => {
    const center = { lng: 85, lat: 28, label: "Nepal" };
    const placements = createFallbackPlacements(
      [
        { id: "a", label: "A", shortLabel: "A", type: "group", depth: 0, topAncestorId: "a" },
        { id: "b", label: "B", shortLabel: "B", type: "card", depth: 7, topAncestorId: "a" }
      ],
      center
    );

    for (const placement of placements) {
      expect(distanceFromCenterMeters(placement.lng, placement.lat, center)).toBeLessThanOrEqual(
        DEFAULT_LOCAL_RADIUS_METERS + 1
      );
    }
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
