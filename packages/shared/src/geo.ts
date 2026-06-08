import type { AyaSpatialPoint, GeoCenter, GeoPlacement, PlacementNodeInput } from "./types.js";

export const DEFAULT_LOCAL_RADIUS_METERS = 1500;
const METERS_PER_DEGREE_LAT = 111_320;

export const DEFAULT_CENTER: GeoCenter = {
  lng: 85.324,
  lat: 27.7172,
  label: "Kathmandu, Nepal"
};

export const AREA_PRESETS: GeoCenter[] = [
  { lng: 85.324, lat: 27.7172, label: "Kathmandu, Nepal" },
  { lng: 84.124, lat: 28.3949, label: "Nepal" },
  { lng: 138.2529, lat: 36.2048, label: "Japan" },
  { lng: 139.7671, lat: 35.6812, label: "Tokyo, Japan" }
];

export function resolvePresetArea(areaText: string): GeoCenter | undefined {
  const normalized = areaText.trim().toLowerCase();
  if (!normalized) return undefined;
  return AREA_PRESETS.find((preset) => {
    const label = preset.label.toLowerCase();
    return label.includes(normalized) || normalized.includes(label) || normalized.includes("ネパール") && label.includes("nepal");
  });
}

export function parseManualCenter(areaText: string): GeoCenter | undefined {
  const match = areaText.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
  if (!match) return undefined;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return undefined;
  return { lat, lng, label: `${lat.toFixed(4)}, ${lng.toFixed(4)}` };
}

export function mapSemanticToGeo(
  x: number,
  y: number,
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
  center: GeoCenter,
  altitude: number
): AyaSpatialPoint {
  const spanX = Math.max(1, bounds.maxX - bounds.minX);
  const spanY = Math.max(1, bounds.maxY - bounds.minY);
  const nx = (x - bounds.minX) / spanX - 0.5;
  const ny = (y - bounds.minY) / spanY - 0.5;
  const point = offsetCenterByMeters(
    center,
    nx * DEFAULT_LOCAL_RADIUS_METERS * 2,
    -ny * DEFAULT_LOCAL_RADIUS_METERS * 2
  );
  const clamped = clampLngLatToLocalRadius(point.lng, point.lat, center);

  return {
    x,
    y,
    lng: clamped.lng,
    lat: clamped.lat,
    altitude
  };
}

export function interpolatePoint(
  semantic: AyaSpatialPoint,
  geo: AyaSpatialPoint,
  blend: number
): AyaSpatialPoint {
  const t = clamp(blend, 0, 1);
  return {
    x: semantic.x + (geo.x - semantic.x) * t,
    y: semantic.y + (geo.y - semantic.y) * t,
    lng: semantic.lng + (geo.lng - semantic.lng) * t,
    lat: semantic.lat + (geo.lat - semantic.lat) * t,
    altitude: semantic.altitude + (geo.altitude - semantic.altitude) * t
  };
}

export function createFallbackPlacements(nodes: PlacementNodeInput[], center: GeoCenter): GeoPlacement[] {
  const groups = groupBy(nodes, (node) => node.topAncestorId);
  const topKeys = Array.from(groups.keys()).sort();
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const groupPlacementById = new Map<string, { lng: number; lat: number }>();
  const cardsByAnchor = groupBy(
    nodes.filter((node) => node.type === "card"),
    (node) => nearestGroupAnchorId(node, nodesById) ?? node.topAncestorId
  );

  for (const node of nodes) {
    if (node.type === "card") continue;
    const point = fallbackRingPoint(node, center, groups, topKeys);
    groupPlacementById.set(node.id, clampLngLatToLocalRadius(point.lng, point.lat, center));
  }

  return nodes.map((node) => {
    const point =
      node.type === "card"
        ? fallbackCardPoint(node, center, nodesById, groupPlacementById, cardsByAnchor)
        : (groupPlacementById.get(node.id) ?? fallbackRingPoint(node, center, groups, topKeys));
    const clamped = clampLngLatToLocalRadius(point.lng, point.lat, center);

    return {
      nodeId: node.id,
      lng: clamped.lng,
      lat: clamped.lat,
      confidence: node.type === "card" ? 0.36 : 0.32,
      source: "fallback"
    };
  });
}

