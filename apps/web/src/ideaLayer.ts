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
  kind: "json" | "parent" | "sibling" | "card-link";
  source: { x: number; y: number };
  target: { x: number; y: number };
  width: number;
}

interface IdeaObject {
  glow: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  editRing: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  overviewCard: THREE.Sprite;
}

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
    this.editRingTexture?.dispose();
    this.threadTexture.dispose();
    this.threadSprite.material.dispose();
    this.glowTextures.clear();
    this.overviewCardTextures.clear();
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
      this.scene.add(object.editRing);
      this.overlayScene.add(object.overviewCard);
    }
  }

  private createObject(item: IdeaLayerDatum): IdeaObject {
    const glow = this.createNodeGlow(item);
    const editRing = this.createEditRing(item);
    const overviewCard = this.createOverviewCard(item);
    const object = { glow, editRing, overviewCard };
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
      map: this.getOverviewCardTexture(item.node),
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

    object.glow.visible = !this.editState.enabled;
    object.glow.material.color.set("#ffffff");
    object.glow.material.map = this.getGlowTexture(color);
    object.glow.material.opacity = nodeGlowOpacity(item, active);
    object.glow.material.size = nodeGlowSizePixels(item, active);
    object.glow.material.needsUpdate = true;

    object.editRing.visible = editing;
    object.editRing.material.color.copy(color);
    object.editRing.material.opacity = editing ? editRingOpacity(item, active, selected) : 0;
    object.editRing.material.size = editRingSizePixels(item, active, selected);
    object.editRing.material.needsUpdate = true;

    object.overviewCard.visible = overviewing && item.related && Boolean(item.overviewCard);
    object.overviewCard.material.map = this.getOverviewCardTexture(item.node);
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
      if (item.overviewCard) {
        this.updateOverviewCardTransform(object.overviewCard, item.overviewCard, this.hoveredId === item.node.id);
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

  private updateOverviewCardTransform(card: THREE.Sprite, layout: IdeaLayerCardLayout, active: boolean): void {
    if (!this.map) return;
    const pixelRatio = canvasPixelRatio(this.map);
    const canvas = this.map.getCanvas();
    const activeScale = active ? 1.28 : 1;
    const width = layout.width * pixelRatio * activeScale;
    const height = layout.height * pixelRatio * activeScale;
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
    object.editRing.geometry.dispose();
    object.editRing.material.dispose();
    object.overviewCard.material.dispose();
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

  private getOverviewCardTexture(node: AyaNode): THREE.CanvasTexture {
    const key = `${node.id}:${node.shortLabel}:${node.label}:${node.color}`;
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
    drawOverviewCard(context, node, color);

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

function drawOverviewCard(context: CanvasRenderingContext2D, node: AyaNode, color: THREE.Color): void {
  const card = { x: 18, y: 20, width: 476, height: 300, radius: 16 };
  context.save();
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
  roundedRect(context, card.x + 16, card.y + 22, 8, card.height - 44, 4);
  context.fill();

  context.fillStyle = "#3a2e27";
  context.textBaseline = "top";
  context.font = '700 31px Inter, "Yu Gothic UI", Meiryo, sans-serif';
  const titleLines = wrapCanvasText(context, node.shortLabel, card.width - 64, 2);
  let y = card.y + 28;
  for (const line of titleLines) {
    context.fillText(line, card.x + 42, y);
    y += 39;
  }

  context.fillStyle = "rgba(58, 46, 39, 0.78)";
  context.font = '500 22px Inter, "Yu Gothic UI", Meiryo, sans-serif';
  const bodyLines = wrapCanvasText(context, node.label, card.width - 64, 4);
  y += 12;
  for (const line of bodyLines) {
    if (y > card.y + card.height - 34) break;
    context.fillText(line, card.x + 42, y);
    y += 30;
  }

  context.restore();
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
  } else {
    context.quadraticCurveTo(midX, midY, target.x, target.y);
  }
  context.stroke();
  context.restore();
}

function threadStrokeStyle(kind: IdeaLayerThreadDatum["kind"]): string {
  if (kind === "card-link") return "rgba(198, 93, 109, 0.74)";
  if (kind === "parent") return "rgba(186, 242, 255, 0.82)";
  if (kind === "sibling") return "rgba(255, 218, 158, 0.72)";
  return "rgba(255, 246, 205, 0.92)";
}

function threadShadowColor(kind: IdeaLayerThreadDatum["kind"]): string {
  if (kind === "card-link") return "rgba(255, 154, 154, 0.58)";
  if (kind === "parent") return "rgba(116, 210, 255, 0.72)";
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
