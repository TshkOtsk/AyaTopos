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
  overviewCard?: IdeaLayerCardLayout;
}

export interface IdeaLayerEditState {
  enabled: boolean;
  selectedId: string | null;
  overview?: boolean;
}

export interface IdeaLayerCardLayout {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface IdeaLayerThreadDatum {
  id: string;
  kind: "json" | "parent" | "sibling" | "family" | "card-link";
  source: { x: number; y: number };
  target: { x: number; y: number };
  width: number;
}

interface IdeaObject {
  glow: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  ideaForm: THREE.Group;
  editRing: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  overviewCard: THREE.Sprite;
}

const OVERVIEW_FOCUS_CARD_SIZE = { width: 274, height: 181 };

const MAPPED_CARD_GROUND_CLEARANCE_METERS = 0.6;

export class IdeaObjectLayer implements CustomLayerInterface {
  id = "ayatopos-idea-objects";
  type = "custom" as const;
  renderingMode = "3d" as const;

  private map: MapLibreMap | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private overlayScene = new THREE.Scene();
  private camera = new THREE.Camera();
  private overlayCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
  private data: IdeaLayerDatum[] = [];
  private threads: IdeaLayerThreadDatum[] = [];
  private hoveredId: string | null = null;
  private editState: IdeaLayerEditState = { enabled: false, selectedId: null };
  private objects = new Map<string, IdeaObject>();
  private glowTextures = new Map<string, THREE.CanvasTexture>();
  private overviewCardTextures = new Map<string, THREE.CanvasTexture>();
  private solidGlowTexture: THREE.CanvasTexture | null = null;
  private editRingTexture: THREE.CanvasTexture | null = null;
  private threadCanvas = document.createElement("canvas");
  private threadTexture = new THREE.CanvasTexture(this.threadCanvas);
  private threadSprite: THREE.Sprite;
  private threadsDirty = true;

