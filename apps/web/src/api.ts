import type { GeoCenter, GeoPlacement, PlacementResponse, ResolveAreaResponse } from "@ayatopos/shared";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

export async function resolveArea(areaText: string): Promise<ResolveAreaResponse> {
  return postJson("/api/geo/resolve-area", { areaText });
}

export async function requestPlacements(input: {
  areaText: string;
  center: GeoCenter;
  nodes: Array<{
    id: string;
    label: string;
    shortLabel: string;
    type: "group" | "card";
    depth: number;
    topAncestorId: string;
  }>;
}): Promise<PlacementResponse & { placements: GeoPlacement[] }> {
  return postJson("/api/geo/placements", input);
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as T;
}
