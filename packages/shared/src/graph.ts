import { clampGeoPlacementToLocalRadius, createFallbackPlacements, DEFAULT_CENTER, mapSemanticToGeo } from "./geo.js";
import type {
  AyaEdge,
  AyaGraph,
  AyaGroupOutline,
  AyaNode,
  AyaSpatialPoint,
  GeoCenter,
  GeoPlacement,
  HypoWeaveExport,
  HypoWeaveNode,
  HypoWeaveSnapshot,
  PlacementNodeInput
} from "./types.js";

const PALETTE = ["#f26d5b", "#77b255", "#5aa9df", "#ba75d6", "#e4ac35", "#58b5a8", "#f08ab8", "#8f91e8"];

export interface NormalizeOptions {
  center?: GeoCenter;
  placements?: GeoPlacement[];
}

export function normalizeHypoWeave(input: HypoWeaveExport, options: NormalizeOptions = {}): AyaGraph {
  const center = options.center ?? DEFAULT_CENTER;
  const snapshot = getHypoWeaveSnapshot(input);
  const rawNodes = snapshot.nodes.filter((node) => !node.hidden);
  const byId = new Map(rawNodes.map((node) => [node.id, node]));
  const absoluteCache = new Map<string, { x: number; y: number }>();
  const depthCache = new Map<string, number>();
  const topCache = new Map<string, string>();

  const absolutePositions = rawNodes.map((node) => absolutePosition(node, byId, absoluteCache));
  const bounds = getBounds(absolutePositions);
  const maxDepth = rawNodes.reduce((max, node) => Math.max(max, depthOf(node, byId, depthCache)), 0);
  const placementMap = new Map(
    (options.placements ?? []).map((placement) => [
      placement.nodeId,
      placement.source === "manual" ? placement : clampGeoPlacementToLocalRadius(placement, center)
    ])
  );

  const topOrder = Array.from(
    new Set(rawNodes.map((node) => topAncestorOf(node, byId, topCache)).filter(Boolean))
  ).sort();

  const baseNodes: AyaNode[] = rawNodes.map((node) => {
    const position = absolutePosition(node, byId, absoluteCache);
    const depth = depthOf(node, byId, depthCache);
    const topAncestorId = topAncestorOf(node, byId, topCache);
    const semanticAltitude = (maxDepth - depth + 1) * 55;
    const semantic = mapSemanticToGeo(position.x, position.y, bounds, center, semanticAltitude);
    const fallbackPlacement = fallbackPlacementForNode(node, center, rawNodes, byId);
    const placement = placementMap.get(node.id) ?? fallbackPlacement;
    const geo = {
      x: position.x,
      y: position.y,
      lng: placement.lng,
      lat: placement.lat,
      altitude: depth <= 1 ? semanticAltitude : Math.max(0, semanticAltitude * 0.22)
    };

    return {
      id: node.id,
      type: node.type === "card" ? "card" : "group",
      label: labelOf(node, input),
      shortLabel: shortLabelOf(node, input),
      parentId: node.parentId,
      depth,
      topAncestorId,
      semantic,
      geo,
      geoPlacementSource: placement.source,
      geoPlacementConfidence: placement.confidence,
      color: colorForTopAncestor(topAncestorId, topOrder),
      size: sizeFor(node, depth),
      opacity: opacityFor(depth)
    };
  });
  const nodes = centerGroupGeoOnDescendantCards(baseNodes);
  const outlines = createGroupOutlines(rawNodes, byId, absoluteCache, depthCache, topCache, bounds, center, topOrder);

  return {
    nodes,
    edges: normalizeEdges(input),
    outlines,
    center,
    bounds,
    maxDepth
  };
}

export function toPlacementInputs(graph: AyaGraph): PlacementNodeInput[] {
  return graph.nodes.map((node) => ({
    id: node.id,
    label: node.label,
    shortLabel: node.shortLabel,
    type: node.type,
    depth: node.depth,
    topAncestorId: node.topAncestorId,
    parentId: node.parentId
  }));
}

export function getHypoWeaveSnapshot(input: HypoWeaveExport): Required<HypoWeaveSnapshot> {
  const snapshot = input.snapshot ?? input.workspaces?.board?.snapshot ?? firstWorkspaceSnapshot(input);
  return {
    nodes: snapshot?.nodes ?? [],
    edges: snapshot?.edges ?? []
  };
}

export function connectedIds(edges: AyaEdge[], nodeId: string): Set<string> {
  const ids = new Set<string>([nodeId]);
  for (const edge of edges) {
    if (edge.source === nodeId) ids.add(edge.target);
    if (edge.target === nodeId) ids.add(edge.source);
  }
  return ids;
}

function absolutePosition(
  node: HypoWeaveNode,
  byId: Map<string, HypoWeaveNode>,
  cache: Map<string, { x: number; y: number }>
): { x: number; y: number } {
  const cached = cache.get(node.id);
  if (cached) return cached;

  const own = node.position ?? { x: 0, y: 0 };
  const parent = node.parentId ? byId.get(node.parentId) : undefined;
  const parentPosition = parent ? absolutePosition(parent, byId, cache) : { x: 0, y: 0 };
  const value = { x: parentPosition.x + own.x, y: parentPosition.y + own.y };
  cache.set(node.id, value);
  return value;
}