  constructor() {
    this.threadTexture.colorSpace = THREE.SRGBColorSpace;
    this.threadSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.threadTexture,
        transparent: true,
        opacity: 1,
        depthTest: false,
        depthWrite: false
      })
    );
    this.threadSprite.renderOrder = 80;
    this.threadSprite.visible = false;
    this.overlayScene.add(this.threadSprite);
  }

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
    this.overlayScene.clear();
    this.glowTextures.forEach((texture) => texture.dispose());
    this.overviewCardTextures.forEach((texture) => texture.dispose());
    this.solidGlowTexture?.dispose();
    this.editRingTexture?.dispose();
    this.threadTexture.dispose();
    this.threadSprite.material.dispose();
    this.glowTextures.clear();
    this.overviewCardTextures.clear();
    this.solidGlowTexture = null;
    this.editRingTexture = null;
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
    this.updateOverlayCamera();
    this.updateThreadTexture();
    this.renderer.clearDepth();
    this.renderer.render(this.overlayScene, this.overlayCamera);
  }

  setData(
    data: IdeaLayerDatum[],
    hoveredId: string | null,
    editState: IdeaLayerEditState = { enabled: false, selectedId: null },
    threads: IdeaLayerThreadDatum[] = []
  ): void {
    this.data = data;
    this.hoveredId = hoveredId;
    this.editState = editState;
    this.threads = threads;
    this.threadsDirty = true;
    this.syncObjects();
    this.updateTransforms();
    this.map?.triggerRepaint();
  }

  private syncObjects(): void {
    const expectedIds = new Set(this.data.map(({ node }) => node.id));

    this.objects.forEach((object, id) => {
      if (!expectedIds.has(id)) {
        this.scene.remove(object.glow);
        this.scene.remove(object.ideaForm);
        this.scene.remove(object.editRing);
        this.overlayScene.remove(object.overviewCard);
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
      this.scene.add(object.ideaForm);
      this.scene.add(object.editRing);
      this.overlayScene.add(object.overviewCard);
    }
  }

  private createObject(item: IdeaLayerDatum): IdeaObject {
    const glow = this.createNodeGlow(item);
    const ideaForm = this.createIdeaForm(item);
    const editRing = this.createEditRing(item);
    const overviewCard = this.createOverviewCard(item);
    const object = { glow, ideaForm, editRing, overviewCard };
    this.updateMaterial(object, item);
    return object;
  }

  private createNodeGlow(item: IdeaLayerDatum): THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> {
    const color = new THREE.Color(item.node.color);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0], 3));
    const material = new THREE.PointsMaterial({
      color: "#ffffff",
      map: this.getGlowTexture(color),
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

  private createIdeaForm(item: IdeaLayerDatum): THREE.Group {
    const color = new THREE.Color(item.node.color);
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    group.frustumCulled = false;
    group.renderOrder = 52;

    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        color,
        map: this.getSolidGlowTexture(),
        transparent: true,
        opacity: ideaSolidGlowOpacity(item, false),
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false
      })
    );
    halo.name = "idea-solid-glow";
    halo.scale.set(item.node.type === "group" ? 1.36 : 1.08, item.node.type === "group" ? 1.18 : 0.94, 1);
    halo.frustumCulled = false;
    halo.renderOrder = 51;
    group.add(halo);

    const solidKind = platonicSolidKind(item.node);
    const solidGeometry = platonicSolidGeometry(solidKind);
    const solidScale = platonicSolidScale(item.node, solidKind);
    const surface = new THREE.Mesh(
      solidGeometry,
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: ideaSolidSurfaceOpacity(item, false),
        blending: THREE.NormalBlending,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide
      })
    );
    surface.name = "idea-solid";
    surface.scale.set(solidScale.x, solidScale.y, solidScale.z);
    surface.frustumCulled = false;
    surface.renderOrder = 52;

    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(solidGeometry, 14),
      new THREE.LineBasicMaterial({
        color: "#fff8df",
        transparent: true,
        opacity: ideaSolidEdgeOpacity(item, false),
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false
      })
    );
    edge.name = "idea-solid-edge";
    edge.scale.copy(surface.scale);
    edge.frustumCulled = false;
    edge.renderOrder = 54;

    group.add(surface, edge);

    const thread = new THREE.Line(
      ideaSolidOrbitGeometry(item.node),
      new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: ideaFormThreadOpacity(item, false),
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false
      })
    );
    thread.name = "idea-solid-orbit";
    thread.renderOrder = 56;
    thread.frustumCulled = false;

    group.add(thread);
    return group;
  }

  private createEditRing(item: IdeaLayerDatum): THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> {
    const color = new THREE.Color(item.node.color);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0], 3));
    const material = new THREE.PointsMaterial({
      color,
      map: this.getEditRingTexture(),
      transparent: true,
      opacity: 0,
      size: 48,
      sizeAttenuation: false,
      blending: THREE.NormalBlending,
      depthTest: false,
      depthWrite: false
    });

    const editRing = new THREE.Points(geometry, material);
    editRing.matrixAutoUpdate = false;
    editRing.frustumCulled = false;
    editRing.renderOrder = 70;
    editRing.visible = false;
    return editRing;
  }

  private createOverviewCard(item: IdeaLayerDatum): THREE.Sprite {
    const material = new THREE.SpriteMaterial({
      color: "#ffffff",
      map: this.getOverviewCardTexture(item.node, false),
      transparent: true,
      opacity: 0,
      sizeAttenuation: false,
      depthTest: false,
      depthWrite: false
    });

    const card = new THREE.Sprite(material);
    card.matrixAutoUpdate = false;
    card.frustumCulled = false;
    card.renderOrder = 95;
    card.visible = false;
    return card;
  }

  private updateMaterial(object: IdeaObject, item: IdeaLayerDatum): void {
    const active = this.hoveredId === item.node.id;
    const editing = this.editState.enabled && item.node.type === "card";
    const overviewing = Boolean(this.editState.overview);
    const selected = this.editState.selectedId === item.node.id;
    const color = new THREE.Color(item.node.color);
    const mappedCard = isMappedCard(item.node);

    object.glow.visible = !this.editState.enabled && mappedCard;
    object.glow.material.color.set("#ffffff");
    object.glow.material.map = this.getGlowTexture(color);
    object.glow.material.opacity = nodeGlowOpacity(item, active);
    object.glow.material.size = nodeGlowSizePixels(item, active);
    object.glow.material.needsUpdate = true;

    object.ideaForm.visible = !this.editState.enabled && !mappedCard;
    updateIdeaFormMaterial(object.ideaForm, item, active, color);

    object.editRing.visible = editing;
    object.editRing.material.color.copy(color);
    object.editRing.material.opacity = editing ? editRingOpacity(item, active, selected) : 0;
    object.editRing.material.size = editRingSizePixels(item, active, selected);
    object.editRing.material.needsUpdate = true;

    object.overviewCard.visible = overviewing && item.related && Boolean(item.overviewCard);
    object.overviewCard.material.map = this.getOverviewCardTexture(item.node, overviewing && selected);
    object.overviewCard.material.opacity = overviewing && item.related ? overviewCardOpacity(item, active) : 0;
    object.overviewCard.material.needsUpdate = true;
    object.overviewCard.renderOrder = active ? 110 : 95;
  }

  private updateTransforms(): void {
    if (!this.map) return;

    for (const item of this.data) {
      const object = this.objects.get(item.node.id);
      if (!object) continue;

      const elevation = nodeElevationMeters(this.map, item.node, item.point);
      const coordinate = MercatorCoordinate.fromLngLat([item.point.lng, item.point.lat], elevation);
      const position = new THREE.Vector3(coordinate.x, coordinate.y, coordinate.z);
      const rotation = new THREE.Quaternion();
      const scale = new THREE.Vector3(1, 1, 1);
      object.glow.matrix.compose(position, rotation, scale);
      object.editRing.matrix.compose(position, rotation, scale);
      const ideaScale = nodeIdeaFormScale(item, this.hoveredId === item.node.id);
      const ideaRotation = ideaFormRotation(item.node);
      const meterScale = coordinate.meterInMercatorCoordinateUnits();
      object.ideaForm.matrix.compose(
        position,
        ideaRotation,
        new THREE.Vector3(
          ideaScale.width * 1.28 * meterScale,
          ideaScale.width * 0.86 * meterScale,
          ideaScale.height * 0.28 * meterScale
        )
      );
      if (item.overviewCard) {
        this.updateOverviewCardTransform(
          object.overviewCard,
          item.overviewCard,
          this.hoveredId === item.node.id
        );
      }
    }
  }

  private updateOverlayCamera(): void {
    if (!this.map) return;
    const canvas = this.map.getCanvas();
    const width = canvas.width;
    const height = canvas.height;
    this.overlayCamera.left = -width / 2;
    this.overlayCamera.right = width / 2;
    this.overlayCamera.top = height / 2;
    this.overlayCamera.bottom = -height / 2;
    this.overlayCamera.updateProjectionMatrix();
  }

  private updateOverviewCardTransform(
    card: THREE.Sprite,
    layout: IdeaLayerCardLayout,
    active: boolean
  ): void {
    if (!this.map) return;
    const pixelRatio = canvasPixelRatio(this.map);
    const canvas = this.map.getCanvas();
    const width = (active ? OVERVIEW_FOCUS_CARD_SIZE.width : layout.width) * pixelRatio;
    const height = (active ? OVERVIEW_FOCUS_CARD_SIZE.height : layout.height) * pixelRatio;
    const x = (layout.left + layout.width / 2) * pixelRatio - canvas.width / 2;
    const y = canvas.height / 2 - (layout.top + layout.height / 2) * pixelRatio;
    const position = new THREE.Vector3(x, y, 0);
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3(width, height, 1);
    card.matrix.compose(position, rotation, scale);
  }

  private updateThreadTexture(): void {
    if (!this.map || (!this.threadsDirty && this.threadCanvas.width === this.map.getCanvas().width && this.threadCanvas.height === this.map.getCanvas().height)) {
      return;
    }

    const canvas = this.map.getCanvas();
    if (this.threadCanvas.width !== canvas.width || this.threadCanvas.height !== canvas.height) {
      this.threadCanvas.width = canvas.width;
      this.threadCanvas.height = canvas.height;
      this.threadTexture.dispose();
      this.threadTexture = new THREE.CanvasTexture(this.threadCanvas);
      this.threadTexture.colorSpace = THREE.SRGBColorSpace;
      this.threadSprite.material.map = this.threadTexture;
    }

    const context = this.threadCanvas.getContext("2d");
    if (!context) return;

    context.clearRect(0, 0, this.threadCanvas.width, this.threadCanvas.height);
    const pixelRatio = canvasPixelRatio(this.map);
    for (const thread of this.threads) {
      drawThread(context, thread, pixelRatio);
    }

    this.threadSprite.visible = this.threads.length > 0;
    this.threadSprite.position.set(0, 0, -10);
    this.threadSprite.scale.set(this.threadCanvas.width, this.threadCanvas.height, 1);
    this.threadTexture.needsUpdate = true;
    this.threadsDirty = false;
  }

  private disposeObject(object: IdeaObject): void {
    object.glow.geometry.dispose();
    object.glow.material.dispose();
    disposeObject3d(object.ideaForm);
    object.editRing.geometry.dispose();
    object.editRing.material.dispose();
    object.overviewCard.material.dispose();
  }

  private getSolidGlowTexture(): THREE.CanvasTexture {
    if (this.solidGlowTexture) return this.solidGlowTexture;

    const size = 192;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Unable to create platonic solid glow texture.");

    context.clearRect(0, 0, size, size);
    const center = size / 2;
    const radius = size * 0.42;
    const gradient = context.createRadialGradient(center, center, 0, center, center, radius);
    gradient.addColorStop(0, "rgba(255, 255, 255, 0.74)");
    gradient.addColorStop(0.42, "rgba(255, 255, 255, 0.28)");
    gradient.addColorStop(1, "rgba(255, 255, 255, 0)");

    context.save();
    context.translate(center, center);
    context.rotate(Math.PI / 10);
    context.beginPath();
    for (let index = 0; index < 10; index += 1) {
      const angle = (index / 10) * Math.PI * 2;
      const pointRadius = radius * (index % 2 === 0 ? 1 : 0.72);
      const x = Math.cos(angle) * pointRadius;
      const y = Math.sin(angle) * pointRadius;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.closePath();
    context.fillStyle = gradient;
    context.fill();
    context.restore();

    this.solidGlowTexture = new THREE.CanvasTexture(canvas);
    this.solidGlowTexture.colorSpace = THREE.SRGBColorSpace;
    this.solidGlowTexture.needsUpdate = true;
    return this.solidGlowTexture;
  }

  private getGlowTexture(color: THREE.Color): THREE.CanvasTexture {
    const key = `#${color.getHexString()}`;
    const current = this.glowTextures.get(key);
    if (current) return current;

    const size = 128;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Unable to create mapped card glow texture.");

    const center = size / 2;
    const gradient = context.createRadialGradient(center, center, 0, center, center, center);
    gradient.addColorStop(0, "rgba(255, 255, 255, 1)");
    gradient.addColorStop(0.13, "rgba(255, 255, 255, 0.88)");
    gradient.addColorStop(0.3, rgbaString(color, 0.72));
    gradient.addColorStop(0.62, rgbaString(color, 0.3));
    gradient.addColorStop(1, rgbaString(color, 0));

    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    this.glowTextures.set(key, texture);
    return texture;
  }

  private getEditRingTexture(): THREE.CanvasTexture {
    if (this.editRingTexture) return this.editRingTexture;

    const size = 128;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Unable to create mapped card edit ring texture.");

    const center = size / 2;
    context.clearRect(0, 0, size, size);

    context.fillStyle = "rgba(255, 255, 255, 0.34)";
    context.beginPath();
    context.arc(center, center, 49, 0, Math.PI * 2);
    context.fill();

    context.strokeStyle = "rgba(255, 255, 255, 0.78)";
    context.lineWidth = 6;
    context.beginPath();
    context.arc(center, center, 43, 0, Math.PI * 2);
    context.stroke();

    context.fillStyle = "rgba(255, 255, 255, 0.86)";
    context.beginPath();
    context.arc(center, center, 8, 0, Math.PI * 2);
    context.fill();

    this.editRingTexture = new THREE.CanvasTexture(canvas);
    this.editRingTexture.colorSpace = THREE.SRGBColorSpace;
    this.editRingTexture.needsUpdate = true;
    return this.editRingTexture;
  }

  private getOverviewCardTexture(node: AyaNode, selected: boolean): THREE.CanvasTexture {
    const key = `${node.id}:${node.shortLabel}:${node.label}:${node.color}:${selected ? "selected" : "idle"}`;
    const current = this.overviewCardTextures.get(key);
    if (current) return current;

    const color = new THREE.Color(node.color);
    const size = 512;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = 340;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Unable to create overview card texture.");

    context.clearRect(0, 0, size, size);
    drawOverviewCard(context, node, color, selected);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    this.overviewCardTextures.set(key, texture);
    return texture;
  }
}

