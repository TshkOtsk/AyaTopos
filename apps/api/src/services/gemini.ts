import { GoogleGenAI, Type } from "@google/genai";
import type { GeoCenter, GeoPlacement, PlacementRequest } from "@ayatopos/shared";

interface GeminiAreaResponse {
  lng?: number;
  lat?: number;
  label?: string;
}

interface GeminiPlacementsResponse {
  placements?: Array<{
    nodeId?: string;
    lng?: number;
    lat?: number;
    confidence?: number;
  }>;
}

export async function resolveAreaWithGemini(areaText: string): Promise<GeoCenter | undefined> {
  const client = createGeminiClient();
  if (!client) return undefined;

  try {
    const response = await client.models.generateContent({
      model: modelName(),
      contents: [
        "Resolve this place name to one approximate WGS84 center point.",
        "Return only JSON matching the schema. If uncertain, choose the most likely research/geographic area.",
        `Area: ${areaText}`
      ].join("\n"),
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          required: ["lng", "lat", "label"],
          properties: {
            lng: { type: Type.NUMBER },
            lat: { type: Type.NUMBER },
            label: { type: Type.STRING }
          }
        }
      }
    });

    const parsed = parseJson<GeminiAreaResponse>(response.text ?? "");
    const lng = parsed?.lng;
    const lat = parsed?.lat;
    const label = parsed?.label;
    if (typeof lng !== "number" || typeof lat !== "number" || !isLngLat(lng, lat) || !label) return undefined;
    return { lng, lat, label };
  } catch {
    return undefined;
  }
}

export async function generateGeoPlacements(request: PlacementRequest): Promise<GeoPlacement[] | undefined> {
  const client = createGeminiClient();
  if (!client) return undefined;

  const nodeSummary = request.nodes.map((node) => ({
    id: node.id,
    label: node.label.slice(0, 180),
    shortLabel: node.shortLabel.slice(0, 80),
    type: node.type,
    depth: node.depth,
    topAncestorId: node.topAncestorId
  }));

  try {
    const response = await client.models.generateContent({
      model: modelName(),
      contents: [
        "Place KJ-method discussion nodes around the requested geographic area.",
        "Use rough, plausible coordinates near the center. Abstract nodes may stay close to the center.",
        "Return one placement for each node id. Do not explain meanings.",
        `Area: ${request.areaText}`,
        `Center: ${JSON.stringify(request.center)}`,
        `Nodes: ${JSON.stringify(nodeSummary)}`
      ].join("\n"),
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          required: ["placements"],
          properties: {
            placements: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                required: ["nodeId", "lng", "lat", "confidence"],
                properties: {
                  nodeId: { type: Type.STRING },
                  lng: { type: Type.NUMBER },
                  lat: { type: Type.NUMBER },
                  confidence: { type: Type.NUMBER }
                }
              }
            }
          }
        }
      }
    });

    const parsed = parseJson<GeminiPlacementsResponse>(response.text ?? "");
    const allowed = new Set(request.nodes.map((node) => node.id));
    const placements = (parsed?.placements ?? [])
      .filter((placement) => placement.nodeId && allowed.has(placement.nodeId))
      .filter((placement) => isLngLat(placement.lng, placement.lat))
      .map((placement) => ({
        nodeId: placement.nodeId!,
        lng: placement.lng!,
        lat: placement.lat!,
        confidence: clamp(placement.confidence ?? 0.5, 0, 1),
        source: "gemini" as const
      }));

    return placements.length > 0 ? placements : undefined;
  } catch {
    return undefined;
  }
}

function createGeminiClient(): GoogleGenAI | undefined {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return undefined;
  return new GoogleGenAI({ apiKey });
}

function modelName(): string {
  return process.env.GEMINI_MODEL ?? "gemini-3.5-flash";
}

function parseJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function isLngLat(lng: unknown, lat: unknown): boolean {
  return (
    typeof lng === "number" &&
    typeof lat === "number" &&
    Number.isFinite(lng) &&
    Number.isFinite(lat) &&
    Math.abs(lng) <= 180 &&
    Math.abs(lat) <= 90
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