function fallbackRingPoint(
  node: PlacementNodeInput,
  center: GeoCenter,
  groups: Map<string, PlacementNodeInput[]>,
  topKeys: string[]
): { lng: number; lat: number } {
  const ringBase = 180;
  const ringStep = 155;
  const topIndex = Math.max(0, topKeys.indexOf(node.topAncestorId));
  const peers = groups.get(node.topAncestorId) ?? [];
  const peerIndex = Math.max(0, peers.findIndex((peer) => peer.id === node.id));
  const sector = (Math.PI * 2) / Math.max(1, topKeys.length);
  const angle =
    topIndex * sector +
    (seededUnit(node.id) - 0.5) * sector * 0.78 +
    ((peerIndex % 5) - 2) * 0.035;
  const radiusMeters = ringBase + node.depth * ringStep + (peerIndex % 9) * 34;
  const jitterMeters = (seededUnit(`${node.id}:jitter`) - 0.5) * 90;

  return offsetCenterByMeters(
    center,
    Math.cos(angle) * (radiusMeters + jitterMeters),
    Math.sin(angle) * (radiusMeters + jitterMeters)
  );
}

function fallbackCardPoint(
  node: PlacementNodeInput,
  center: GeoCenter,
  nodesById: Map<string, PlacementNodeInput>,
  groupPlacementById: Map<string, { lng: number; lat: number }>,
  cardsByAnchor: Map<string, PlacementNodeInput[]>
): { lng: number; lat: number } {
  const anchorId = nearestGroupAnchorId(node, nodesById);
  const anchorKey = anchorId ?? node.topAncestorId;
  const anchor = (anchorId ? groupPlacementById.get(anchorId) : undefined) ?? { lng: center.lng, lat: center.lat };
  const peers = cardsByAnchor.get(anchorKey) ?? [node];
  const peerIndex = Math.max(0, peers.findIndex((peer) => peer.id === node.id));
  const slots = Math.max(3, Math.min(10, peers.length));
  const angle =
    ((peerIndex % slots) / slots) * Math.PI * 2 +
    (seededUnit(`${node.id}:card-angle`) - 0.5) * 0.46 +
    Math.floor(peerIndex / slots) * 0.19;
  const radiusMeters =
    95 +
    Math.max(0, Math.min(4, node.depth - 1)) * 24 +
    Math.floor(peerIndex / slots) * 42 +
    (seededUnit(`${node.id}:card-radius`) - 0.5) * 28;

  return offsetCenterByMeters(
    { ...center, lng: anchor.lng, lat: anchor.lat },
    Math.cos(angle) * radiusMeters,
    Math.sin(angle) * radiusMeters
  );
}

function nearestGroupAnchorId(
  node: PlacementNodeInput,
  nodesById: Map<string, PlacementNodeInput>
): string | undefined {
  const seen = new Set<string>();
  let parentId = node.parentId;

  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = nodesById.get(parentId);
    if (!parent) return undefined;
    if (parent.type === "group") return parent.id;
    parentId = parent.parentId;
  }

  const topAncestor = nodesById.get(node.topAncestorId);
  return topAncestor?.type === "group" ? topAncestor.id : undefined;
}

export function clampGeoPlacementToLocalRadius(
  placement: GeoPlacement,
  center: GeoCenter,
  radiusMeters = DEFAULT_LOCAL_RADIUS_METERS
): GeoPlacement {
  const clamped = clampLngLatToLocalRadius(placement.lng, placement.lat, center, radiusMeters);
  return {
    ...placement,
    lng: clamped.lng,
    lat: clamped.lat
  };
}

export function distanceFromCenterMeters(lng: number, lat: number, center: GeoCenter): number {
  const local = lngLatToLocalMeters(lng, lat, center);
  return Math.hypot(local.eastMeters, local.northMeters);
}

function clampLngLatToLocalRadius(
  lng: number,
  lat: number,
  center: GeoCenter,
  radiusMeters = DEFAULT_LOCAL_RADIUS_METERS
): { lng: number; lat: number } {
  const local = lngLatToLocalMeters(lng, lat, center);
  const distance = Math.hypot(local.eastMeters, local.northMeters);
  if (distance <= radiusMeters || distance === 0) return { lng, lat };

  const ratio = radiusMeters / distance;
  return offsetCenterByMeters(center, local.eastMeters * ratio, local.northMeters * ratio);
}

function lngLatToLocalMeters(
  lng: number,
  lat: number,
  center: GeoCenter
): { eastMeters: number; northMeters: number } {
  return {
    eastMeters: (lng - center.lng) * metersPerDegreeLng(center.lat),
    northMeters: (lat - center.lat) * METERS_PER_DEGREE_LAT
  };
}

function offsetCenterByMeters(center: GeoCenter, eastMeters: number, northMeters: number): { lng: number; lat: number } {
  return {
    lng: center.lng + eastMeters / metersPerDegreeLng(center.lat),
    lat: center.lat + northMeters / METERS_PER_DEGREE_LAT
  };
}

function metersPerDegreeLng(lat: number): number {
  return Math.max(1, METERS_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function seededUnit(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const list = map.get(key) ?? [];
    list.push(item);
    map.set(key, list);
  }
  return map;
}