export function nodeElevationMeters(map: MapLibreMap, node: AyaNode, point: AyaSpatialPoint): number {
  const terrainElevation = map.queryTerrainElevation([point.lng, point.lat]) ?? 0;
  return isMappedCard(node)
    ? terrainElevation + MAPPED_CARD_GROUND_CLEARANCE_METERS
    : terrainElevation + point.altitude * 0.82 + (node.type === "group" ? 34 : 18);
}

function isMappedCard(node: AyaNode): boolean {
  return node.type === "card" && node.geoPlacementSource !== "fallback";
}

function updateIdeaFormMaterial(form: THREE.Group, item: IdeaLayerDatum, active: boolean, color: THREE.Color): void {
  form.traverse((child) => {
    const material = (child as THREE.Object3D & { material?: THREE.Material | THREE.Material[] }).material;
    if (!material || Array.isArray(material)) return;

    if (child.name === "idea-solid-glow" && material instanceof THREE.SpriteMaterial) {
      material.color.copy(color);
      material.opacity = ideaSolidGlowOpacity(item, active);
      material.needsUpdate = true;
      return;
    }

    if (child.name === "idea-solid" && material instanceof THREE.MeshBasicMaterial) {
      material.color.copy(color);
      material.opacity = ideaSolidSurfaceOpacity(item, active);
      material.needsUpdate = true;
      return;
    }

    if (child.name === "idea-solid-edge" && material instanceof THREE.LineBasicMaterial) {
      material.color.set("#fff8df");
      material.opacity = ideaSolidEdgeOpacity(item, active);
      material.needsUpdate = true;
      return;
    }

    if (child.name === "idea-solid-orbit" && material instanceof THREE.LineBasicMaterial) {
      material.color.copy(color);
      material.opacity = ideaFormThreadOpacity(item, active);
      material.needsUpdate = true;
    }
  });
}

