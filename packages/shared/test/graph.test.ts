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
    expect(card?.geoPlacementSource).toBe("fallback");
    expect(card?.geoPlacementConfidence).toBeGreaterThan(0);
    expect(card?.geo.lng).not.toBeCloseTo(card?.semantic.lng ?? 0, 6);
    expect(card?.geo.lat).not.toBeCloseTo(card?.semantic.lat ?? 0, 6);
    expect(graph.edges).toHaveLength(1);
  });

  it("accepts exports with the snapshot nested under workspaces.board", () => {
    const graph = normalizeHypoWeave({
      version: 2,
      app: "HypoWeave",
      workspaces: {
        board: {
          snapshot: fixture.snapshot
        }
      }
    });

    expect(graph.nodes.map((node) => node.id)).toEqual(["root-a", "child-a", "card-a"]);
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
    expect(graph.nodes.find((node) => node.id === "card-a")?.geoPlacementSource).toBe("gemini");
  });

  it("keeps manual geographic placements at the user supplied coordinates", () => {
    const center = { lng: 85, lat: 28, label: "Nepal" };
    const graph = normalizeHypoWeave(fixture, {
      center,
      placements: [{ nodeId: "card-a", lng: 88, lat: 31, confidence: 1, source: "manual" }]
    });
    const card = graph.nodes.find((node) => node.id === "card-a");

    expect(card?.geoPlacementSource).toBe("manual");
    expect(card?.geoPlacementConfidence).toBe(1);
    expect(card?.geo.lng).toBe(88);
    expect(card?.geo.lat).toBe(31);
    expect(distanceFromCenterMeters(card!.geo.lng, card!.geo.lat, center)).toBeGreaterThan(
      DEFAULT_LOCAL_RADIUS_METERS
    );
  });

  it("keeps preset geographic placements at the supplied coordinates", () => {
    const center = { lng: 85, lat: 28, label: "Nepal" };
    const graph = normalizeHypoWeave(fixture, {
      center,
      placements: [{ nodeId: "card-a", lng: 88, lat: 31, confidence: 1, source: "preset" }]
    });
    const card = graph.nodes.find((node) => node.id === "card-a");

    expect(card?.geoPlacementSource).toBe("preset");
    expect(card?.geoPlacementConfidence).toBe(1);
    expect(card?.geo.lng).toBe(88);
    expect(card?.geo.lat).toBe(31);
    expect(distanceFromCenterMeters(card!.geo.lng, card!.geo.lat, center)).toBeGreaterThan(
      DEFAULT_LOCAL_RADIUS_METERS
    );
  });

  it("centers group geographic positions on descendant placed cards", () => {
    const center = { lng: 85, lat: 28, label: "Nepal" };
    const graph = normalizeHypoWeave(
      {
        snapshot: {
          nodes: [
            { id: "root", type: "group", position: { x: 0, y: 0 }, data: { label: "Root" } },
            { id: "group-a", type: "group", parentId: "root", position: { x: 20, y: 20 }, data: { label: "Group A" } },
            { id: "card-a", type: "card", parentId: "group-a", position: { x: 10, y: 0 }, data: { label: "Card A" } },
            { id: "card-b", type: "card", parentId: "group-a", position: { x: 30, y: 0 }, data: { label: "Card B" } },
            { id: "card-c", type: "card", parentId: "group-a", position: { x: 50, y: 0 }, data: { label: "Card C" } }
          ]
        }
      },
      {
        center,
        placements: [
          { nodeId: "card-a", lng: 85.01, lat: 28.02, confidence: 0.9, source: "gemini" },
          { nodeId: "card-b", lng: 85.03, lat: 28.04, confidence: 0.9, source: "gemini" }
        ]
      }
    );
    const root = graph.nodes.find((node) => node.id === "root");
    const group = graph.nodes.find((node) => node.id === "group-a");
    const cardA = graph.nodes.find((node) => node.id === "card-a");
    const cardB = graph.nodes.find((node) => node.id === "card-b");
    const cardC = graph.nodes.find((node) => node.id === "card-c");

    expect(group?.geo.lng).toBeCloseTo((cardA!.geo.lng + cardB!.geo.lng) / 2, 6);
    expect(group?.geo.lat).toBeCloseTo((cardA!.geo.lat + cardB!.geo.lat) / 2, 6);
    expect(root?.geo.lng).toBeCloseTo(group!.geo.lng, 6);
    expect(root?.geo.lat).toBeCloseTo(group!.geo.lat, 6);
    expect(cardC?.geoPlacementSource).toBe("fallback");
    expect(group?.geo.lng).not.toBeCloseTo(cardC!.geo.lng, 6);
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
        expect.objectContaining({ id: "card-a", type: "card", depth: 2, topAncestorId: "root-a", parentId: "child-a" })
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
        { id: "b", label: "B", shortLabel: "B", type: "card", depth: 7, topAncestorId: "a", parentId: "a" }
      ],
      center
    );

    for (const placement of placements) {
      expect(distanceFromCenterMeters(placement.lng, placement.lat, center)).toBeLessThanOrEqual(
        DEFAULT_LOCAL_RADIUS_METERS + 1
      );
    }
  });

  it("places fallback cards near their parent group instead of leaving them on the semantic point", () => {
    const center = { lng: 85, lat: 28, label: "Nepal" };
    const placements = createFallbackPlacements(
      [
        { id: "root", label: "Root", shortLabel: "Root", type: "group", depth: 0, topAncestorId: "root" },
        {
          id: "card",
          label: "Card",
          shortLabel: "Card",
          type: "card",
          depth: 1,
          topAncestorId: "root",
          parentId: "root"
        }
      ],
      center
    );
    const root = placements.find((placement) => placement.nodeId === "root");
    const card = placements.find((placement) => placement.nodeId === "card");

    expect(card?.source).toBe("fallback");
    expect(card?.confidence).toBeGreaterThan(root?.confidence ?? 0);
    expect(Math.hypot((card!.lng - root!.lng) * 98_000, (card!.lat - root!.lat) * 111_320)).toBeLessThan(260);
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
