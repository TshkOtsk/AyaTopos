import cors from "@fastify/cors";
import fastify from "fastify";
import {
  clampGeoPlacementToLocalRadius,
  createFallbackPlacements,
  parseManualCenter,
  placementRequestSchema,
  resolveAreaRequestSchema,
  resolvePresetArea
} from "@ayatopos/shared";
import type { PlacementRequest, ResolveAreaRequest } from "@ayatopos/shared";
import { generateGeoPlacements, resolveAreaWithGemini } from "./services/gemini.js";

export function createApp() {
  const app = fastify({ logger: true });

  app.register(cors, {
    origin: true
  });

  app.get("/health", async () => ({
    ok: true,
    service: "ayatopos-api"
  }));

  app.post<{ Body: ResolveAreaRequest }>(
    "/api/geo/resolve-area",
    { schema: { body: resolveAreaRequestSchema } },
    async (request) => {
      const manual = parseManualCenter(request.body.areaText);
      if (manual) return { status: "resolved" as const, center: manual };

      const preset = resolvePresetArea(request.body.areaText);
      if (preset) return { status: "resolved" as const, center: preset };

      const gemini = await resolveAreaWithGemini(request.body.areaText);
      if (gemini) return { status: "resolved" as const, center: gemini };

      return { status: "needsManualCenter" as const };
    }
  );

  app.post<{ Body: PlacementRequest }>(
    "/api/geo/placements",
    { schema: { body: placementRequestSchema } },
    async (request) => {
      const fallback = createFallbackPlacements(request.body.nodes, request.body.center).map((placement) =>
        clampGeoPlacementToLocalRadius(placement, request.body.center)
      );
      const gemini = (await generateGeoPlacements(request.body))?.map((placement) =>
        clampGeoPlacementToLocalRadius(placement, request.body.center)
      );

      if (!gemini) {
        return { mode: "fallback" as const, placements: fallback };
      }

      const fallbackById = new Map(fallback.map((placement) => [placement.nodeId, placement]));
      const merged = request.body.nodes.map((node) => {
        const generated = gemini.find((placement) => placement.nodeId === node.id);
        const backup = fallbackById.get(node.id);
        return clampGeoPlacementToLocalRadius(generated ?? backup!, request.body.center);
      });

      return { mode: "gemini" as const, placements: merged };
    }
  );

  return app;
}