type PlatonicSolidKind = "tetrahedron" | "cube" | "octahedron" | "dodecahedron" | "icosahedron";

function platonicSolidKind(node: AyaNode): PlatonicSolidKind {
  const kinds: PlatonicSolidKind[] = ["tetrahedron", "cube", "octahedron", "dodecahedron", "icosahedron"];
  const index = Math.min(kinds.length - 1, Math.floor(seededUnit(`${node.id}:${node.depth}:platonic`) * kinds.length));
  return kinds[index]!;
}

function platonicSolidGeometry(kind: PlatonicSolidKind): THREE.BufferGeometry {
  switch (kind) {
    case "tetrahedron":
      return new THREE.TetrahedronGeometry(0.74, 0);
    case "cube":
      return new THREE.BoxGeometry(1.02, 1.02, 1.02);
    case "octahedron":
      return new THREE.OctahedronGeometry(0.72, 0);
    case "dodecahedron":
      return new THREE.DodecahedronGeometry(0.68, 0);
    case "icosahedron":
      return new THREE.IcosahedronGeometry(0.7, 0);
  }
}

function platonicSolidScale(node: AyaNode, kind: PlatonicSolidKind): { x: number; y: number; z: number } {
  const hierarchyScale = node.type === "group" && node.depth === 0 ? 1.12 : node.type === "group" ? 1 : 0.86;
  const kindScale = kind === "tetrahedron" ? 1.08 : kind === "cube" ? 0.92 : 1;
  const scale = hierarchyScale * kindScale;
  return { x: scale, y: scale, z: scale };
}

