import type { AyaSpatialPoint, GeoCenter, GeoPlacement, PlacementNodeInput } from "./types.js";

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
  const lngScale = 1.15;
  const latScale = 0.76;
  return {
    x,
    y,
    lng: center.lng + nx * lngScale,
    lat: center.lat - ny * latScale,
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
  const ringBase = 0.34;
  const ringStep = 0.14;

  return nodes.map((node) => {
    const topIndex = Math.max(0, topKeys.indexOf(node.topAncestorId));
    const peers = groups.get(node.topAncestorId) ?? [];
    const peerIndex = Math.max(0, peers.findIndex((peer) => peer.id === node.id));
    const sector = (Math.PI * 2) / Math.max(1, topKeys.length);
    const angle =
      topIndex * sector +
      (seededUnit(node.id) - 0.5) * sector * 0.78 +
      ((peerIndex % 5) - 2) * 0.035;
    const radius = ringBase + node.depth * ringStep + (peerIndex % 9) * 0.035;
    const jitter = (seededUnit(`${node.id}:jitter`) - 0.5) * 0.08;

    return {
      nodeId: node.id,
      lng: center.lng + Math.cos(angle) * (radius + jitter),
      lat: center.lat + Math.sin(angle) * (radius * 0.72 + jitter),
      confidence: 0.32,
      source: "fallback"
    };
  });
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