function depthOf(node: HypoWeaveNode, byId: Map<string, HypoWeaveNode>, cache: Map<string, number>): number {
  const cached = cache.get(node.id);
  if (cached !== undefined) return cached;
  const parent = node.parentId ? byId.get(node.parentId) : undefined;
  const depth = parent ? depthOf(parent, byId, cache) + 1 : 0;
  cache.set(node.id, depth);
  return depth;
}

function topAncestorOf(node: HypoWeaveNode, byId: Map<string, HypoWeaveNode>, cache: Map<string, string>): string {
  const cached = cache.get(node.id);
  if (cached) return cached;
  let current = node;
  while (current.parentId && byId.has(current.parentId)) {
    current = byId.get(current.parentId)!;
  }
  cache.set(node.id, current.id);
  return current.id;
}

function getBounds(points: Array<{ x: number; y: number }>): AyaGraph["bounds"] {
  if (points.length === 0) {
    return { minX: -1, maxX: 1, minY: -1, maxY: 1 };
  }
  return points.reduce(
    (bounds, point) => ({
      minX: Math.min(bounds.minX, point.x),
      maxX: Math.max(bounds.maxX, point.x),
      minY: Math.min(bounds.minY, point.y),
      maxY: Math.max(bounds.maxY, point.y)
    }),
    { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
  );
}

function createGroupOutlines(
  rawNodes: HypoWeaveNode[],
  byId: Map<string, HypoWeaveNode>,
  absoluteCache: Map<string, { x: number; y: number }>,
  depthCache: Map<string, number>,
  topCache: Map<string, string>,
  bounds: AyaGraph["bounds"],
  center: GeoCenter,
  topOrder: string[]
): AyaGroupOutline[] {
  return rawNodes
    .filter((node) => node.type !== "card")
    .map((node) => {
      const points = outlinePointsForGroup(node, rawNodes, byId, absoluteCache);
      if (points.length < 3) return undefined;
      const depth = depthOf(node, byId, depthCache);
      const topAncestorId = topAncestorOf(node, byId, topCache);
      const spatialPoints = points.map((point) => semanticOutlinePoint(point, bounds, center));

      return {
        id: `${node.id}:outline`,
        groupId: node.id,
        depth,
        topAncestorId,
        color: colorForTopAncestor(topAncestorId, topOrder),
        points: spatialPoints
      } satisfies AyaGroupOutline;
    })
    .filter((outline): outline is AyaGroupOutline => Boolean(outline));
}

function outlinePointsForGroup(
  node: HypoWeaveNode,
  rawNodes: HypoWeaveNode[],
  byId: Map<string, HypoWeaveNode>,
  absoluteCache: Map<string, { x: number; y: number }>
): Array<{ x: number; y: number }> {
  const position = absolutePosition(node, byId, absoluteCache);
  const width = nodeWidth(node);
  const height = nodeHeight(node);
  const hull = node.data?.layoutHullPoints;

  if (hull && hull.length >= 3 && width > 0 && height > 0) {
    return hull.map((point) => ({
      x: position.x + (point.x / 100) * width,
      y: position.y + (point.y / 100) * height
    }));
  }

  const descendants = rawNodes.filter((item) => item.id !== node.id && isDescendantOf(item, node.id, byId));
  const boxes = (descendants.length > 0 ? descendants : [node]).map((item) => nodeBox(item, byId, absoluteCache));
  const outlineBounds = boxes.reduce(
    (value, box) => ({
      minX: Math.min(value.minX, box.minX),
      maxX: Math.max(value.maxX, box.maxX),
      minY: Math.min(value.minY, box.minY),
      maxY: Math.max(value.maxY, box.maxY)
    }),
    { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
  );
  const padding = 72;

  return [
    { x: outlineBounds.minX - padding, y: outlineBounds.minY - padding },
    { x: outlineBounds.maxX + padding, y: outlineBounds.minY - padding },
    { x: outlineBounds.maxX + padding, y: outlineBounds.maxY + padding },
    { x: outlineBounds.minX - padding, y: outlineBounds.maxY + padding }
  ];
}

function semanticOutlinePoint(
  point: { x: number; y: number },
  bounds: AyaGraph["bounds"],
  center: GeoCenter
): AyaSpatialPoint {
  return mapSemanticToGeo(point.x, point.y, bounds, center, 0);
}

function nodeBox(
  node: HypoWeaveNode,
  byId: Map<string, HypoWeaveNode>,
  absoluteCache: Map<string, { x: number; y: number }>
): { minX: number; maxX: number; minY: number; maxY: number } {
  const position = absolutePosition(node, byId, absoluteCache);
  const width = nodeWidth(node);
  const height = nodeHeight(node);
  return {
    minX: position.x,
    maxX: position.x + width,
    minY: position.y,
    maxY: position.y + height
  };
}

function nodeWidth(node: HypoWeaveNode): number {
  return numberOrDefault(node.width, numberOrDefault(node.data?.w, node.type === "card" ? 620 : 360));
}

function nodeHeight(node: HypoWeaveNode): number {
  return numberOrDefault(node.height, numberOrDefault(node.data?.h, node.type === "card" ? 220 : 220));
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isDescendantOf(node: HypoWeaveNode, ancestorId: string, byId: Map<string, HypoWeaveNode>): boolean {
  let parentId = node.parentId;
  while (parentId) {
    if (parentId === ancestorId) return true;
    parentId = byId.get(parentId)?.parentId;
  }
  return false;
}

function normalizeEdges(input: HypoWeaveExport): AyaEdge[] {
  return getHypoWeaveSnapshot(input).edges.map((edge, index) => ({
    id: `${edge.source}->${edge.target}:${index}`,
    source: edge.source,
    target: edge.target,
    type: edge.type
  }));
}

function firstWorkspaceSnapshot(input: HypoWeaveExport): HypoWeaveSnapshot | undefined {
  return Object.values(input.workspaces ?? {}).find((workspace) => workspace.snapshot?.nodes?.length)?.snapshot;
}

function labelOf(node: HypoWeaveNode, input: HypoWeaveExport): string {
  return node.data?.label ?? input.ai?.pickedSentenceByGroupId?.[node.id] ?? node.id;
}

function shortLabelOf(node: HypoWeaveNode, input: HypoWeaveExport): string {
  return node.data?.layoutTextBox?.text ?? input.ai?.pickedSentenceByGroupId?.[node.id] ?? labelOf(node, input);
}

function colorForTopAncestor(topAncestorId: string, topOrder: string[]): string {
  const index = Math.max(0, topOrder.indexOf(topAncestorId));
  return PALETTE[index % PALETTE.length] ?? PALETTE[0]!;
}

function sizeFor(node: HypoWeaveNode, depth: number): number {
  if (depth === 0) return 176;
  if (node.type === "group") return Math.max(96, 152 - depth * 11);
  return Math.max(78, 124 - depth * 7);
}

function opacityFor(depth: number): number {
  return Math.max(0.44, 1 - depth * 0.075);
}

function centerGroupGeoOnDescendantCards(nodes: AyaNode[]): AyaNode[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const allCardsByAncestor = new Map<string, AyaNode[]>();
  const placedCardsByAncestor = new Map<string, AyaNode[]>();

  for (const node of nodes) {
    if (node.type !== "card") continue;

    forEachAncestor(node, nodeById, (ancestorId) => {
      addCardForAncestor(allCardsByAncestor, ancestorId, node);
      if (isPlacedCard(node)) {
        addCardForAncestor(placedCardsByAncestor, ancestorId, node);
      }
    });
  }

  return nodes.map((node) => {
    if (node.type === "card") return node;

    const descendantCards = placedCardsByAncestor.get(node.id) ?? allCardsByAncestor.get(node.id);
    if (!descendantCards?.length) return node;

    return {
      ...node,
      geo: {
        ...node.geo,
        x: average(descendantCards.map((card) => card.geo.x)),
        y: average(descendantCards.map((card) => card.geo.y)),
        lng: average(descendantCards.map((card) => card.geo.lng)),
        lat: average(descendantCards.map((card) => card.geo.lat))
      }
    };
  });
}

function forEachAncestor(
  node: AyaNode,
  nodeById: Map<string, AyaNode>,
  visit: (ancestorId: string) => void
): void {
  const seen = new Set<string>();
  let parentId = node.parentId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    visit(parentId);
    parentId = nodeById.get(parentId)?.parentId;
  }
}

function addCardForAncestor(map: Map<string, AyaNode[]>, ancestorId: string, card: AyaNode): void {
  const cards = map.get(ancestorId) ?? [];
  cards.push(card);
  map.set(ancestorId, cards);
}

function isPlacedCard(node: AyaNode): boolean {
  return node.type === "card" && node.geoPlacementSource !== "fallback";
}

function average(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function fallbackPlacementForNode(
  node: HypoWeaveNode,
  center: GeoCenter,
  rawNodes: HypoWeaveNode[],
  byId: Map<string, HypoWeaveNode>
): GeoPlacement {
  const inputs = rawNodes.map((item) => {
    const topCache = new Map<string, string>();
    const depthCache = new Map<string, number>();
    return {
      id: item.id,
      label: labelOf(item, {}),
      shortLabel: shortLabelOf(item, {}),
      type: item.type === "card" ? "card" : "group",
      depth: depthOf(item, byId, depthCache),
      topAncestorId: topAncestorOf(item, byId, topCache),
      parentId: item.parentId
    } satisfies PlacementNodeInput;
  });
  const placement = createFallbackPlacements(inputs, center).find((item) => item.nodeId === node.id);
  return (
    placement ?? {
      nodeId: node.id,
      lng: center.lng,
      lat: center.lat,
      confidence: 0,
      source: "fallback"
    }
  );
}