function ideaSolidOrbitGeometry(node: AyaNode): THREE.BufferGeometry {
  const seed = seededUnit(`${node.id}:thread`);
  const radiusX = node.type === "card" ? 0.62 : 0.76;
  const radiusY = node.type === "card" ? 0.38 : 0.48;
  const points: number[] = [];
  const steps = 34;
  for (let index = 0; index <= steps; index += 1) {
    const t = (index / steps) * Math.PI * 2;
    const wobble = Math.sin(t * 3 + seed * Math.PI * 2) * 0.08;
    points.push(
      Math.cos(t) * (radiusX + wobble),
      Math.sin(t * 1.04 + seed * 0.4) * radiusY,
      Math.sin(t * 2.2 + seed) * 0.12
    );
  }
  for (let index = 0; index <= 12; index += 1) {
    const t = (index / 12) * Math.PI;
    points.push(
      Math.cos(t + seed) * radiusX * 0.68,
      Math.sin(t * 1.7) * radiusY * 0.74,
      Math.cos(t * 1.35 + seed) * 0.16
    );
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  return geometry;
}

function nodeIdeaFormScale(item: IdeaLayerDatum, active: boolean): { width: number; height: number } {
  const activeScale = active ? 1.14 : 1;
  if (item.node.type === "group" && item.node.depth === 0) {
    return { width: 118 * activeScale, height: 146 * activeScale };
  }
  if (item.node.type === "group") {
    return { width: 86 * activeScale, height: 104 * activeScale };
  }
  return { width: 64 * activeScale, height: 78 * activeScale };
}

function ideaFormRotation(node: AyaNode): THREE.Quaternion {
  const yaw = seededUnit(`${node.id}:yaw`) * Math.PI * 2;
  const pitch = 0.62 + seededUnit(`${node.id}:pitch`) * 0.48;
  const roll = 0.28 + Math.min(node.depth, 7) * 0.16 + seededUnit(`${node.id}:roll`) * 0.34;
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, roll, "YXZ"));
}

