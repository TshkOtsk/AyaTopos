import type { AyaNode, AyaSpatialPoint } from "@ayatopos/shared";
import maplibregl, {
  MercatorCoordinate,
  type CustomLayerInterface,
  type CustomRenderMethodInput,
  type Map as MapLibreMap
} from "maplibre-gl";
import * as THREE from "three";

export interface IdeaLayerDatum {
  node: AyaNode;
  point: AyaSpatialPoint;
  related: boolean;
  dimmed: boolean;
}

interface IdeaObject {
  glow: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
}

export class IdeaObjectLayer implements CustomLayerInterface {
  id = "ayatopos-idea-objects";
  type = "custom" as const;
  renderingMode = "3d" as const;

  private map: MapLibreMap | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private data: IdeaLayerDatum[] = [];
  private hoveredId: string | null = null;
  private objects = new Map<string, IdeaObject>();
  private glowTexture: THREE.CanvasTexture | null = null;

  onAdd(map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.map = map;
    this.renderer = new THREE.WebGLRenderer({
      canvas: map.getCanvas(),
      context: gl,
      antialias: true
    });
    this.renderer.autoClear = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.syncObjects();
  }

  onRemove(): void {
    this.objects.forEach((object) => this.disposeObject(object));
    this.objects.clear();
    this.scene.clear();
    this.glowTexture?.dispose();
    this.glowTexture = null;
    this.renderer?.dispose();
    this.renderer = null;
    this.map = null;
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    if (!this.renderer || !this.map) return;

    this.syncObjects();
    this.updateTransforms();
    this.camera.projectionMatrix = new THREE.Matrix4().fromArray(options.defaultProjectionData.mainMatrix);

    this.renderer.resetState();
    gl.depthMask(true);
    this.renderer.render(this.scene, this.camera);
  }

  setData(data: IdeaLayerDatum[], hoveredId: string | null): void {
    this.data = data;
    this.hoveredId = hoveredId;
    this.syncObjects();
    this.updateTransforms();
    this.map?.triggerRepaint();
  }

  private syncObjects(): void {
    const expectedIds = new Set(this.data.map(({ node }) => node.id));

    this.objects.forEach((object, id) => {
      if (!expectedIds.has(id)) {
        this.scene.remove(object.glow);
        this.disposeObject(object);
        this.objects.delete(id);
      }
    });

    for (const item of this.data) {
      const current = this.objects.get(item.node.id);
      if (current) {
        this.updateMaterial(current, item);
        continue;
      }

      const object = this.createObject(item);
      this.objects.set(item.node.id, object);
      this.scene.add(object.glow);
    }
  }

  private createObject(item: IdeaLayerDatum): IdeaObject {
    const glow = this.createNodeGlow(item);
    const object = { glow };
    this.updateMaterial(object, item);
    return object;
  }

  private createNodeGlow(item: IdeaLayerDatum): THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> {
    const color = new THREE.Color(item.node.color);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0], 3));
    const material = new THREE.PointsMaterial({
      color: color.clone().lerp(new THREE.Color("#fff7cf"), 0.22),
      map: this.getGlowTexture(),
      transparent: true,
      opacity: nodeGlowOpacity(item, false),
      size: nodeGlowSizePixels(item, false),
      sizeAttenuation: false,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false
    });

    const glow = new THREE.Points(geometry, material);
    glow.matrixAutoUpdate = false;
    glow.frustumCulled = false;
    glow.renderOrder = 50;
    return glow;
  }

  private updateMaterial(object: IdeaObject, item: IdeaLayerDatum): void {
    const active = this.hoveredId === item.node.id;
    const color = new THREE.Color(item.node.color);

    object.glow.material.color.copy(color.clone().lerp(new THREE.Color("#fff7cf"), active ? 0.46 : 0.24));
    object.glow.material.opacity = nodeGlowOpacity(item, active);
    object.glow.material.size = nodeGlowSizePixels(item, active);
    object.glow.material.needsUpdate = true;
  }

  private updateTransforms(): void {
    if (!this.map) return;

    for (const item of this.data) {
      const object = this.objects.get(item.node.id);
      if (!object) continue;

      const elevation = nodeElevationMeters(this.map, item.node, item.point);
      const coordinate = MercatorCoordinate.fromLngLat([item.point.lng, item.point.lat], elevation);
      object.glow.matrix.compose(
        new THREE.Vector3(coordinate.x, coordinate.y, coordinate.z),
        new THREE.Quaternion(),
        new THREE.Vector3(1, 1, 1)
      );
    }
  }

  private disposeObject(object: IdeaObject): void {
    object.glow.geometry.dispose();
    object.glow.material.dispose();
  }

  private getGlowTexture(): THREE.CanvasTexture {
    if (this.glowTexture) return this.glowTexture;

    const size = 128;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Unable to create mapped card glow texture.");

    const center = size / 2;
    const gradient = context.createRadialGradient(center, center, 0, center, center, center);
    gradient.addColorStop(0, "rgba(255, 255, 232, 1)");
    gradient.addColorStop(0.13, "rgba(255, 249, 216, 0.95)");
    gradient.addColorStop(0.34, "rgba(255, 221, 142, 0.42)");
    gradient.addColorStop(0.68, "rgba(255, 197, 82, 0.18)");
    gradient.addColorStop(1, "rgba(255, 197, 82, 0)");

    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);

    this.glowTexture = new THREE.CanvasTexture(canvas);
    this.glowTexture.colorSpace = THREE.SRGBColorSpace;
    this.glowTexture.needsUpdate = true;
    return this.glowTexture;
  }
}

export function nodeElevationMeters(map: MapLibreMap, node: AyaNode, point: AyaSpatialPoint): number {
  const terrainElevation = map.queryTerrainElevation([point.lng, point.lat]) ?? 0;
  return isMappedCard(node)
    ? terrainElevation + 8
    : terrainElevation + point.altitude * 0.82 + (node.type === "group" ? 34 : 18);
}

function isMappedCard(node: AyaNode): boolean {
  return node.type === "card" && node.geoPlacementSource !== "fallback";
}

function nodeGlowSizePixels(item: IdeaLayerDatum, active: boolean): number {
  const activeScale = active ? 1.18 : 1;
  if (item.node.type === "group" && item.node.depth === 0) return 76 * activeScale;
  if (item.node.type === "group") return 64 * activeScale;
  if (item.node.geoPlacementSource === "fallback") return 52 * activeScale;
  return 42 * activeScale;
}

function nodeGlowOpacity(item: IdeaLayerDatum, active: boolean): number {
  const dimOpacity = item.dimmed ? 0.18 : 1;
  const relatedOpacity = item.related ? 1 : 0.66;
  const typeOpacity = item.node.type === "group" ? 0.62 : item.node.geoPlacementSource === "fallback" ? 0.7 : 0.66;
  return Math.min(1, (active ? 0.98 : typeOpacity) * dimOpacity * relatedOpacity);
}

export function addIdeaObjectLayer(map: MapLibreMap): IdeaObjectLayer {
  const existing = map.getLayer("ayatopos-idea-objects");
  if (existing) {
    map.removeLayer("ayatopos-idea-objects");
  }

  const layer = new IdeaObjectLayer();
  map.addLayer(layer);
  return layer;
}
