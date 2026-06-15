import type {
  LayerSpecification,
  Map as MapLibreMap,
  SkySpecification,
  SourceSpecification,
  StyleSpecification
} from "maplibre-gl";

export const TERRAIN_SOURCE_ID = "terrainSource";
export const HILLSHADE_SOURCE_ID = "hillshadeSource";
export const OSM_LAYER_ID = "osm";
export const HILLSHADE_LAYER_ID = "hills";
const TERRAIN_DEMO_URL = "https://tiles.mapterhorn.com/tilejson.json";
const DAY_SKY_COLOR = "#88C6FC";
const NIGHT_SKY_COLOR = "#08111F";
const DAY_HORIZON_COLOR = "#FFF4DE";
const NIGHT_HORIZON_COLOR = "#243556";
const DAY_FOG_COLOR = "#F7FBFF";
const NIGHT_FOG_COLOR = "#0C1730";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function mix(start: number, end: number, amount: number): number {
  return start + (end - start) * amount;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace("#", "");
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  return [red, green, blue];
}

function rgbToHex(red: number, green: number, blue: number): string {
  return `#${[red, green, blue]
    .map((channel) => Math.round(channel).toString(16).padStart(2, "0"))
    .join("")}`;
}

function mixHex(start: string, end: string, amount: number): string {
  const [startRed, startGreen, startBlue] = hexToRgb(start);
  const [endRed, endGreen, endBlue] = hexToRgb(end);
  return rgbToHex(
    mix(startRed, endRed, amount),
    mix(startGreen, endGreen, amount),
    mix(startBlue, endBlue, amount)
  );
}

function skyForSemanticStrength(strength: number): SkySpecification {
  const amount = clamp(strength, 0, 1);

  return {
    "sky-color": mixHex(DAY_SKY_COLOR, NIGHT_SKY_COLOR, amount),
    "horizon-color": mixHex(DAY_HORIZON_COLOR, NIGHT_HORIZON_COLOR, amount),
    "fog-color": mixHex(DAY_FOG_COLOR, NIGHT_FOG_COLOR, amount),
    "fog-ground-blend": mix(0.22, 0.72, amount),
    "horizon-fog-blend": mix(0.28, 0.84, amount),
    "sky-horizon-blend": mix(0.72, 0.32, amount),
    "atmosphere-blend": mix(0.18, 0.92, amount)
  };
}

function isStyleReady(map: MapLibreMap): boolean {
  return map.isStyleLoaded() === true;
}

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
  id: HILLSHADE_LAYER_ID,
  type: "hillshade",
  source: HILLSHADE_SOURCE_ID,
  layout: { visibility: "visible" },
  paint: {
    "hillshade-shadow-color": "#473B24",
    "hillshade-exaggeration": 1
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
    sky: skyForSemanticStrength(0),
    layers: [
      {
        id: OSM_LAYER_ID,
        type: "raster",
        source: "osm",
        paint: {
          "raster-opacity": 1
        }
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
    map.setSky(skyForSemanticStrength(0));
  }

  map.getContainer().dataset.terrain = "ready";
}

export function setSemanticMapPresence(map: MapLibreMap, presence: number): void {
  if (!isStyleReady(map)) return;

  const clampedPresence = Math.min(Math.max(presence, 0), 1);

  if (map.getLayer(OSM_LAYER_ID)) {
    map.setPaintProperty(OSM_LAYER_ID, "raster-opacity", clampedPresence);
  }

  if (map.getLayer(HILLSHADE_LAYER_ID)) {
    map.setPaintProperty(HILLSHADE_LAYER_ID, "hillshade-exaggeration", clampedPresence);
  }
}

export function setSemanticSkyTransition(map: MapLibreMap, strength: number): void {
  if (!isStyleReady(map)) return;

  map.setSky(skyForSemanticStrength(strength));
}