function ideaSolidSurfaceOpacity(item: IdeaLayerDatum, active: boolean): number {
  const dimOpacity = item.dimmed ? 0.2 : 1;
  const relatedOpacity = item.related ? 1 : 0.58;
  const typeOpacity = item.node.type === "group" ? 0.42 : 0.36;
  return Math.min(0.6, typeOpacity * (active ? 1.22 : 1) * dimOpacity * relatedOpacity);
}

function ideaSolidEdgeOpacity(item: IdeaLayerDatum, active: boolean): number {
  const dimOpacity = item.dimmed ? 0.18 : 1;
  const relatedOpacity = item.related ? 1 : 0.64;
  return Math.min(0.68, (active ? 0.58 : 0.34) * dimOpacity * relatedOpacity);
}

function ideaSolidGlowOpacity(item: IdeaLayerDatum, active: boolean): number {
  const dimOpacity = item.dimmed ? 0.16 : 1;
  const relatedOpacity = item.related ? 1 : 0.58;
  const typeOpacity = item.node.type === "group" ? 0.4 : 0.34;
  return Math.min(0.7, typeOpacity * (active ? 1.28 : 1) * dimOpacity * relatedOpacity);
}

function ideaFormThreadOpacity(item: IdeaLayerDatum, active: boolean): number {
  const dimOpacity = item.dimmed ? 0.18 : 1;
  const relatedOpacity = item.related ? 1 : 0.64;
  return Math.min(0.66, (active ? 0.56 : 0.34) * dimOpacity * relatedOpacity);
}

function disposeObject3d(object: THREE.Object3D): void {
  object.traverse((child) => {
    const disposable = child as THREE.Object3D & {
      geometry?: THREE.BufferGeometry;
      material?: THREE.Material | THREE.Material[];
    };
    disposable.geometry?.dispose();
    const material = disposable.material;
    if (Array.isArray(material)) {
      material.forEach((item) => item.dispose());
      return;
    }
    material?.dispose();
  });
}

