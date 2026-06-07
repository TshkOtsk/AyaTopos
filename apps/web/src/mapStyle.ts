import type { LayerSpecification, Map as MapLibreMap, SourceSpecification, StyleSpecification } from "maplibre-gl";

export const TERRAIN_SOURCE_ID = "terrainSource";
export const HILLSHADE_SOURCE_ID = "hillshadeSource";
const TERRAIN_DEMO_URL = "https://tiles.mapterhorn.com/tilejson.json";

function terrainUrl(): string {
  return import.meta.env.VITE_TERRAIN_SOURCE_URL || TERRAIN_DEMO_URL;
}

function terrainSource(): SourceSpecification {
  return {
    type: "raster-dem",
    url: terrainUrl(),
    tileSize: 256
  } satisfies SourceSpecification;
}

const hillshadeLayer: LayerSpecification = {
  id: "hills",
  type: "hillshade",
  source: HILLSHADE_SOURCE_ID,
  layout: { visibility: "visible" },
  paint: {
    "hillshade-shadow-color": "#473B24"
  }
};

export function mapStyle(): string | StyleSpecification {
  if (import.meta.env.VITE_MAP_STYLE_URL) {
    return import.meta.env.VITE_MAP_STYLE_URL;
  }

  return {
    version: 8,
    sources: {
      osm: {
        type: "raster",
        tiles: ["https://a.tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        attribution: "&copy; OpenStreetMap Contributors",
        maxzoom: 19
      },
      [TERRAIN_SOURCE_ID]: terrainSource(),
      [HILLSHADE_SOURCE_ID]: terrainSource()
    },
    terrain: {
      source: TERRAIN_SOURCE_ID,
      exaggeration: 1
    },
    sky: {},
    layers: [
      {
        id: "osm",
        type: "raster",
        source: "osm"
      },
      hillshadeLayer
    ]
  };
}

export function ensureTerrain(map: MapLibreMap): void {
  if (!map.getSource(TERRAIN_SOURCE_ID)) {
    map.addSource(TERRAIN_SOURCE_ID, terrainSource());
  }

  if (!map.getSource(HILLSHADE_SOURCE_ID)) {
    map.addSource(HILLSHADE_SOURCE_ID, terrainSource());
  }

  if (!map.getLayer(hillshadeLayer.id)) {
    const firstSymbolLayer = map
      .getStyle()
      .layers?.find((layer) => layer.type === "symbol")?.id;
    map.addLayer(hillshadeLayer, firstSymbolLayer);
  }

  if (!map.getTerrain()) {
    map.setTerrain({
      source: TERRAIN_SOURCE_ID,
      exaggeration: 1
    });
  }

  if (!map.getStyle().sky) {
    map.setSky({});
  }

  map.getContainer().dataset.terrain = "ready";
}
