import type { StyleSpecification } from "maplibre-gl";

export function mapStyle(): string | StyleSpecification {
  if (import.meta.env.VITE_MAP_STYLE_URL) {
    return import.meta.env.VITE_MAP_STYLE_URL;
  }

  return {
    version: 8,
    sources: {
      osm: {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        attribution: "&copy; OpenStreetMap contributors"
      }
    },
    layers: [
      {
        id: "osm",
        type: "raster",
        source: "osm",
        paint: {
          "raster-saturation": -0.28,
          "raster-contrast": -0.08,
          "raster-brightness-min": 0.08,
          "raster-brightness-max": 0.92
        }
      }
    ]
  };
}