function nodeGlowSizePixels(item: IdeaLayerDatum, active: boolean): number {
  const activeScale = active ? 1.16 : 1;
  if (item.node.type === "group" && item.node.depth === 0) return 68 * activeScale;
  if (item.node.type === "group") return 58 * activeScale;
  if (item.node.geoPlacementSource === "fallback" || item.node.geoPlacementSource === "manual") return 48 * activeScale;
  return 38 * activeScale;
}

function nodeGlowOpacity(item: IdeaLayerDatum, active: boolean): number {
  const dimOpacity = item.dimmed ? 0.18 : 1;
  const relatedOpacity = item.related ? 1 : 0.72;
  const typeOpacity =
    item.node.type === "group"
      ? 0.64
      : item.node.geoPlacementSource === "fallback" || item.node.geoPlacementSource === "manual"
        ? 0.72
        : 0.68;
  return Math.min(0.94, (active ? 0.9 : typeOpacity) * dimOpacity * relatedOpacity);
}

function editRingSizePixels(item: IdeaLayerDatum, active: boolean, selected: boolean): number {
  const base = item.node.geoPlacementSource === "fallback" || item.node.geoPlacementSource === "manual" ? 54 : 42;
  const selectedScale = selected ? 1.16 : 1;
  const activeScale = active ? 1.08 : 1;
  return base * selectedScale * activeScale;
}

function editRingOpacity(item: IdeaLayerDatum, active: boolean, selected: boolean): number {
  const dimOpacity = item.dimmed ? 0.34 : 1;
  const stateOpacity = selected ? 0.96 : active ? 0.9 : 0.86;
  return stateOpacity * dimOpacity;
}

function overviewCardOpacity(item: IdeaLayerDatum, active: boolean): number {
  const dimOpacity = item.dimmed ? 0.28 : 1;
  return (active ? 0.98 : 0.92) * dimOpacity;
}

function drawOverviewCard(context: CanvasRenderingContext2D, node: AyaNode, color: THREE.Color, selected: boolean): void {
  const card = { x: 18, y: 20, width: 476, height: 300, radius: 16 };
  const accentWidth = overviewHierarchyAccentWidth(node);
  const textLeft = card.x + accentWidth + 36;
  const textWidth = card.width - accentWidth - 58;
  context.save();

  if (selected) {
    context.shadowColor = "rgba(255, 34, 58, 0.94)";
    context.shadowBlur = 46;
    context.shadowOffsetY = 0;
    context.lineWidth = 18;
    context.strokeStyle = "rgba(255, 35, 58, 0.88)";
    roundedRect(context, card.x + 7, card.y + 7, card.width - 14, card.height - 14, card.radius);
    context.stroke();
    context.lineWidth = 8;
    context.strokeStyle = "rgba(255, 75, 88, 0.78)";
    roundedRect(context, card.x + 10, card.y + 10, card.width - 20, card.height - 20, card.radius - 2);
    context.stroke();
  }

  context.shadowColor = "rgba(45, 30, 16, 0.18)";
  context.shadowBlur = 24;
  context.shadowOffsetY = 14;
  roundedRect(context, card.x, card.y, card.width, card.height, card.radius);
  context.fillStyle = tintedCardFill(color);
  context.fill();
  context.shadowColor = "transparent";
  context.lineWidth = 3;
  context.strokeStyle = rgbaString(color, 0.34);
  context.stroke();

  context.fillStyle = rgbaString(color, 0.74);
  roundedRect(context, card.x + 16, card.y + 22, accentWidth, card.height - 44, Math.min(8, accentWidth / 2));
  context.fill();

  context.fillStyle = "#3a2e27";
  context.textBaseline = "top";
  context.font = '700 31px Inter, "Yu Gothic UI", Meiryo, sans-serif';
  const titleLines = wrapCanvasText(context, node.shortLabel, textWidth, 2);
  let y = card.y + 28;
  for (const line of titleLines) {
    context.fillText(line, textLeft, y);
    y += 39;
  }

  context.fillStyle = "rgba(58, 46, 39, 0.78)";
  context.font = '500 22px Inter, "Yu Gothic UI", Meiryo, sans-serif';
  const bodyLines = wrapCanvasText(context, node.label, textWidth, 4);
  y += 12;
  for (const line of bodyLines) {
    if (y > card.y + card.height - 34) break;
    context.fillText(line, textLeft, y);
    y += 30;
  }

  context.restore();
}

