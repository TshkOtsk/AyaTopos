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
  root: THREE.Group;
  solid: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  wire: THREE.LineSegments<THREE.EdgesGeometry, THREE.LineBasicMaterial>;
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

  onAdd(map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.map = map;
    this.renderer = new THREE.WebGLRenderer({
      canvas: map.getCanvas(),
      context: gl,
      antialias: true
    });
    this.renderer.autoClear = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene.add(new THREE.HemisphereLight(0xfff6de, 0x33464d, 1.35));
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.4);
    keyLight.position.set(0.2, -0.7, 1);
    this.scene.add(keyLight);
    this.syncObjects();
  }

  onRemove(): void {
    this.objects.forEach((object) => this.disposeObject(object));
    this.objects.clear();
    this.scene.clear();
    this.renderer?.dispose();
    this.renderer = null;
    this.map = null;
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    if (!this.renderer || !this.map) return;

    this.syncObjects();
    this.updateTransforms();
    this.camera.projectionMatrix = new THREE.Matrix4().fromArray(options.modelViewProjectionMatrix);

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
        this.scene.remove(object.root);
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
      this.scene.add(object.root);
    }
  }

  private createObject(item: IdeaLayerDatum): IdeaObject {
    const root = new THREE.Group();
    root.matrixAutoUpdate = false;

    const geometry =
      item.node.type === "group" ? new THREE.IcosahedronGeometry(1, 1) : new THREE.OctahedronGeometry(1, 1);
    const color = new THREE.Color(item.node.color);
    const solid = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: item.node.type === "group" ? 0.2 : 0.32,
        roughness: 0.5,
        metalness: 0.18,
        transparent: true,
        depthWrite: true,
        opacity: item.node.opacity
      })
    );
    solid.rotation.set(0.58, 0.42, 0.2);

    const wire = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      new THREE.LineBasicMaterial({
        color: color.clone().lerp(new THREE.Color("#fff4d6"), 0.55),
        transparent: true,
        depthWrite: false,
        opacity: 0.58
      })
    );
    wire.rotation.copy(solid.rotation);

    root.add(solid, wire);
    const object = { root, solid, wire };
    this.updateMaterial(object, item);
    return object;
  }

  private updateMaterial(object: IdeaObject, item: IdeaLayerDatum): void {
    const active = this.hoveredId === item.node.id;
    const color = new THREE.Color(item.node.color);
    const dimOpacity = item.dimmed ? 0.13 : 1;
    const relatedBoost = item.related ? 1 : 0.72;

    object.solid.material.color.copy(color);
    object.solid.material.emissive.copy(color);
    object.solid.material.emissiveIntensity = active ? 0.84 : item.node.type === "group" ? 0.24 : 0.34;
    object.solid.material.opacity = Math.min(0.92, item.node.opacity * dimOpacity * relatedBoost + (active ? 0.18 : 0));
    object.solid.material.needsUpdate = true;

    object.wire.material.color.copy(color.clone().lerp(new THREE.Color("#fff2ce"), active ? 0.8 : 0.52));
    object.wire.material.opacity = active ? 0.95 : item.dimmed ? 0.12 : 0.52;
    object.wire.material.needsUpdate = true;
  }

  private updateTransforms(): void {
    if (!this.map) return;

    for (const item of this.data) {
      const object = this.objects.get(item.node.id);
      if (!object) continue;

      const terrainElevation = this.map.queryTerrainElevation([item.point.lng, item.point.lat]) ?? 0;
      const mappedCard = item.node.type === "card" && item.node.geoPlacementSource !== "fallback";
      const elevation = mappedCard
        ? terrainElevation + 8
        : terrainElevation + item.point.altitude * 0.82 + (item.node.type === "group" ? 34 : 18);
      const coordinate = MercatorCoordinate.fromLngLat([item.point.lng, item.point.lat], elevation);
      const meterScale = coordinate.meterInMercatorCoordinateUnits();
      const sizeMeters = item.node.type === "group" ? 42 + item.node.size * 0.32 : 22 + item.node.size * 0.18;
      const hoverScale = this.hoveredId === item.node.id ? 1.28 : 1;
      const scale = meterScale * sizeMeters * hoverScale;

      object.root.matrix.compose(
        new THREE.Vector3(coordinate.x, coordinate.y, coordinate.z),
        new THREE.Quaternion(),
        new THREE.Vector3(scale, -scale, scale)
      );
    }
  }

  private disposeObject(object: IdeaObject): void {
    object.solid.geometry.dispose();
    object.solid.material.dispose();
    object.wire.geometry.dispose();
    object.wire.material.dispose();
  }
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
