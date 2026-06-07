export const resolveAreaRequestSchema = {
  type: "object",
  required: ["areaText"],
  additionalProperties: false,
  properties: {
    areaText: { type: "string", minLength: 1 }
  }
} as const;

export const placementRequestSchema = {
  type: "object",
  required: ["areaText", "center", "nodes"],
  additionalProperties: false,
  properties: {
    areaText: { type: "string", minLength: 1 },
    center: {
      type: "object",
      required: ["lng", "lat", "label"],
      additionalProperties: false,
      properties: {
        lng: { type: "number", minimum: -180, maximum: 180 },
        lat: { type: "number", minimum: -90, maximum: 90 },
        label: { type: "string" }
      }
    },
    nodes: {
      type: "array",
      maxItems: 300,
      items: {
        type: "object",
        required: ["id", "label", "shortLabel", "type", "depth", "topAncestorId"],
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          shortLabel: { type: "string" },
          type: { type: "string", enum: ["group", "card"] },
          depth: { type: "number", minimum: 0 },
          topAncestorId: { type: "string" }
        }
      }
    }
  }
} as const;

export const placementsResponseSchema = {
  type: "object",
  required: ["placements"],
  properties: {
    placements: {
      type: "array",
      items: {
        type: "object",
        required: ["nodeId", "lng", "lat", "confidence"],
        properties: {
          nodeId: { type: "string" },
          lng: { type: "number" },
          lat: { type: "number" },
          confidence: { type: "number" }
        }
      }
    }
  }
} as const;