function overviewHierarchyAccentWidth(node: AyaNode): number {
  return Math.max(7, 26 - Math.min(node.depth, 6) * 3);
}

function drawThread(context: CanvasRenderingContext2D, thread: IdeaLayerThreadDatum, pixelRatio: number): void {
  const source = {
    x: thread.source.x * pixelRatio,
    y: thread.source.y * pixelRatio
  };
  const target = {
    x: thread.target.x * pixelRatio,
    y: thread.target.y * pixelRatio
  };
  const midX = (source.x + target.x) / 2;
  const midY = (source.y + target.y) / 2 - Math.min(120 * pixelRatio, Math.abs(source.x - target.x) * 0.18);

  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = thread.width * pixelRatio;
  context.strokeStyle = threadStrokeStyle(thread.kind);
  context.shadowColor = threadShadowColor(thread.kind);
  context.shadowBlur = 18 * pixelRatio;
  context.beginPath();
  context.moveTo(source.x, source.y);
  if (thread.kind === "card-link") {
    context.setLineDash([5 * pixelRatio, 7 * pixelRatio]);
    context.lineTo(target.x, target.y);
  } else if (thread.kind === "family") {
    const joinY = (source.y + target.y) / 2;
    context.lineTo(source.x, joinY);
    context.lineTo(target.x, joinY);
    context.lineTo(target.x, target.y);
  } else {
    context.quadraticCurveTo(midX, midY, target.x, target.y);
  }
  context.stroke();
  context.restore();
}

function threadStrokeStyle(kind: IdeaLayerThreadDatum["kind"]): string {
  if (kind === "card-link") return "rgba(198, 93, 109, 0.74)";
  if (kind === "parent" || kind === "family") return "rgba(186, 242, 255, 0.82)";
  if (kind === "sibling") return "rgba(255, 218, 158, 0.72)";
  return "rgba(255, 246, 205, 0.92)";
}

function threadShadowColor(kind: IdeaLayerThreadDatum["kind"]): string {
  if (kind === "card-link") return "rgba(255, 154, 154, 0.58)";
  if (kind === "parent" || kind === "family") return "rgba(116, 210, 255, 0.72)";
  if (kind === "sibling") return "rgba(255, 194, 84, 0.62)";
  return "rgba(255, 226, 151, 0.86)";
}

function canvasPixelRatio(map: MapLibreMap): number {
  const canvas = map.getCanvas();
  return canvas.clientWidth > 0 ? canvas.width / canvas.clientWidth : window.devicePixelRatio || 1;
}

function wrapCanvasText(context: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) return [];
  const words = normalized.includes(" ") ? normalized.split(" ") : [...normalized];
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? (normalized.includes(" ") ? `${current} ${word}` : `${current}${word}`) : word;
    if (context.measureText(candidate).width <= maxWidth || !current) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = word;
    if (lines.length >= maxLines) break;
  }

  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length === maxLines && context.measureText(lines[lines.length - 1]!).width > maxWidth) {
    lines[lines.length - 1] = truncateCanvasText(context, lines[lines.length - 1]!, maxWidth);
  }
  return lines;
}

function truncateCanvasText(context: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  let next = text;
  while (next.length > 1 && context.measureText(`${next}...`).width > maxWidth) {
    next = next.slice(0, -1);
  }
  return `${next}...`;
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

function tintedCardFill(color: THREE.Color): string {
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  return `rgba(${Math.round(r * 0.08 + 255 * 0.92)}, ${Math.round(g * 0.08 + 246 * 0.92)}, ${Math.round(
    b * 0.08 + 232 * 0.92
  )}, 0.96)`;
}

function seededUnit(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function rgbaString(color: THREE.Color, alpha: number): string {
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
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
