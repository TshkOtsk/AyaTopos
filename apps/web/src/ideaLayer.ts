import type { AyaGroupOutline, AyaNode, AyaSpatialPoint } from "@ayatopos/shared";
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
  sourceId?: string;
  targetId?: string;
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

interface SemanticIslandDatum {
  id: string;
  point: AyaSpatialPoint;
  color: string;
  catchphrase: string;
  radiusX: number;
  radiusY: number;
  footprint: THREE.Vector2[];
  tierCount: number;
  baseHeight: number;
  terraceHeight: number;
  crownHeight: number;
  prominence: number;
  related: boolean;
  dimmed: boolean;
  active: boolean;
}

interface SemanticIslandObject {
  group: THREE.Group;
  signature: string;
}

interface SemanticBridgeDatum {
  id: string;
  sourceId: string;
  targetId: string;
  kind: IdeaLayerThreadDatum["kind"];
  color: string;
  related: boolean;
  dimmed: boolean;
  active: boolean;
}

interface SemanticBridgeObject {
  group: THREE.Group;
  signature: string;
}

interface SemanticTopologyObject {
  group: THREE.Group;
  surface: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  edge: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  signature: string;
}

interface SemanticTopologyNodeMeta {
  id: string;
  center: THREE.Vector3;
  color: THREE.Color;
  vertexStart: number;
  vertexCount: number;
}

