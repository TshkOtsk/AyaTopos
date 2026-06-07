export type HypoNodeType = "group" | "card" | string;

export interface HypoPosition {
  x: number;
  y: number;
}

export interface HypoWeaveNode {
  id: string;
  type?: HypoNodeType;
  position?: HypoPosition;
  parentId?: string;
  data?: {
    label?: string;
    kind?: string;
    w?: number;
    h?: number;
    layoutTextBox?: {
      text?: string;
      x?: number;
      y?: number;
    };
    layoutHullPoints?: Array<{ x: number; y: number }>;
    [key: string]: unknown;
  };
  width?: number;
  height?: number;
  hidden?: boolean;
  [key: string]: unknown;
}

export interface HypoWeaveEdge {
  source: string;
  target: string;
  type?: string;
  label?: string;
  [key: string]: unknown;
}

export interface HypoWeaveExport {
  version?: number;
  app?: string;
  snapshot?: {
    nodes?: HypoWeaveNode[];
    edges?: HypoWeaveEdge[];
  };
  ai?: {
    pickedSentenceByGroupId?: Record<string, string>;
    [key: string]: unknown;
  };
}

export interface GeoCenter {
  lng: number;
  lat: number;
  label: string;
}

export interface AyaSpatialPoint {
  x: number;
  y: number;
  lng: number;
  lat: number;
  altitude: number;
}

export interface AyaNode {
  id: string;
  type: "group" | "card";
  label: string;
  shortLabel: string;
  parentId?: string;
  depth: number;
  topAncestorId: string;
  semantic: AyaSpatialPoint;
  geo: AyaSpatialPoint;
  color: string;
  size: number;
  opacity: number;
}

export interface AyaEdge {
  id: string;
  source: string;
  target: string;
  type?: string;
}

export interface AyaGraph {
  nodes: AyaNode[];
  edges: AyaEdge[];
  center: GeoCenter;
  bounds: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  };
  maxDepth: number;
}

export interface GeoPlacement {
  nodeId: string;
  lng: number;
  lat: number;
  confidence: number;
  source: "gemini" | "fallback" | "preset";
}

export interface PlacementNodeInput {
  id: string;
  label: string;
  shortLabel: string;
  type: "group" | "card";
  depth: number;
  topAncestorId: string;
}

export interface ResolveAreaRequest {
  areaText: string;
}

export interface ResolveAreaResponse {
  status: "resolved" | "needsManualCenter";
  center?: GeoCenter;
}

export interface PlacementRequest {
  areaText: string;
  center: GeoCenter;
  nodes: PlacementNodeInput[];
}

export interface PlacementResponse {
  mode: "gemini" | "fallback";
  placements: GeoPlacement[];
}