const OVERVIEW_FOCUS_CARD_SIZE = { width: 274, height: 181 };
const OVERVIEW_CARD_TEXTURE_VERSION = 5;

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
  private groupOutlines: AyaGroupOutline[] = [];
  private hoveredId: string | null = null;
  private editState: IdeaLayerEditState = { enabled: false, selectedId: null };
  private semanticStructureStrength = 0;
  private objects = new Map<string, IdeaObject>();
  private semanticIslands = new Map<string, SemanticIslandObject>();
  private semanticIslandData: SemanticIslandDatum[] = [];
  private semanticBridges = new Map<string, SemanticBridgeObject>();
  private semanticBridgeData: SemanticBridgeDatum[] = [];
  private semanticTopology: SemanticTopologyObject | null = null;
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
    this.semanticIslands.forEach((object) => this.disposeSemanticIsland(object));
    this.semanticBridges.forEach((object) => this.disposeSemanticBridge(object));
    if (this.semanticTopology) {
      this.scene.remove(this.semanticTopology.group);
      this.disposeSemanticTopology(this.semanticTopology);
      this.semanticTopology = null;
    }
    this.objects.clear();
    this.semanticIslands.clear();
    this.semanticBridges.clear();
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
    threads: IdeaLayerThreadDatum[] = [],
    semanticStructureStrength = 0,
    groupOutlines: AyaGroupOutline[] = []
  ): void {
    this.data = data;
    this.hoveredId = hoveredId;
    this.editState = editState;
    this.threads = threads;
    this.semanticStructureStrength = clamp(semanticStructureStrength, 0, 1);
    this.groupOutlines = groupOutlines;
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

    this.syncSemanticIslands();
    if (this.hoveredId && !this.editState.enabled && !this.editState.overview) {
      this.syncSemanticBridges();
    } else {
      this.clearSemanticConnections();
    }
  }

  private clearSemanticConnections(): void {
    this.semanticBridgeData = [];
    this.semanticBridges.forEach((object) => {
      this.scene.remove(object.group);
      this.disposeSemanticBridge(object);
    });
    this.semanticBridges.clear();

    if (this.semanticTopology) {
      this.scene.remove(this.semanticTopology.group);
      this.disposeSemanticTopology(this.semanticTopology);
      this.semanticTopology = null;
    }
  }

  private syncSemanticIslands(): void {
    this.semanticIslandData = semanticIslandData(this.data, this.hoveredId, this.groupOutlines);
    const expectedIds = new Set(this.semanticIslandData.map((item) => item.id));

    this.semanticIslands.forEach((object, id) => {
      if (expectedIds.has(id)) return;
      this.scene.remove(object.group);
      this.disposeSemanticIsland(object);
      this.semanticIslands.delete(id);
    });

    for (const island of this.semanticIslandData) {
      const signature = semanticIslandSignature(island);
      const current = this.semanticIslands.get(island.id);
      if (current && current.signature !== signature) {
        this.scene.remove(current.group);
        this.disposeSemanticIsland(current);
        this.semanticIslands.delete(island.id);
      }
      const next = this.semanticIslands.get(island.id);
      if (next) {
        updateSemanticIslandMaterial(next.group, island, this.semanticStructureStrength);
        continue;
      }

      const group = createSemanticIsland(island);
      updateSemanticIslandMaterial(group, island, this.semanticStructureStrength);
      this.semanticIslands.set(island.id, { group, signature });
      this.scene.add(group);
    }
  }

  private syncSemanticBridges(): void {
    this.semanticBridgeData = semanticBridgeData(
      this.data,
      this.threads,
      this.hoveredId,
      this.semanticStructureStrength,
      this.editState
    );
    const expectedIds = new Set(this.semanticBridgeData.map((item) => item.id));

    this.semanticBridges.forEach((object, id) => {
      if (expectedIds.has(id)) return;
      this.scene.remove(object.group);
      this.disposeSemanticBridge(object);
      this.semanticBridges.delete(id);
    });

    for (const bridge of this.semanticBridgeData) {
      const signature = semanticBridgeSignature(bridge);
      const current = this.semanticBridges.get(bridge.id);
      if (current && current.signature !== signature) {
        this.scene.remove(current.group);
        this.disposeSemanticBridge(current);
        this.semanticBridges.delete(bridge.id);
      }

      const next = this.semanticBridges.get(bridge.id);
      if (next) {
        updateSemanticBridgeMaterial(next.group, bridge, this.semanticStructureStrength);
        continue;
      }

      const group = createSemanticBridge(bridge);
      updateSemanticBridgeMaterial(group, bridge, this.semanticStructureStrength);
      this.semanticBridges.set(bridge.id, { group, signature });
      this.scene.add(group);
    }
  }

  private updateSemanticTopology(): void {
    if (!this.map) return;

    const presence = semanticTopologyPresence(this.semanticStructureStrength, this.editState);
    if (presence <= 0 || this.data.length === 0) {
      if (this.semanticTopology) {
        this.semanticTopology.group.visible = false;
      }
      return;
    }

    const object = this.ensureSemanticTopology();
    const signature = semanticTopologySignature(
      this.map,
      this.data,
      this.semanticBridgeData,
      this.semanticStructureStrength
    );

    if (object.signature !== signature) {
      const geometry = semanticTopologyGeometry(
        this.map,
        this.data,
        this.semanticBridgeData,
        this.semanticStructureStrength
      );
      const edgeGeometry = new THREE.EdgesGeometry(geometry, 13);
      object.surface.geometry.dispose();
      object.edge.geometry.dispose();
      object.surface.geometry = geometry;
      object.edge.geometry = edgeGeometry;
      object.signature = signature;
    }

    object.group.visible = true;
    object.surface.material.opacity = semanticTopologySurfaceOpacity(presence);
    object.surface.material.needsUpdate = true;
    object.edge.material.opacity = semanticTopologyEdgeOpacity(presence);
    object.edge.material.needsUpdate = true;
  }

  private ensureSemanticTopology(): SemanticTopologyObject {
    if (this.semanticTopology) return this.semanticTopology;

    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    group.frustumCulled = false;
    group.renderOrder = 58;

    const surface = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        vertexColors: true,
        blending: THREE.NormalBlending,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide
      })
    );
    surface.name = "semantic-topology-surface";
    surface.frustumCulled = false;
    surface.renderOrder = 58;

    const edge = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({
        color: "#fff8df",
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false
      })
    );
    edge.name = "semantic-topology-edge";
    edge.frustumCulled = false;
    edge.renderOrder = 60;

    group.add(surface, edge);
    this.scene.add(group);
    this.semanticTopology = { group, surface, edge, signature: "" };
    return this.semanticTopology;
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
    const semanticVisible = this.semanticStructureStrength > 0.001;
    const glowOpacityWeight = mappedCard ? 1 : this.semanticStructureStrength;
    const ideaFormOpacityWeight = mappedCard ? this.semanticStructureStrength : 1;

    object.glow.visible = !this.editState.enabled && (mappedCard || semanticVisible);
    object.glow.material.color.set("#ffffff");
    object.glow.material.map = this.getGlowTexture(color);
    object.glow.material.opacity = nodeGlowOpacity(item, active) * glowOpacityWeight;
    object.glow.material.size = nodeGlowSizePixels(item, active);
    object.glow.material.needsUpdate = true;

    object.ideaForm.visible = !this.editState.enabled && (!mappedCard || semanticVisible);
    updateIdeaFormMaterial(object.ideaForm, item, active, color, ideaFormOpacityWeight);

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

    for (const island of this.semanticIslandData) {
      const object = this.semanticIslands.get(island.id);
      if (!object) continue;
      const elevation = semanticIslandElevationMeters(this.map, island.point, island.prominence, this.semanticStructureStrength);
      const coordinate = MercatorCoordinate.fromLngLat([island.point.lng, island.point.lat], elevation);
      const position = new THREE.Vector3(coordinate.x, coordinate.y, coordinate.z);
      const rotation = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(0, 0, seededUnit(`${island.id}:${island.catchphrase}:yaw`) * Math.PI * 2, "XYZ")
      );
      const meterScale = coordinate.meterInMercatorCoordinateUnits();
      object.group.matrix.compose(position, rotation, new THREE.Vector3(meterScale, meterScale, meterScale));
    }

    const itemById = new Map(this.data.map((item) => [item.node.id, item]));
    for (const bridge of this.semanticBridgeData) {
      const object = this.semanticBridges.get(bridge.id);
      const source = itemById.get(bridge.sourceId);
      const target = itemById.get(bridge.targetId);
      if (!object || !source || !target) continue;

      const sourceCoordinate = semanticBridgeAnchorCoordinate(
        this.map,
        source.node,
        source.point,
        this.semanticStructureStrength
      );
      const targetCoordinate = semanticBridgeAnchorCoordinate(
        this.map,
        target.node,
        target.point,
        this.semanticStructureStrength
      );
      const sourcePosition = new THREE.Vector3(sourceCoordinate.x, sourceCoordinate.y, sourceCoordinate.z);
      const targetPosition = new THREE.Vector3(targetCoordinate.x, targetCoordinate.y, targetCoordinate.z);
      const direction = targetPosition.clone().sub(sourcePosition);
      const length = direction.length();
      if (!Number.isFinite(length) || length < 1e-9) {
        object.group.visible = false;
        continue;
      }

      const midpoint = sourcePosition.clone().add(targetPosition).multiplyScalar(0.5);
      const rotation = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        direction.clone().normalize()
      );
      const averageMeterScale =
        (sourceCoordinate.meterInMercatorCoordinateUnits() + targetCoordinate.meterInMercatorCoordinateUnits()) / 2;
      const width = semanticBridgeWidthMeters(source.node, target.node, bridge.kind) * averageMeterScale;
      const height = semanticBridgeHeightMeters(source.node, target.node, bridge.kind) * averageMeterScale;
      object.group.visible = true;
      object.group.matrix.compose(midpoint, rotation, new THREE.Vector3(width, length, height));
    }

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
    if (this.semanticStructureStrength > 0.001 && !this.editState.overview) {
      this.threadSprite.visible = false;
      this.threadTexture.needsUpdate = true;
      this.threadsDirty = false;
      return;
    }
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

  private disposeSemanticIsland(object: SemanticIslandObject): void {
    disposeObject3d(object.group);
  }

  private disposeSemanticBridge(object: SemanticBridgeObject): void {
    disposeObject3d(object.group);
  }

  private disposeSemanticTopology(object: SemanticTopologyObject): void {
    disposeObject3d(object.group);
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
    const titleText = overviewPrimaryTitle(node);
    const key = `${OVERVIEW_CARD_TEXTURE_VERSION}:${node.id}:${node.shortLabel}:${node.label}:${node.color}:${
      selected ? "selected" : "idle"
    }:title:${titleText}`;
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

function updateIdeaFormMaterial(
  form: THREE.Group,
  item: IdeaLayerDatum,
  active: boolean,
  color: THREE.Color,
  opacityMultiplier = 1
): void {
  form.traverse((child) => {
    const material = (child as THREE.Object3D & { material?: THREE.Material | THREE.Material[] }).material;
    if (!material || Array.isArray(material)) return;

    if (child.name === "idea-solid-glow" && material instanceof THREE.SpriteMaterial) {
      material.color.copy(color);
      material.opacity = ideaSolidGlowOpacity(item, active) * opacityMultiplier;
      material.needsUpdate = true;
      return;
    }

    if (child.name === "idea-solid" && material instanceof THREE.MeshBasicMaterial) {
      material.color.copy(color);
      material.opacity = ideaSolidSurfaceOpacity(item, active) * opacityMultiplier;
      material.needsUpdate = true;
      return;
    }

    if (child.name === "idea-solid-edge" && material instanceof THREE.LineBasicMaterial) {
      material.color.set("#fff8df");
      material.opacity = ideaSolidEdgeOpacity(item, active) * opacityMultiplier;
      material.needsUpdate = true;
      return;
    }

    if (child.name === "idea-solid-orbit" && material instanceof THREE.LineBasicMaterial) {
      material.color.copy(color);
      material.opacity = ideaFormThreadOpacity(item, active) * opacityMultiplier;
      material.needsUpdate = true;
    }
  });
}

function semanticIslandData(
  data: IdeaLayerDatum[],
  hoveredId: string | null,
  groupOutlines: AyaGroupOutline[]
): SemanticIslandDatum[] {
  const clusters = new Map<string, IdeaLayerDatum[]>();
  for (const item of data) {
    const cluster = clusters.get(item.node.topAncestorId) ?? [];
    cluster.push(item);
    clusters.set(item.node.topAncestorId, cluster);
  }

  return [...clusters.entries()]
    .map(([id, items]) => buildSemanticIslandDatum(id, items, hoveredId, groupOutlines))
    .filter((item): item is SemanticIslandDatum => Boolean(item));
}

function semanticBridgeData(
  data: IdeaLayerDatum[],
  threads: IdeaLayerThreadDatum[],
  hoveredId: string | null,
  semanticStructureStrength: number,
  editState: IdeaLayerEditState
): SemanticBridgeDatum[] {
  if (semanticStructureStrength <= 0.001 || editState.overview || editState.enabled) return [];
  const itemById = new Map(data.map((item) => [item.node.id, item]));
  const seen = new Set<string>();
  const bridges: SemanticBridgeDatum[] = [];

  for (const thread of threads) {
    if (!thread.sourceId || !thread.targetId || thread.kind === "card-link") continue;
    const source = itemById.get(thread.sourceId);
    const target = itemById.get(thread.targetId);
    if (!source || !target) continue;
    const [a, b] = thread.sourceId < thread.targetId ? [thread.sourceId, thread.targetId] : [thread.targetId, thread.sourceId];
    const key = `${thread.kind}:${a}:${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bridges.push({
      id: key,
      sourceId: a,
      targetId: b,
      kind: thread.kind,
      color: blendHexColors(source.node.color, target.node.color),
      related: source.related && target.related,
      dimmed: source.dimmed && target.dimmed,
      active: hoveredId === source.node.id || hoveredId === target.node.id
    });
  }

  return bridges;
}

function buildSemanticIslandDatum(
  id: string,
  items: IdeaLayerDatum[],
  hoveredId: string | null,
  groupOutlines: AyaGroupOutline[]
): SemanticIslandDatum | undefined {
  const anchor = items.find((item) => item.node.id === id) ?? items[0];
  if (!anchor) return undefined;

  const descendantMembers = items.filter((item) => item.node.id !== id);
  const semanticMembers = descendantMembers.length > 0 ? descendantMembers : [anchor];
  const sourceOutline = semanticIslandSourceOutline(id, groupOutlines);
  const outlinePoints = sourceOutline?.points ?? [];
  const footprintSourcePoints = outlinePoints.length >= 3 ? outlinePoints : semanticMembers.map((item) => item.point);
  const geographicCenter = averageLngLat(footprintSourcePoints);
  const latReference = geographicCenter.lat || anchor.point.lat;
  const meterOffsets = footprintSourcePoints.map((point) =>
    lngLatMetersOffset(point.lng, point.lat, geographicCenter.lng, geographicCenter.lat, latReference)
  );
  const bounds = meterOffsets.reduce(
    (value, item) => ({
      minX: Math.min(value.minX, item.x),
      maxX: Math.max(value.maxX, item.x),
      minY: Math.min(value.minY, item.y),
      maxY: Math.max(value.maxY, item.y)
    }),
    { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
  );
  const centerOffsetX = (bounds.minX + bounds.maxX) / 2;
  const centerOffsetY = (bounds.minY + bounds.maxY) / 2;
  const maxOffsetX = Math.max(Math.abs(bounds.minX - centerOffsetX), Math.abs(bounds.maxX - centerOffsetX));
  const maxOffsetY = Math.max(Math.abs(bounds.minY - centerOffsetY), Math.abs(bounds.maxY - centerOffsetY));
  const currentCenter = offsetLngLatByMeters(geographicCenter, centerOffsetX, centerOffsetY, latReference);
  const memberCount = semanticMembers.length;
  const radiusX = Math.max(180, maxOffsetX + descendantIslandPaddingMeters(memberCount, "x"));
  const radiusY = Math.max(160, maxOffsetY + descendantIslandPaddingMeters(memberCount, "y"));
  const footprint =
    sourceOutline
      ? semanticIslandOutlineFootprint(sourceOutline, currentCenter, latReference)
      : semanticIslandDescendantFootprint(id, items, semanticMembers, currentCenter, latReference, radiusX, radiusY);
  const semanticBounds = semanticMembers.reduce(
    (value, item) => ({
      minX: Math.min(value.minX, item.point.x),
      maxX: Math.max(value.maxX, item.point.x),
      minY: Math.min(value.minY, item.point.y),
      maxY: Math.max(value.maxY, item.point.y)
    }),
    { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
  );
  const footprintRadius = Math.hypot(maxOffsetX, maxOffsetY);
  const prominence = Math.max(...items.map((item) => item.node.semantic.altitude), anchor.node.semantic.altitude);
  const tierCount = semanticIslandTierCount(anchor, items);
  const catchphrase = overviewCatchphraseText(anchor.node) || normalizeCanvasText(anchor.node.shortLabel) || anchor.node.id;
  const active = items.some((item) => item.node.id === hoveredId);
  const related = items.some((item) => item.related);
  const dimmed = items.every((item) => item.dimmed);

  return {
    id,
    point: {
      ...anchor.point,
      x: (semanticBounds.minX + semanticBounds.maxX) / 2,
      y: (semanticBounds.minY + semanticBounds.maxY) / 2,
      lng: currentCenter.lng,
      lat: currentCenter.lat
    },
    color: anchor.node.color,
    catchphrase,
    radiusX,
    radiusY,
    footprint,
    tierCount,
    baseHeight: clamp(28 + footprintRadius * 0.052 + memberCount * 1.4, 34, 118),
    terraceHeight: clamp(18 + footprintRadius * 0.026 + memberCount * 0.72, 18, 68),
    crownHeight: clamp(42 + prominence * 0.08 + memberCount * 2.1, 46, 142),
    prominence,
    related,
    dimmed,
    active
  };
}

function semanticIslandSignature(island: SemanticIslandDatum): string {
  return [
    island.catchphrase,
    island.color,
    island.radiusX.toFixed(1),
    island.radiusY.toFixed(1),
    island.footprint.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join("|"),
    island.tierCount,
    island.baseHeight.toFixed(1),
    island.terraceHeight.toFixed(1),
    island.crownHeight.toFixed(1)
  ].join(":");
}

function semanticBridgeSignature(bridge: SemanticBridgeDatum): string {
  return `${bridge.kind}:${bridge.color}:${bridge.related ? 1 : 0}:${bridge.dimmed ? 1 : 0}:${bridge.active ? 1 : 0}`;
}

function semanticIslandTierCount(anchor: IdeaLayerDatum, items: IdeaLayerDatum[]): number {
  const maxDepth = Math.max(...items.map((item) => item.node.depth), anchor.node.depth);
  return Math.max(1, Math.min(10, maxDepth - anchor.node.depth + 1));
}

function createSemanticIsland(island: SemanticIslandDatum): THREE.Group {
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;
  group.frustumCulled = false;
  group.renderOrder = 24;

  const color = new THREE.Color(island.color);
  const outlines: THREE.LineSegments[] = [];
  let z = 0;

  for (let index = 0; index < island.tierCount; index += 1) {
    const progress = island.tierCount === 1 ? 0 : index / (island.tierCount - 1);
    const scale = semanticIslandTierScale(progress);
    const footprint = semanticIslandFootprint(island, scale.x, scale.y);
    const height = semanticIslandTierHeight(island, index);
    const geometry = extrudedFootprintGeometry(footprint, height);
    const renderOrder = 24 + index * 2;
    const tier = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        color: semanticIslandTierColor(color, progress),
        transparent: true,
        opacity: 0,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide
      })
    );
    tier.name = index === 0 ? "semantic-island-tier-base" : `semantic-island-tier-${index + 1}`;
    tier.position.z = z;
    tier.renderOrder = renderOrder;
    group.add(tier);

    const edge = createIslandEdges(geometry, `semantic-island-tier-edge-${index + 1}`, renderOrder + 1);
    edge.position.copy(tier.position);
    outlines.push(edge);
    z += height * semanticIslandTierRise(index, island.tierCount);
  }

  group.add(...outlines);

  return group;
}

function semanticIslandTierScale(progress: number): { x: number; y: number } {
  const scale = 1 - progress * 0.72;
  return {
    x: Math.max(0.24, scale),
    y: Math.max(0.22, scale * 0.96 + 0.04)
  };
}

function semanticIslandTierHeight(island: SemanticIslandDatum, index: number): number {
  if (index === 0) return island.baseHeight;
  const progress = island.tierCount === 1 ? 0 : index / (island.tierCount - 1);
  const tierHeight = island.terraceHeight * (1.08 - progress * 0.28);
  const crownBoost = index === island.tierCount - 1 ? island.crownHeight * 0.18 : 0;
  return Math.max(12, tierHeight + crownBoost);
}

function semanticIslandTierRise(index: number, tierCount: number): number {
  if (index === 0) return 0.62;
  const progress = tierCount === 1 ? 0 : index / (tierCount - 1);
  return 0.66 + progress * 0.08;
}

function semanticIslandTierColor(color: THREE.Color, progress: number): THREE.Color {
  const shadow = new THREE.Color("#132133");
  const highlight = new THREE.Color("#fff8e6");
  return color.clone().lerp(progress < 0.18 ? shadow : highlight, progress < 0.18 ? 0.48 : 0.12 + progress * 0.12);
}

function createSemanticBridge(bridge: SemanticBridgeDatum): THREE.Group {
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;
  group.frustumCulled = false;
  group.renderOrder = 34;

  const color = new THREE.Color(bridge.color);
  const shellGeometry = semanticBridgeGeometry(bridge);

  const body = new THREE.Mesh(
    shellGeometry,
    new THREE.MeshBasicMaterial({
      color: color.clone().lerp(new THREE.Color("#152237"), 0.24),
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide
    })
  );
  body.name = "semantic-bridge-body";
  body.renderOrder = 34;
  group.add(body);

  const shell = new THREE.Mesh(
    shellGeometry.clone(),
    new THREE.MeshBasicMaterial({
      color: color.clone().lerp(new THREE.Color("#fff7df"), 0.18),
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide
    })
  );
  shell.name = "semantic-bridge-shell";
  shell.scale.set(1.08, 1.04, 1.16);
  shell.renderOrder = 36;
  group.add(shell);

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(shellGeometry, 22),
    new THREE.LineBasicMaterial({
      color: "#fff8df",
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
  );
  edges.name = "semantic-bridge-edge";
  edges.renderOrder = 38;
  group.add(edges);

  return group;
}

function semanticBridgeGeometry(bridge: SemanticBridgeDatum): THREE.BufferGeometry {
  const seed = seededUnit(`${bridge.id}:topology`);
  const sides = bridge.kind === "parent" ? 7 : bridge.kind === "json" ? 6 : 5;
  const ringFractions = [-0.5, -0.18, 0.08, 0.3, 0.5];
  const ringScaleX = [1.08, 1, 0.92, 0.98, 1.04];
  const ringScaleZ = [1, 1.14, 1.28, 1.08, 0.96];
  const ringLift = [0.02, 0.12, 0.2, 0.12, 0.04];
  const ringDrift = [-0.06, -0.03, 0.04, 0.07, 0.02].map((value) => value + (seed - 0.5) * 0.06);
  const positions: number[] = [];
  const indices: number[] = [];
  const rings: number[][] = [];

  for (let ringIndex = 0; ringIndex < ringFractions.length; ringIndex += 1) {
    const ring: number[] = [];
    const y = ringFractions[ringIndex]!;
    const scaleX = ringScaleX[ringIndex]!;
    const scaleZ = ringScaleZ[ringIndex]!;
    const centerX = ringDrift[ringIndex]!;
    const centerZ = ringLift[ringIndex]!;
    const twist = (seed - 0.5) * 0.56 + ringIndex * 0.08;

    for (let sideIndex = 0; sideIndex < sides; sideIndex += 1) {
      const t = (sideIndex / sides) * Math.PI * 2;
      const facet = 0.84 + Math.sin(t * 2 + seed * Math.PI * 2 + ringIndex * 0.7) * 0.08;
      const shoulder = 0.92 + Math.cos(t * 3 - seed * 3.4 + ringIndex * 0.45) * 0.06;
      const angle = t + twist;
      const x = centerX + Math.cos(angle) * scaleX * facet * shoulder * 0.5;
      const z = centerZ + Math.sin(angle) * scaleZ * shoulder * 0.5;
      ring.push(positions.length / 3);
      positions.push(x, y, z);
    }

    rings.push(ring);
  }

  for (let ringIndex = 0; ringIndex < rings.length - 1; ringIndex += 1) {
    const current = rings[ringIndex]!;
    const next = rings[ringIndex + 1]!;
    for (let sideIndex = 0; sideIndex < sides; sideIndex += 1) {
      const nextSide = (sideIndex + 1) % sides;
      const a = current[sideIndex]!;
      const b = current[nextSide]!;
      const c = next[sideIndex]!;
      const d = next[nextSide]!;
      indices.push(a, c, b, b, c, d);
    }
  }

  const sourceCap = positions.length / 3;
  positions.push(0, -0.5, 0.02);
  const sourceRing = rings[0]!;
  for (let sideIndex = 0; sideIndex < sides; sideIndex += 1) {
    const nextSide = (sideIndex + 1) % sides;
    indices.push(sourceCap, sourceRing[nextSide]!, sourceRing[sideIndex]!);
  }

  const targetCap = positions.length / 3;
  positions.push(0, 0.5, 0.04);
  const targetRing = rings[rings.length - 1]!;
  for (let sideIndex = 0; sideIndex < sides; sideIndex += 1) {
    const nextSide = (sideIndex + 1) % sides;
    indices.push(targetCap, targetRing[sideIndex]!, targetRing[nextSide]!);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function createIslandEdges(geometry: THREE.BufferGeometry, name: string, renderOrder: number): THREE.LineSegments {
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry, 18),
    new THREE.LineBasicMaterial({
      color: "#fff7df",
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
  );
  edges.name = name;
  edges.renderOrder = renderOrder;
  edges.frustumCulled = false;
  return edges;
}

function extrudedFootprintGeometry(points: THREE.Vector2[], depth: number): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape(points);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: false,
    steps: 1,
    curveSegments: Math.max(6, points.length)
  });
  return geometry;
}

function semanticIslandFootprint(
  island: SemanticIslandDatum,
  scaleX: number,
  scaleY: number
): THREE.Vector2[] {
  if (island.footprint.length >= 3) {
    return island.footprint.map((point) => new THREE.Vector2(point.x * scaleX, point.y * scaleY));
  }

  return fallbackSemanticIslandFootprint(island, scaleX, scaleY);
}

function semanticIslandSourceOutline(id: string, groupOutlines: AyaGroupOutline[]): AyaGroupOutline | undefined {
  return (
    groupOutlines.find((outline) => outline.groupId === id && outline.points.length >= 3) ??
    groupOutlines
      .filter((outline) => outline.topAncestorId === id && outline.points.length >= 3)
      .sort((a, b) => a.depth - b.depth)[0]
  );
}

function semanticIslandOutlineFootprint(
  outline: AyaGroupOutline,
  center: { lng: number; lat: number },
  latReference: number
): THREE.Vector2[] {
  const points = outline.points.map((point) => {
    const offset = lngLatMetersOffset(point.lng, point.lat, center.lng, center.lat, latReference);
    return new THREE.Vector2(offset.x, offset.y);
  });

  return ensureClockwisePolygon(uniqueVectorPoints(points));
}

function semanticIslandDescendantFootprint(
  islandId: string,
  items: IdeaLayerDatum[],
  semanticMembers: IdeaLayerDatum[],
  center: { lng: number; lat: number },
  latReference: number,
  radiusX: number,
  radiusY: number
): THREE.Vector2[] {
  const itemById = new Map(items.map((item) => [item.node.id, item]));
  const rawPoints = semanticMembers.flatMap((item) => {
    if (item.node.type === "group") {
      const groupPoint = descendantGroupSemanticPoint(item, semanticMembers, itemById);
      return groupPoint ? [groupPoint] : [item.point];
    }
    return [item.point];
  });
  const localPoints = rawPoints.map((point) => {
    const offset = lngLatMetersOffset(point.lng, point.lat, center.lng, center.lat, latReference);
    return new THREE.Vector2(offset.x, offset.y);
  });
  const uniquePoints = uniqueVectorPoints(localPoints);
  const seed = seededUnit(`${islandId}:descendant-footprint`);

  if (uniquePoints.length < 3) {
    return fallbackFootprintFromPoints(uniquePoints, radiusX, radiusY, seed);
  }

  const hull = convexHull(uniquePoints);
  if (hull.length < 3) {
    return fallbackFootprintFromPoints(uniquePoints, radiusX, radiusY, seed);
  }

  return padHull(hull, descendantIslandShapePadding(uniquePoints.length));
}

function descendantGroupSemanticPoint(
  group: IdeaLayerDatum,
  semanticMembers: IdeaLayerDatum[],
  itemById: Map<string, IdeaLayerDatum>
): AyaSpatialPoint | undefined {
  const descendants = semanticMembers.filter(
    (item) => item.node.id !== group.node.id && isDescendantNode(item.node, group.node.id, itemById)
  );
  const source = descendants.length > 0 ? descendants : [group];
  const center = averageLngLat(source.map((item) => item.point));
  const semanticX = average(source.map((item) => item.point.x));
  const semanticY = average(source.map((item) => item.point.y));

  return {
    ...group.point,
    x: semanticX,
    y: semanticY,
    lng: center.lng,
    lat: center.lat
  };
}

function isDescendantNode(
  node: AyaNode,
  ancestorId: string,
  itemById: Map<string, IdeaLayerDatum>
): boolean {
  let parentId = node.parentId;
  const seen = new Set<string>();

  while (parentId && !seen.has(parentId)) {
    if (parentId === ancestorId) return true;
    seen.add(parentId);
    parentId = itemById.get(parentId)?.node.parentId;
  }

  return false;
}

function uniqueVectorPoints(points: THREE.Vector2[]): THREE.Vector2[] {
  const seen = new Set<string>();
  const unique: THREE.Vector2[] = [];

  for (const point of points) {
    const key = `${point.x.toFixed(2)}:${point.y.toFixed(2)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(point);
  }

  return unique;
}

function convexHull(points: THREE.Vector2[]): THREE.Vector2[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const lower: THREE.Vector2[] = [];
  const upper: THREE.Vector2[] = [];

  for (const point of sorted) {
    while (lower.length >= 2 && cross2d(lower[lower.length - 2]!, lower[lower.length - 1]!, point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  }

  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const point = sorted[index]!;
    while (upper.length >= 2 && cross2d(upper[upper.length - 2]!, upper[upper.length - 1]!, point) <= 0) {
      upper.pop();
    }
    upper.push(point);
  }

  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

function padHull(points: THREE.Vector2[], padding: number): THREE.Vector2[] {
  const center = averageVector(points);
  return points.map((point) => {
    const direction = point.clone().sub(center);
    const length = direction.length();
    if (length < 1e-6) return point.clone();
    return point.clone().add(direction.multiplyScalar(padding / length));
  });
}

function ensureClockwisePolygon(points: THREE.Vector2[]): THREE.Vector2[] {
  if (points.length < 3) return points;
  return polygonSignedArea(points) > 0 ? [...points].reverse() : points;
}

function fallbackFootprintFromPoints(
  points: THREE.Vector2[],
  radiusX: number,
  radiusY: number,
  seed: number
): THREE.Vector2[] {
  const center = points.length > 0 ? averageVector(points) : new THREE.Vector2(0, 0);
  const count = points.length === 2 ? 6 : 8;
  const shape: THREE.Vector2[] = [];

  for (let index = 0; index < count; index += 1) {
    const t = (index / count) * Math.PI * 2;
    const wobble = 0.9 + Math.sin(t * 3 + seed * Math.PI * 2) * 0.08;
    shape.push(
      new THREE.Vector2(
        center.x + Math.cos(t) * radiusX * wobble,
        center.y + Math.sin(t) * radiusY * (0.92 + Math.cos(t * 2 + seed * 3) * 0.06)
      )
    );
  }

  return shape;
}

function fallbackSemanticIslandFootprint(
  island: SemanticIslandDatum,
  scaleX: number,
  scaleY: number
): THREE.Vector2[] {
  const seed = seededUnit(`${island.id}:${island.catchphrase}:footprint`);
  const count = 7 + Math.floor(seededUnit(`${island.id}:facets`) * 3);
  const points: THREE.Vector2[] = [];
  const radiusX = island.radiusX * scaleX;
  const radiusY = island.radiusY * scaleY;

  for (let index = 0; index < count; index += 1) {
    const t = (index / count) * Math.PI * 2;
    const ridge = 0.82 + Math.sin(t * 2 + seed * Math.PI * 2) * 0.08;
    const notch = 0.92 + Math.cos(t * 3 + seed * 4.1) * 0.1;
    const drift = 1 + Math.sin(t * 5 + seed * 5.4) * 0.06;
    const x = Math.cos(t) * radiusX * ridge * notch;
    const y = Math.sin(t) * radiusY * notch * drift;
    points.push(new THREE.Vector2(x, y));
  }

  return points;
}

function descendantIslandShapePadding(pointCount: number): number {
  return 78 + Math.min(96, Math.sqrt(Math.max(1, pointCount)) * 14);
}

function averageVector(points: THREE.Vector2[]): THREE.Vector2 {
  if (points.length === 0) return new THREE.Vector2(0, 0);
  return points.reduce((sum, point) => sum.add(point), new THREE.Vector2()).multiplyScalar(1 / points.length);
}

function cross2d(origin: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2): number {
  return (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
}

function polygonSignedArea(points: THREE.Vector2[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    area += current.x * next.y - next.x * current.y;
  }
  return area / 2;
}

function updateSemanticIslandMaterial(
  group: THREE.Group,
  island: SemanticIslandDatum,
  semanticStructureStrength: number
): void {
  const activeBoost = island.active ? 1.16 : 1;
  const relatedOpacity = island.related ? 1 : 0.56;
  const dimOpacity = island.dimmed ? 0.24 : 1;
  const strength = clamp(semanticStructureStrength, 0, 1) * relatedOpacity * dimOpacity;
  const baseOpacity = Math.min(0.42, 0.18 + strength * 0.26) * activeBoost;
  const tierOpacity = Math.min(0.54, 0.14 + strength * 0.34) * activeBoost;
  const edgeOpacity = Math.min(0.72, 0.12 + strength * 0.44) * activeBoost;

  group.visible = strength > 0.001;
  group.traverse((child) => {
    const material = (child as THREE.Object3D & { material?: THREE.Material | THREE.Material[] }).material;
    if (!material || Array.isArray(material)) return;

    if (child.name === "semantic-island-tier-base" && material instanceof THREE.MeshBasicMaterial) {
      material.opacity = baseOpacity;
      material.needsUpdate = true;
      return;
    }

    if (child.name.startsWith("semantic-island-tier-") && material instanceof THREE.MeshBasicMaterial) {
      material.opacity = tierOpacity;
      material.needsUpdate = true;
      return;
    }

    if (child.name.startsWith("semantic-island-") && material instanceof THREE.LineBasicMaterial) {
      material.opacity = edgeOpacity;
      material.needsUpdate = true;
    }
  });
}

function updateSemanticBridgeMaterial(
  group: THREE.Group,
  bridge: SemanticBridgeDatum,
  semanticStructureStrength: number
): void {
  const relatedOpacity = bridge.related ? 1 : 0.5;
  const dimOpacity = bridge.dimmed ? 0.24 : 1;
  const activeBoost = bridge.active ? 1.18 : 1;
  const strength = clamp(semanticStructureStrength, 0, 1) * relatedOpacity * dimOpacity;
  const bodyOpacity = Math.min(0.58, 0.18 + strength * 0.34) * activeBoost;
  const shellOpacity = Math.min(0.46, 0.1 + strength * 0.26) * activeBoost;
  const edgeOpacity = Math.min(0.84, 0.14 + strength * 0.48) * activeBoost;

  group.visible = strength > 0.001;
  group.traverse((child) => {
    const material = (child as THREE.Object3D & { material?: THREE.Material | THREE.Material[] }).material;
    if (!material || Array.isArray(material)) return;

    if (child.name === "semantic-bridge-body" && material instanceof THREE.MeshBasicMaterial) {
      material.opacity = bodyOpacity;
      material.needsUpdate = true;
      return;
    }

    if (child.name === "semantic-bridge-shell" && material instanceof THREE.MeshBasicMaterial) {
      material.opacity = shellOpacity;
      material.needsUpdate = true;
      return;
    }

    if (child.name === "semantic-bridge-edge" && material instanceof THREE.LineBasicMaterial) {
      material.opacity = edgeOpacity;
      material.needsUpdate = true;
    }
  });
}

function semanticTopologyGeometry(
  map: MapLibreMap,
  data: IdeaLayerDatum[],
  bridges: SemanticBridgeDatum[],
  semanticStructureStrength: number
): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const nodeMeta = new Map<string, SemanticTopologyNodeMeta>();

  for (const item of data) {
    const color = new THREE.Color(item.node.color);
    const geometry = platonicSolidGeometry(platonicSolidKind(item.node));
    const solidScale = platonicSolidScale(item.node, platonicSolidKind(item.node));
    const elevation = nodeElevationMeters(map, item.node, item.point) + semanticLiftMeters(item.node, semanticStructureStrength);
    const coordinate = MercatorCoordinate.fromLngLat([item.point.lng, item.point.lat], elevation);
    const meterScale = coordinate.meterInMercatorCoordinateUnits();
    const center = new THREE.Vector3(coordinate.x, coordinate.y, coordinate.z);
    const ideaScale = nodeIdeaFormScale(item, false);
    const baseTransform = new THREE.Matrix4().compose(
      center,
      ideaFormRotation(item.node),
      new THREE.Vector3(
        ideaScale.width * 1.28 * meterScale,
        ideaScale.width * 0.86 * meterScale,
        ideaScale.height * 0.28 * meterScale
      )
    );
    const solidTransform = new THREE.Matrix4().makeScale(solidScale.x, solidScale.y, solidScale.z);
    const transformed = baseTransform.multiply(solidTransform);
    const start = positions.length / 3;

    appendTransformedGeometry(geometry, transformed, color, positions, colors, indices);
    geometry.dispose();
    nodeMeta.set(item.node.id, {
      id: item.node.id,
      center,
      color,
      vertexStart: start,
      vertexCount: positions.length / 3 - start
    });
  }

  for (const bridge of bridges) {
    const source = nodeMeta.get(bridge.sourceId);
    const target = nodeMeta.get(bridge.targetId);
    if (!source || !target) continue;

    appendTopologyBridge(bridge, source, target, positions, colors, indices);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function appendTransformedGeometry(
  geometry: THREE.BufferGeometry,
  transform: THREE.Matrix4,
  color: THREE.Color,
  positions: number[],
  colors: number[],
  indices: number[]
): void {
  const offset = positions.length / 3;
  const positionAttribute = geometry.getAttribute("position") as THREE.BufferAttribute;
  const vertex = new THREE.Vector3();
  const softenedColor = color.clone().lerp(new THREE.Color("#fff8df"), 0.1);

  for (let index = 0; index < positionAttribute.count; index += 1) {
    vertex
      .set(positionAttribute.getX(index), positionAttribute.getY(index), positionAttribute.getZ(index))
      .applyMatrix4(transform);
    positions.push(vertex.x, vertex.y, vertex.z);
    colors.push(softenedColor.r, softenedColor.g, softenedColor.b);
  }

  const geometryIndex = geometry.getIndex();
  if (geometryIndex) {
    for (let index = 0; index < geometryIndex.count; index += 3) {
      indices.push(
        offset + geometryIndex.getX(index),
        offset + geometryIndex.getX(index + 1),
        offset + geometryIndex.getX(index + 2)
      );
    }
    return;
  }

  for (let index = 0; index < positionAttribute.count; index += 3) {
    indices.push(offset + index, offset + index + 1, offset + index + 2);
  }
}

function appendTopologyBridge(
  bridge: SemanticBridgeDatum,
  source: SemanticTopologyNodeMeta,
  target: SemanticTopologyNodeMeta,
  positions: number[],
  colors: number[],
  indices: number[]
): void {
  const direction = target.center.clone().sub(source.center);
  const length = direction.length();
  if (!Number.isFinite(length) || length < 1e-9) return;

  const axis = direction.multiplyScalar(1 / length);
  const sourceRadius = topologyNodeRadiusAlong(source, axis, positions);
  const targetRadius = topologyNodeRadiusAlong(target, axis.clone().multiplyScalar(-1), positions);
  const sourceInset = Math.min(sourceRadius * 0.82, length * 0.28);
  const targetInset = Math.min(targetRadius * 0.82, length * 0.28);
  const sourceCenter = source.center.clone().addScaledVector(axis, sourceInset);
  const targetCenter = target.center.clone().addScaledVector(axis, -targetInset);
  const bridgeLength = sourceCenter.distanceTo(targetCenter);
  if (!Number.isFinite(bridgeLength) || bridgeLength < 1e-9) return;

  const sides = semanticTopologyBridgeSides(bridge.kind);
  const radiusBase = Math.min(sourceRadius, targetRadius) * semanticTopologyBridgeRadiusRatio(bridge.kind);
  const radius = Math.max(radiusBase, Math.min(sourceRadius, targetRadius) * 0.12);
  const sourceRing = appendTopologyRing(sourceCenter, axis, radius, sides, source.color, positions, colors);
  const targetRing = appendTopologyRing(targetCenter, axis, radius, sides, target.color, positions, colors);

  for (let sideIndex = 0; sideIndex < sides; sideIndex += 1) {
    const nextSide = (sideIndex + 1) % sides;
    const a = sourceRing[sideIndex]!;
    const b = sourceRing[nextSide]!;
    const c = targetRing[sideIndex]!;
    const d = targetRing[nextSide]!;
    indices.push(a, c, b, b, c, d);
  }

  appendTopologyWeld(nearestNodeVertex(source, sourceCenter, positions), sourceRing, indices, false);
  appendTopologyWeld(nearestNodeVertex(target, targetCenter, positions), targetRing, indices, true);
}

function appendTopologyRing(
  center: THREE.Vector3,
  axis: THREE.Vector3,
  radius: number,
  sides: number,
  color: THREE.Color,
  positions: number[],
  colors: number[]
): number[] {
  const { right, up } = perpendicularBasis(axis);
  const ring: number[] = [];
  const softenedColor = color.clone().lerp(new THREE.Color("#fff8df"), 0.18);

  for (let sideIndex = 0; sideIndex < sides; sideIndex += 1) {
    const angle = (sideIndex / sides) * Math.PI * 2;
    const facetRadius = radius * (0.92 + (sideIndex % 2) * 0.08);
    const position = center
      .clone()
      .addScaledVector(right, Math.cos(angle) * facetRadius)
      .addScaledVector(up, Math.sin(angle) * facetRadius);
    ring.push(positions.length / 3);
    positions.push(position.x, position.y, position.z);
    colors.push(softenedColor.r, softenedColor.g, softenedColor.b);
  }

  return ring;
}

function appendTopologyWeld(anchor: number, ring: number[], indices: number[], reverse: boolean): void {
  for (let sideIndex = 0; sideIndex < ring.length; sideIndex += 1) {
    const nextSide = (sideIndex + 1) % ring.length;
    if (reverse) {
      indices.push(anchor, ring[sideIndex]!, ring[nextSide]!);
    } else {
      indices.push(anchor, ring[nextSide]!, ring[sideIndex]!);
    }
  }
}

function topologyNodeRadiusAlong(
  node: SemanticTopologyNodeMeta,
  direction: THREE.Vector3,
  positions: number[]
): number {
  let radius = 0;
  const vertex = new THREE.Vector3();

  for (let index = 0; index < node.vertexCount; index += 1) {
    const offset = (node.vertexStart + index) * 3;
    vertex.set(positions[offset]!, positions[offset + 1]!, positions[offset + 2]!);
    radius = Math.max(radius, vertex.sub(node.center).dot(direction));
  }

  return Math.max(radius, 1e-9);
}

function nearestNodeVertex(node: SemanticTopologyNodeMeta, point: THREE.Vector3, positions: number[]): number {
  let nearest = node.vertexStart;
  let nearestDistance = Number.POSITIVE_INFINITY;
  const vertex = new THREE.Vector3();

  for (let index = 0; index < node.vertexCount; index += 1) {
    const vertexIndex = node.vertexStart + index;
    const offset = vertexIndex * 3;
    vertex.set(positions[offset]!, positions[offset + 1]!, positions[offset + 2]!);
    const distance = vertex.distanceToSquared(point);
    if (distance < nearestDistance) {
      nearest = vertexIndex;
      nearestDistance = distance;
    }
  }

  return nearest;
}

function perpendicularBasis(axis: THREE.Vector3): { right: THREE.Vector3; up: THREE.Vector3 } {
  const reference = Math.abs(axis.z) > 0.92 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
  const right = new THREE.Vector3().crossVectors(axis, reference).normalize();
  const up = new THREE.Vector3().crossVectors(right, axis).normalize();
  return { right, up };
}

function semanticTopologyBridgeSides(kind: IdeaLayerThreadDatum["kind"]): number {
  if (kind === "parent") return 7;
  if (kind === "json") return 6;
  return 5;
}

function semanticTopologyBridgeRadiusRatio(kind: IdeaLayerThreadDatum["kind"]): number {
  if (kind === "parent") return 0.24;
  if (kind === "json") return 0.2;
  if (kind === "sibling") return 0.18;
  return 0.16;
}

function semanticTopologySignature(
  map: MapLibreMap,
  data: IdeaLayerDatum[],
  bridges: SemanticBridgeDatum[],
  semanticStructureStrength: number
): string {
  const nodeParts = data.map((item) => {
    const terrain = map.queryTerrainElevation([item.point.lng, item.point.lat]) ?? 0;
    return [
      item.node.id,
      item.node.type,
      item.node.depth,
      item.node.color,
      item.point.lng.toFixed(7),
      item.point.lat.toFixed(7),
      item.point.altitude.toFixed(2),
      terrain.toFixed(1)
    ].join(",");
  });
  const bridgeParts = bridges.map((bridge) =>
    [bridge.kind, bridge.sourceId, bridge.targetId, bridge.color].join(",")
  );
  return [
    semanticStructureStrength.toFixed(3),
    nodeParts.join("|"),
    bridgeParts.join("|")
  ].join("::");
}

function semanticTopologyPresence(
  semanticStructureStrength: number,
  editState: IdeaLayerEditState
): number {
  if (editState.enabled || editState.overview) return 0;
  return smoothstep(0.86, 1, semanticStructureStrength);
}

function semanticTopologySurfaceOpacity(presence: number): number {
  return 0.34 * presence;
}

function semanticTopologyEdgeOpacity(presence: number): number {
  return 0.7 * presence;
}

function semanticIslandElevationMeters(
  map: MapLibreMap,
  point: AyaSpatialPoint,
  prominence: number,
  semanticStructureStrength: number
): number {
  const terrainElevation = map.queryTerrainElevation([point.lng, point.lat]) ?? 0;
  return terrainElevation + 8 + prominence * 0.04 * clamp(semanticStructureStrength, 0, 1);
}

function averageLngLat(points: AyaSpatialPoint[]): { lng: number; lat: number } {
  if (points.length === 0) {
    return { lng: 0, lat: 0 };
  }
  return {
    lng: points.reduce((sum, point) => sum + point.lng, 0) / points.length,
    lat: points.reduce((sum, point) => sum + point.lat, 0) / points.length
  };
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function offsetLngLatByMeters(
  center: { lng: number; lat: number },
  eastMeters: number,
  northMeters: number,
  latReference: number
): { lng: number; lat: number } {
  return {
    lng: center.lng + eastMeters / metersPerDegreeLng(latReference),
    lat: center.lat + northMeters / 111_320
  };
}

function descendantIslandPaddingMeters(memberCount: number, axis: "x" | "y"): number {
  const base = axis === "x" ? 168 : 152;
  return base + Math.min(96, Math.sqrt(Math.max(1, memberCount)) * 16);
}

function metersPerDegreeLng(lat: number): number {
  return Math.max(1, 111_320 * Math.cos((lat * Math.PI) / 180));
}

function semanticBridgeAnchorCoordinate(
  map: MapLibreMap,
  node: AyaNode,
  point: AyaSpatialPoint,
  semanticStructureStrength: number
): MercatorCoordinate {
  const elevation =
    nodeElevationMeters(map, node, point) +
    semanticLiftMeters(node, semanticStructureStrength) +
    (node.type === "group" ? 4 : 2.5);
  return MercatorCoordinate.fromLngLat([point.lng, point.lat], elevation);
}

function semanticBridgeWidthMeters(source: AyaNode, target: AyaNode, kind: IdeaLayerThreadDatum["kind"]): number {
  if (kind === "parent") return source.type === "group" || target.type === "group" ? 30 : 22;
  if (kind === "json") return 19;
  if (kind === "sibling") return 17;
  return 15;
}

function semanticBridgeHeightMeters(source: AyaNode, target: AyaNode, kind: IdeaLayerThreadDatum["kind"]): number {
  if (kind === "parent") return source.type === "group" || target.type === "group" ? 22 : 16;
  if (kind === "json") return 14;
  if (kind === "sibling") return 12;
  return 11;
}

function blendHexColors(left: string, right: string): string {
  const a = new THREE.Color(left);
  const b = new THREE.Color(right);
  return `#${a.lerp(b, 0.5).getHexString()}`;
}

function lngLatMetersOffset(
  lng: number,
  lat: number,
  centerLng: number,
  centerLat: number,
  latReference: number
): { x: number; y: number } {
  const metersPerDegreeLng = 111_320 * Math.cos((latReference * Math.PI) / 180);
  return {
    x: (lng - centerLng) * metersPerDegreeLng,
    y: (lat - centerLat) * 111_320
  };
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

function semanticLiftMeters(node: AyaNode, semanticStructureStrength: number): number {
  const maxLift = node.type === "group" ? 26 : 18;
  return maxLift * clamp(semanticStructureStrength, 0, 1);
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
  const catchphraseText = overviewCatchphraseText(node);
  const titleText = overviewPrimaryTitle(node);
  context.save();

  if (selected) {
    context.shadowColor = "rgba(255, 123, 95, 0.28)";
    context.shadowBlur = 54;
    context.shadowOffsetY = 0;
    roundedRect(context, card.x - 8, card.y - 8, card.width + 16, card.height + 16, card.radius + 10);
    context.fillStyle = "rgba(255, 244, 229, 0.2)";
    context.fill();
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

  if (selected) {
    context.fillStyle = "rgba(255, 248, 239, 0.16)";
    roundedRect(context, card.x + 8, card.y + 8, card.width - 16, card.height - 16, card.radius - 4);
    context.fill();

    context.shadowColor = "rgba(255, 255, 255, 0.42)";
    context.shadowBlur = 20;
    context.shadowOffsetY = 0;
    context.lineWidth = 6;
    context.strokeStyle = "rgba(255, 252, 245, 0.94)";
    roundedRect(context, card.x + 6, card.y + 6, card.width - 12, card.height - 12, card.radius - 3);
    context.stroke();

    context.shadowColor = "transparent";
    context.lineWidth = 3;
    context.strokeStyle = "rgba(228, 96, 72, 0.86)";
    roundedRect(context, card.x + 13, card.y + 13, card.width - 26, card.height - 26, card.radius - 7);
    context.stroke();
  }

  context.fillStyle = rgbaString(color, 0.74);
  roundedRect(context, card.x + 16, card.y + 22, accentWidth, card.height - 44, Math.min(8, accentWidth / 2));
  context.fill();

  if (selected) {
    context.fillStyle = "rgba(255, 241, 231, 0.5)";
    roundedRect(context, card.x + 12, card.y + 18, 10, card.height - 36, 5);
    context.fill();
  }

  context.fillStyle = "#3a2e27";
  context.textBaseline = "top";
  let y = card.y + 28;
  if (catchphraseText) {
    const badgePaddingX = 16;
    const badgePaddingY = 8;
    const badgeMaxWidth = Math.min(textWidth, 276);
    const badgeLayout = fitCanvasTextBlock(context, catchphraseText, badgeMaxWidth - badgePaddingX * 2, 52, {
      maxFontSize: 17,
      minFontSize: 12,
      lineHeightMultiplier: 1.18,
      fontWeight: 800,
      maxLines: 2
    });
    const badgeTextWidth = badgeLayout.lines.reduce(
      (maxWidth, line) => Math.max(maxWidth, context.measureText(line).width),
      0
    );
    const badgeWidth = Math.min(textWidth, Math.max(128, Math.ceil(badgeTextWidth + badgePaddingX * 2)));
    const badgeHeight = Math.ceil(badgeLayout.lines.length * badgeLayout.lineHeight + badgePaddingY * 2);

    context.fillStyle = selected ? "rgba(255, 250, 242, 0.92)" : "rgba(255, 250, 242, 0.8)";
    context.strokeStyle = rgbaString(color, selected ? 0.36 : 0.28);
    context.lineWidth = 2;
    roundedRect(context, textLeft, y, badgeWidth, badgeHeight, Math.min(14, badgeHeight / 2));
    context.fill();
    context.stroke();

    context.fillStyle = color.clone().lerp(new THREE.Color("#5a4033"), 0.52).getStyle();
    context.font = canvasFont(badgeLayout.fontWeight, badgeLayout.fontSize);
    let badgeY = y + badgePaddingY;
    for (const line of badgeLayout.lines) {
      context.fillText(line, textLeft + badgePaddingX, badgeY);
      badgeY += badgeLayout.lineHeight;
    }

    context.fillStyle = "#3a2e27";
    y += badgeHeight + 18;
  }

  const titleLayout = fitCanvasTextBlock(context, titleText, textWidth, card.height - (y - card.y) - 28, {
    maxFontSize: catchphraseText ? 28 : 31,
    minFontSize: 14,
    lineHeightMultiplier: 1.24,
    fontWeight: 700
  });
  context.font = canvasFont(titleLayout.fontWeight, titleLayout.fontSize);
  for (const line of titleLayout.lines) {
    context.fillText(line, textLeft, y);
    y += titleLayout.lineHeight;
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
  const glowWidth = Math.max(1.6, thread.width * 1.65) * pixelRatio;
  const coreWidth = Math.max(0.85, thread.width * 0.58) * pixelRatio;
  const dash = thread.kind === "card-link" ? [3.5 * pixelRatio, 6 * pixelRatio] : [];

  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = glowWidth;
  context.strokeStyle = threadGlowStrokeStyle(thread.kind);
  context.shadowColor = threadShadowColor(thread.kind);
  context.shadowBlur = Math.max(8, thread.width * 3.4) * pixelRatio;
  context.setLineDash(dash);
  traceThreadPath(context, thread, source, target, midX, midY);
  context.stroke();

  context.shadowColor = "transparent";
  context.shadowBlur = 0;
  context.lineWidth = coreWidth;
  context.strokeStyle = threadCoreStrokeStyle(thread.kind);
  context.setLineDash(dash);
  traceThreadPath(context, thread, source, target, midX, midY);
  context.stroke();
  context.restore();
}

function traceThreadPath(
  context: CanvasRenderingContext2D,
  thread: IdeaLayerThreadDatum,
  source: { x: number; y: number },
  target: { x: number; y: number },
  midX: number,
  midY: number
): void {
  context.beginPath();
  context.moveTo(source.x, source.y);
  if (thread.kind === "card-link") {
    context.lineTo(target.x, target.y);
  } else if (thread.kind === "family") {
    const joinY = (source.y + target.y) / 2;
    context.lineTo(source.x, joinY);
    context.lineTo(target.x, joinY);
    context.lineTo(target.x, target.y);
  } else {
    context.quadraticCurveTo(midX, midY, target.x, target.y);
  }
}

function threadGlowStrokeStyle(kind: IdeaLayerThreadDatum["kind"]): string {
  if (kind === "card-link") return "rgba(255, 133, 150, 0.22)";
  if (kind === "parent" || kind === "family") return "rgba(152, 231, 255, 0.22)";
  if (kind === "sibling") return "rgba(255, 210, 130, 0.18)";
  return "rgba(255, 240, 190, 0.24)";
}

function threadCoreStrokeStyle(kind: IdeaLayerThreadDatum["kind"]): string {
  if (kind === "card-link") return "rgba(255, 214, 220, 0.88)";
  if (kind === "parent" || kind === "family") return "rgba(229, 251, 255, 0.9)";
  if (kind === "sibling") return "rgba(255, 243, 214, 0.84)";
  return "rgba(255, 248, 226, 0.9)";
}

function threadShadowColor(kind: IdeaLayerThreadDatum["kind"]): string {
  if (kind === "card-link") return "rgba(255, 146, 156, 0.32)";
  if (kind === "parent" || kind === "family") return "rgba(106, 202, 248, 0.34)";
  if (kind === "sibling") return "rgba(255, 192, 92, 0.28)";
  return "rgba(255, 222, 150, 0.36)";
}

function canvasPixelRatio(map: MapLibreMap): number {
  const canvas = map.getCanvas();
  return canvas.clientWidth > 0 ? canvas.width / canvas.clientWidth : window.devicePixelRatio || 1;
}

function wrapCanvasText(context: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines?: number): string[] {
  const normalized = normalizeCanvasText(text);
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
    if (typeof maxLines === "number" && lines.length >= maxLines) break;
  }

  if (current && (typeof maxLines !== "number" || lines.length < maxLines)) lines.push(current);
  if (
    typeof maxLines === "number" &&
    lines.length === maxLines &&
    context.measureText(lines[lines.length - 1]!).width > maxWidth
  ) {
    lines[lines.length - 1] = truncateCanvasText(context, lines[lines.length - 1]!, maxWidth);
  }
  return lines;
}

function fitCanvasTextBlock(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxHeight: number,
  options: {
    maxFontSize: number;
    minFontSize: number;
    lineHeightMultiplier: number;
    fontWeight: number;
    maxLines?: number;
  }
): { lines: string[]; fontSize: number; lineHeight: number; fontWeight: number } {
  const normalized = normalizeCanvasText(text);
  if (!normalized) {
    return {
      lines: [],
      fontSize: options.minFontSize,
      lineHeight: Math.round(options.minFontSize * options.lineHeightMultiplier),
      fontWeight: options.fontWeight
    };
  }

  for (let fontSize = options.maxFontSize; fontSize >= options.minFontSize; fontSize -= 1) {
    context.font = canvasFont(options.fontWeight, fontSize);
    const lines = wrapCanvasText(context, normalized, maxWidth, options.maxLines);
    const lineHeight = Math.round(fontSize * options.lineHeightMultiplier);
    if (lines.length * lineHeight <= maxHeight) {
      return { lines, fontSize, lineHeight, fontWeight: options.fontWeight };
    }
  }

  const fallbackFontSize = options.minFontSize;
  context.font = canvasFont(options.fontWeight, fallbackFontSize);
  return {
    lines: wrapCanvasText(context, normalized, maxWidth, options.maxLines),
    fontSize: fallbackFontSize,
    lineHeight: Math.round(fallbackFontSize * options.lineHeightMultiplier),
    fontWeight: options.fontWeight
  };
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

function normalizeCanvasText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function canvasFont(weight: number, size: number): string {
  return `${weight} ${size}px Inter, "Yu Gothic UI", Meiryo, sans-serif`;
}

function overviewCatchphraseText(node: AyaNode): string {
  const shortLabel = normalizeCanvasText(node.shortLabel);
  const label = normalizeCanvasText(node.label);
  return shortLabel.length > 0 && label.length > 0 && shortLabel !== label ? shortLabel : "";
}

function overviewPrimaryTitle(node: AyaNode): string {
  const shortLabel = normalizeCanvasText(node.shortLabel);
  const label = normalizeCanvasText(node.label);
  return overviewCatchphraseText(node) ? label : shortLabel || label;
}

function seededUnit(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
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
