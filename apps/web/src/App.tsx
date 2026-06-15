import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { MercatorCoordinate, type Map as MapLibreMap, type PointLike } from "maplibre-gl";
import {
  Blend,
  CircleHelp,
  Eye,
  Map as MapIcon,
  MapPin,
  RotateCcw,
  Share2,
  Sparkles,
  Upload,
  X
} from "lucide-react";
import {
  DEFAULT_CENTER,
  getHypoWeaveSnapshot,
  interpolatePoint,
  normalizeHypoWeave,
  parseManualCenter,
  toPlacementInputs
} from "@ayatopos/shared";
import type {
  AyaGraph,
  AyaGroupOutline,
  AyaNode,
  AyaSpatialPoint,
  GeoCenter,
  GeoPlacement,
  HypoWeaveExport
} from "@ayatopos/shared";
import { requestPlacements, resolveArea } from "./api";
import {
  addIdeaObjectLayer,
  nodeElevationMeters,
  type IdeaLayerCardLayout,
  type IdeaLayerDatum,
  type IdeaLayerThreadDatum,
  type IdeaObjectLayer
} from "./ideaLayer";
import { ensureTerrain, mapStyle, setSemanticMapPresence, setSemanticSkyTransition } from "./mapStyle";

type LoadState = "idle" | "loading" | "ready" | "error";
type ViewMode = "view" | "editGeo";
type ManualPlacementRecord = Record<string, GeoPlacement>;

interface ScreenNode {
  node: AyaNode;
  point: AyaSpatialPoint;
  screen: { x: number; y: number };
  related: boolean;
  dimmed: boolean;
}

interface VisualThread {
  id: string;
  source: string;
  target: string;
  kind: "json" | "parent" | "sibling";
}

interface StoredMapView {
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
}

interface MapPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface FocusMapOptions {
  padding?: MapPadding;
  maxZoom?: number;
  duration?: number;
  pitch?: number;
  bearing?: number;
  majorityFraction?: number;
  singlePointZoom?: number;
}

interface TooltipLayout {
  item: ScreenNode;
  left: number;
  top: number;
  width?: number;
}

type OverviewRelationKind = "selected" | "parent" | "sibling" | "other";

const DEFAULT_AREA_TEXT = "33.183323,129.882173";
const DEFAULT_SAMPLE_PATH = "/samples/arita-demo.json";
const DEFAULT_SAMPLE_FILENAME = "arita-demo.json";
const METERS_PER_DEGREE_LAT = 111_320;
const INITIAL_MAP_CENTER: GeoCenter = {
  lng: 139.767125,
  lat: 35.681236,
  label: "Tokyo Station, Japan"
};

export function App() {
  const [rawExport, setRawExport] = useState<HypoWeaveExport | null>(null);
  const [fileName, setFileName] = useState("");
  const [areaText, setAreaText] = useState(DEFAULT_AREA_TEXT);
  const [graph, setGraph] = useState<AyaGraph | null>(null);
  const [blend, setBlend] = useState(0.28);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [status, setStatus] = useState<LoadState>("idle");
  const [currentCenter, setCurrentCenter] = useState<GeoCenter | null>(null);
  const [basePlacements, setBasePlacements] = useState<GeoPlacement[]>([]);
  const [manualPlacements, setManualPlacements] = useState<ManualPlacementRecord>({});
  const [viewMode, setViewMode] = useState<ViewMode>("view");
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const loadedManualKeyRef = useRef<string | null>(null);
  const [message, setMessage] = useState("JSONと中心エリアを指定してください。");

  const manualStorageKey = useMemo(
    () => (rawExport && currentCenter ? manualGeoStorageKey(currentCenter, fileName, rawExport) : null),
    [currentCenter, fileName, rawExport]
  );
  const isFullyGeographic = blend >= 0.999;
  const semanticStructureStrength = useMemo(() => semanticTransitionStrength(blend), [blend]);
  const spaceTransitionStrength = semanticStructureStrength;
  const isGeoEditing = viewMode === "editGeo";
  const selectedCard = useMemo(
    () => graph?.nodes.find((node) => node.id === selectedCardId && node.type === "card"),
    [graph, selectedCardId]
  );
  const manualPlacementCount = useMemo(() => Object.keys(manualPlacements).length, [manualPlacements]);

  useEffect(() => {
    if (!manualStorageKey || loadedManualKeyRef.current !== manualStorageKey) return;
    saveManualGeoPlacements(manualStorageKey, manualPlacements);
  }, [manualPlacements, manualStorageKey]);

  useEffect(() => {
    if (!manualStorageKey) {
      loadedManualKeyRef.current = null;
      setManualPlacements({});
      return;
    }

    loadedManualKeyRef.current = manualStorageKey;
    setManualPlacements(loadManualGeoPlacements(manualStorageKey));
  }, [manualStorageKey]);

  useEffect(() => {
    if (!rawExport || !currentCenter) return;
    setGraph(
      normalizeHypoWeave(rawExport, {
        center: currentCenter,
        placements: mergeGeoPlacements(basePlacements, manualPlacements)
      })
    );
  }, [basePlacements, currentCenter, manualPlacements, rawExport]);

  useEffect(() => {
    if (!selectedCardId || graph?.nodes.some((node) => node.id === selectedCardId && node.type === "card")) return;
    setSelectedCardId(null);
  }, [graph, selectedCardId]);

  const enterGeoEditMode = useCallback(() => {
    if (!graph || !isFullyGeographic) return;
    setViewMode("editGeo");
    setMessage("カードの地理座標を編集中です。");
  }, [graph, isFullyGeographic]);

  const exitGeoEditMode = useCallback(() => {
    setViewMode("view");
    setSelectedCardId(null);
    setMessage("カードの地理座標編集を終了しました。");
  }, []);

  useEffect(() => {
    if (viewMode === "editGeo" && !isFullyGeographic) {
      exitGeoEditMode();
    }
  }, [exitGeoEditMode, isFullyGeographic, viewMode]);

  const updateManualGeoPlacement = useCallback(
    (nodeId: string, lng: number, lat: number) => {
      const node = graph?.nodes.find((item) => item.id === nodeId);
      if (node?.type !== "card" || !isValidLngLat(lng, lat)) return;
      setManualPlacements((current) => ({
        ...current,
        [nodeId]: {
          nodeId,
          lng,
          lat,
          confidence: 1,
          source: "manual"
        }
      }));
    },
    [graph]
  );

  const resetManualGeoPlacement = useCallback((nodeId: string) => {
    setManualPlacements((current) => {
      const next = { ...current };
      delete next[nodeId];
      return next;
    });
  }, []);

  const handleFile = useCallback(async (file: File) => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as HypoWeaveExport;
      const snapshot = getHypoWeaveSnapshot(parsed);
      if (!snapshot.nodes.length) throw new Error("snapshot.nodes または workspaces.*.snapshot.nodes が見つかりません。");
      const initialDemoView = bundledDemoInitialView(parsed);
      setRawExport(parsed);
      setFileName(file.name);
      setGraph(
        initialDemoView
          ? normalizeHypoWeave(parsed, {
              center: initialDemoView.center,
              placements: initialDemoView.placements.length > 0 ? initialDemoView.placements : undefined
            })
          : null
      );
      setCurrentCenter(initialDemoView?.center ?? null);
      setBasePlacements(initialDemoView?.placements ?? []);
      setManualPlacements({});
      setViewMode("view");
      setSelectedCardId(null);
      setHoveredId(null);
      setBlend(initialDemoView ? 1 : 0.28);
      if (initialDemoView) {
        setAreaText(`${initialDemoView.center.lat.toFixed(6)},${initialDemoView.center.lng.toFixed(6)}`);
      }
      setStatus("ready");
      setMessage(`${snapshot.nodes.length} ノードを読み込みました。`);
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "JSONの読み込みに失敗しました。");
    }
  }, []);

  const loadDefaultExport = useCallback(async () => {
    try {
      setStatus("loading");
      const response = await fetch(DEFAULT_SAMPLE_PATH);
      if (!response.ok) throw new Error("デフォルトJSONが見つかりません。");
      const parsed = (await response.json()) as HypoWeaveExport;
      const initialDemoView = bundledDemoInitialView(parsed);
      setRawExport(parsed);
      setFileName(DEFAULT_SAMPLE_FILENAME);
      setGraph(
        initialDemoView
          ? normalizeHypoWeave(parsed, {
              center: initialDemoView.center,
              placements: initialDemoView.placements.length > 0 ? initialDemoView.placements : undefined
            })
          : null
      );
      setCurrentCenter(initialDemoView?.center ?? null);
      setBasePlacements(initialDemoView?.placements ?? []);
      setManualPlacements({});
      setViewMode("view");
      setSelectedCardId(null);
      setHoveredId(null);
      setBlend(initialDemoView ? 1 : 0.28);
      if (initialDemoView) {
        setAreaText(`${initialDemoView.center.lat.toFixed(6)},${initialDemoView.center.lng.toFixed(6)}`);
      }
      setStatus("ready");
      setMessage(`${getHypoWeaveSnapshot(parsed).nodes.length} ノードを読み込みました。`);
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "デフォルトJSONの読み込みに失敗しました。");
    }
  }, []);

  useEffect(() => {
    void loadDefaultExport();
  }, [loadDefaultExport]);

  const visualize = useCallback(async () => {
    const trimmedArea = areaText.trim();
    if (!rawExport) {
      setStatus("error");
      setMessage("先にJSONを読み込んでください。");
      return;
    }
    if (!trimmedArea) {
      setStatus("error");
      setMessage("中心エリアを入力してください。");
      return;
    }

    try {
      setStatus("loading");
      setMessage("中心エリアを解決しています。");
      const manual = parseManualCenter(trimmedArea);
      const resolved = manual ? undefined : await resolveArea(trimmedArea);
      const center = manual ?? resolved?.center;

      if (!center) {
        setStatus("error");
        setMessage("中心エリアを解決できませんでした。緯度,経度 形式でも入力できます。");
        return;
      }

      const demoPlacements = bundledDemoPlacementsForCenter(rawExport, center);
      const semanticGraph = normalizeHypoWeave(rawExport, {
        center,
        placements: demoPlacements.length > 0 ? demoPlacements : undefined
      });
      setCurrentCenter(center);
      setBasePlacements(demoPlacements);
      setViewMode("view");
      setSelectedCardId(null);
      setGraph(semanticGraph);
      setBlend(1);
      setMessage("地理配置を推定しています。");

      if (demoPlacements.length > 0) {
        setStatus("ready");
        setMessage("デモ同梱の地理座標を読み込みました。");
        return;
      }

      const response = await requestPlacements({
        areaText: trimmedArea,
        center,
        nodes: toPlacementInputs(semanticGraph)
      });
      setBasePlacements(response.placements);
      setBlend(1);
      setStatus("ready");
      setMessage(
        response.mode === "gemini"
          ? "Geminiによる地理配置を反映しました。"
          : "フォールバック配置で可視化しました。"
      );
    } catch (error) {
      const center = parseManualCenter(trimmedArea) ?? DEFAULT_CENTER;
      const fallbackGraph = normalizeHypoWeave(rawExport, { center });
      setCurrentCenter(center);
      setBasePlacements([]);
      setViewMode("view");
      setSelectedCardId(null);
      setGraph(fallbackGraph);
      setBlend(1);
      setStatus("error");
      setMessage(error instanceof Error ? `${error.message} フォールバック表示に切り替えました。` : "フォールバック表示に切り替えました。");
    }
  }, [areaText, rawExport]);

  return (
    <main className={`app-shell ${isGeoEditing ? "geo-editing" : ""}`} style={{ "--blend": blend } as React.CSSProperties}>
      <MapScene
        graph={graph}
        blend={blend}
        semanticStructureStrength={semanticStructureStrength}
        spaceTransitionStrength={spaceTransitionStrength}
        hoveredId={hoveredId}
        onHover={setHoveredId}
        isGeoEditing={isGeoEditing}
        selectedCardId={selectedCardId}
        onSelectCard={setSelectedCardId}
        onUpdateCardGeo={updateManualGeoPlacement}
      />

      <header className="topbar">
        <div className="icon-cluster">
          <button className="icon-button" aria-label="共有">
            <Share2 size={21} />
          </button>
          <button className="icon-button" aria-label="ヘルプ">
            <CircleHelp size={22} />
          </button>
          <button className="icon-button" aria-label="表示">
            <Eye size={23} />
          </button>
          <button
            className={`icon-button ${isGeoEditing ? "active" : ""}`}
            type="button"
            data-testid="geo-edit-toggle"
            aria-label={isGeoEditing ? "地理座標編集を終了" : "カードの地理座標を編集"}
            onClick={isGeoEditing ? exitGeoEditMode : enterGeoEditMode}
            disabled={!graph || (!isGeoEditing && !isFullyGeographic)}
          >
            <MapPin size={22} />
          </button>
        </div>
      </header>

      <div className={`left-panel-stack ${graph ? "compact" : ""}`}>
        <section className={`loader-panel ${graph ? "compact" : ""}`}>
          <DropZone onFile={handleFile} fileName={fileName} />
          <div className="area-row">
            <MapIcon size={18} />
            <input
              value={areaText}
              onChange={(event) => setAreaText(event.target.value)}
              placeholder="中心エリアまたは 27.7172,85.3240"
            />
          </div>
          <div className="action-row">
            <button className="primary-action" type="button" onClick={visualize} disabled={status === "loading"}>
              <Blend size={19} />
              可視化
            </button>
          </div>
          <p className={`status-line ${status}`}>{message}</p>
        </section>

        {isGeoEditing ? (
          <GeoEditPanel
            selectedCard={selectedCard}
            manualPlacementCount={manualPlacementCount}
            onUpdate={updateManualGeoPlacement}
            onReset={resetManualGeoPlacement}
            onClose={exitGeoEditMode}
          />
        ) : null}
      </div>

      {graph ? (
        <section className="inspector-strip">
          <span>{graph.nodes.length} nodes</span>
          <span>{graph.edges.length} threads</span>
          <span>{graph.center.label}</span>
        </section>
      ) : null}

      <section className="blend-control" aria-label="意味と地理の補間">
        <div className="blend-label">
          <Sparkles size={18} />
          <span>意味地図</span>
        </div>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={blend}
          onChange={(event) => setBlend(Number(event.target.value))}
          disabled={isGeoEditing}
        />
        <div className="blend-label">
          <MapIcon size={18} />
          <span>地理地図</span>
        </div>
      </section>
    </main>
  );
}

function DropZone({ onFile, fileName }: { onFile: (file: File) => void; fileName: string }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);

  return (
    <button
      className={`drop-zone ${dragging ? "dragging" : ""}`}
      type="button"
      onClick={() => inputRef.current?.click()}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        const file = event.dataTransfer.files.item(0);
        if (file) onFile(file);
      }}
    >
      <Upload size={20} />
      <span>{fileName || "HypoWeave JSON"}</span>
      <input
        ref={inputRef}
        type="file"
        accept="application/json,.json"
        onChange={(event) => {
          const file = event.target.files?.item(0);
          if (file) onFile(file);
        }}
      />
    </button>
  );
}

function GeoEditPanel({
  selectedCard,
  manualPlacementCount,
  onUpdate,
  onReset,
  onClose
}: {
  selectedCard: AyaNode | undefined;
  manualPlacementCount: number;
  onUpdate: (nodeId: string, lng: number, lat: number) => void;
  onReset: (nodeId: string) => void;
  onClose: () => void;
}) {
  const [lngText, setLngText] = useState("");
  const [latText, setLatText] = useState("");

  useEffect(() => {
    setLngText(selectedCard ? selectedCard.geo.lng.toFixed(6) : "");
    setLatText(selectedCard ? selectedCard.geo.lat.toFixed(6) : "");
  }, [selectedCard?.geo.lat, selectedCard?.geo.lng, selectedCard?.id]);

  const updateLng = (value: string) => {
    setLngText(value);
    if (!selectedCard) return;
    const lng = Number(value);
    const lat = Number(latText);
    if (isValidLngLat(lng, lat)) onUpdate(selectedCard.id, lng, lat);
  };
  const updateLat = (value: string) => {
    setLatText(value);
    if (!selectedCard) return;
    const lng = Number(lngText);
    const lat = Number(value);
    if (isValidLngLat(lng, lat)) onUpdate(selectedCard.id, lng, lat);
  };

  return (
    <section className="geo-edit-panel" aria-label="カード地理座標編集">
      <div className="geo-edit-panel-header">
        <div>
          <strong>Geo edit</strong>
          <span>{manualPlacementCount} saved</span>
        </div>
        <button className="geo-edit-close" type="button" onClick={onClose} aria-label="編集を終了">
          <X size={16} />
        </button>
      </div>
      {selectedCard ? (
        <div className="geo-edit-fields">
          <p>{selectedCard.shortLabel}</p>
          <label>
            <span>Lng</span>
            <input
              type="number"
              inputMode="decimal"
              step="0.000001"
              min="-180"
              max="180"
              value={lngText}
              onChange={(event) => updateLng(event.target.value)}
            />
          </label>
          <label>
            <span>Lat</span>
            <input
              type="number"
              inputMode="decimal"
              step="0.000001"
              min="-90"
              max="90"
              value={latText}
              onChange={(event) => updateLat(event.target.value)}
            />
          </label>
          <button className="geo-edit-reset" type="button" onClick={() => onReset(selectedCard.id)}>
            <RotateCcw size={16} />
            Reset
          </button>
        </div>
      ) : (
        <p className="geo-edit-empty">Select a card on the map.</p>
      )}
    </section>
  );
}

function MapScene({
  graph,
  blend,
  semanticStructureStrength,
  spaceTransitionStrength,
  hoveredId,
  onHover,
  isGeoEditing,
  selectedCardId,
  onSelectCard,
  onUpdateCardGeo
}: {
  graph: AyaGraph | null;
  blend: number;
  semanticStructureStrength: number;
  spaceTransitionStrength: number;
  hoveredId: string | null;
  onHover: (nodeId: string | null) => void;
  isGeoEditing: boolean;
  selectedCardId: string | null;
  onSelectCard: (nodeId: string | null) => void;
  onUpdateCardGeo: (nodeId: string, lng: number, lat: number) => void;
}) {
  const mapNodeRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const ideaLayerRef = useRef<IdeaObjectLayer | null>(null);
  const frameRef = useRef<number | null>(null);
  const hoverClearRef = useRef<number | null>(null);
  const draggingCardIdRef = useRef<string | null>(null);
  const activeViewDragKindsRef = useRef(new Set<string>());
  const lastViewDragEndedAtRef = useRef(0);
  const editViewRef = useRef<{ pitch: number; bearing: number } | null>(null);
  const overviewReturnViewRef = useRef<StoredMapView | null>(null);
  const overviewFocusModeRef = useRef<"group" | "selected">("group");
  const [overviewNodeId, setOverviewNodeId] = useState<string | null>(null);
  const [persistentNodeId, setPersistentNodeId] = useState<string | null>(null);
  const [lockedOverviewCardLayouts, setLockedOverviewCardLayouts] = useState<Map<string, IdeaLayerCardLayout>>(new Map());
  const [shouldLockOverviewLayout, setShouldLockOverviewLayout] = useState(false);
  const [tick, setTick] = useState(0);
  const isRelatedOverview = Boolean(overviewNodeId) && !isGeoEditing;
  const hasPinnedSelection = !isGeoEditing && !isRelatedOverview && persistentNodeId !== null;
  const mapPresence = 1 - spaceTransitionStrength * 0.94;
  const spaceMode = spaceModeForStrength(spaceTransitionStrength);
  const starFieldStyles = useMemo(() => createSpaceStarFieldStyles(), []);
  const sceneStyle = useMemo(
    () =>
      ({
        "--space-transition": `${spaceTransitionStrength}`,
        "--map-presence": `${mapPresence}`
      }) as React.CSSProperties,
    [mapPresence, spaceTransitionStrength]
  );
  const pointForNode = useCallback(
    (node: AyaNode) => visualPointForNode(node, blend),
    [blend]
  );
  const pointForNodeRef = useRef(pointForNode);

  useEffect(() => {
    pointForNodeRef.current = pointForNode;
  }, [pointForNode]);

  useEffect(
    () => () => {
      if (hoverClearRef.current !== null) {
        window.clearTimeout(hoverClearRef.current);
      }
    },
    []
  );

  useEffect(() => {
    if (!mapNodeRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapNodeRef.current,
      style: mapStyle(),
      center: [INITIAL_MAP_CENTER.lng, INITIAL_MAP_CENTER.lat],
      zoom: 12,
      pitch: 70,
      bearing: -22,
      hash: true,
      maxZoom: 18,
      maxPitch: 85,
      dragRotate: true,
      pitchWithRotate: true,
      touchZoomRotate: true,
      attributionControl: false
    });
    map.dragRotate.enable();
    map.touchZoomRotate.enableRotation();
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    map.addControl(
      new maplibregl.NavigationControl({
        visualizePitch: true,
        showZoom: true,
        showCompass: true
      }),
      "top-right"
    );
    map.addControl(
      new maplibregl.TerrainControl({
        source: "terrainSource",
        exaggeration: 1
      }),
      "top-right"
    );
    mapRef.current = map;

    const forwardOverlayWheelToMap = (event: WheelEvent) => {
      const target = event.target;
      const scene = sceneRef.current;
      if (
        isForwardedWheelEvent(event) ||
        !mapNodeRef.current ||
        !scene ||
        !(target instanceof Element) ||
        mapNodeRef.current.contains(target) ||
        !scene.contains(target)
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const forwardedEvent = new WheelEvent(event.type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        detail: event.detail,
        screenX: event.screenX,
        screenY: event.screenY,
        clientX: event.clientX,
        clientY: event.clientY,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
        button: event.button,
        buttons: event.buttons,
        relatedTarget: event.relatedTarget,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaZ: event.deltaZ,
        deltaMode: event.deltaMode
      });
      Object.defineProperty(forwardedEvent, "ayatoposForwardedToMap", { value: true });
      map.getCanvas().dispatchEvent(forwardedEvent);
    };
    sceneRef.current?.addEventListener("wheel", forwardOverlayWheelToMap, { capture: true, passive: false });

    const blockSceneContextMenu = (event: MouseEvent) => {
      event.preventDefault();
    };
    sceneRef.current?.addEventListener("contextmenu", blockSceneContextMenu);

    const rerender = () => {
      if (frameRef.current !== null) return;
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        setTick((value) => value + 1);
      });
    };
    let initialized3d = false;
    const initialize3d = () => {
      if (initialized3d) return;
      try {
        ensureTerrain(map);
        ideaLayerRef.current = addIdeaObjectLayer(map);
        initialized3d = true;
        rerender();
      } catch {
        // Style initialization can race with TileJSON loading; load/styledata will retry.
      }
    };

    map.on("move", rerender);
    map.on("zoom", rerender);
    map.on("pitch", rerender);
    map.on("rotate", rerender);
    map.on("terrain", rerender);
    map.on("sourcedata", rerender);
    map.on("idle", rerender);
    map.on("styledata", initialize3d);
    map.on("load", initialize3d);

    const handleViewDragStart = (kind: string) => {
      const activeKinds = activeViewDragKindsRef.current;
      const wasDragging = activeKinds.size > 0;
      activeKinds.add(kind);
      if (wasDragging) return;
      if (hoverClearRef.current !== null) {
        window.clearTimeout(hoverClearRef.current);
        hoverClearRef.current = null;
      }
      onHover(null);
    };

    const handleViewDragEnd = (kind: string) => {
      const activeKinds = activeViewDragKindsRef.current;
      activeKinds.delete(kind);
      if (activeKinds.size === 0) {
        lastViewDragEndedAtRef.current = window.performance.now();
      }
    };

    const startDragPan = () => handleViewDragStart("drag");
    const endDragPan = () => handleViewDragEnd("drag");
    const startRotate = () => handleViewDragStart("rotate");
    const endRotate = () => handleViewDragEnd("rotate");
    const startPitch = () => handleViewDragStart("pitch");
    const endPitch = () => handleViewDragEnd("pitch");

    map.on("dragstart", startDragPan);
    map.on("dragend", endDragPan);
    map.on("rotatestart", startRotate);
    map.on("rotateend", endRotate);
    map.on("pitchstart", startPitch);
    map.on("pitchend", endPitch);

    window.requestAnimationFrame(initialize3d);

    return () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
      }
      activeViewDragKindsRef.current.clear();
      sceneRef.current?.removeEventListener("contextmenu", blockSceneContextMenu);
      sceneRef.current?.removeEventListener("wheel", forwardOverlayWheelToMap, { capture: true });
      map.off("dragstart", startDragPan);
      map.off("dragend", endDragPan);
      map.off("rotatestart", startRotate);
      map.off("rotateend", endRotate);
      map.off("pitchstart", startPitch);
      map.off("pitchend", endPitch);
      map.remove();
      mapRef.current = null;
      ideaLayerRef.current = null;
    };
  }, [onHover]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const syncMapPresence = () => {
      setSemanticMapPresence(map, mapPresence);
    };

    syncMapPresence();
    map.on("styledata", syncMapPresence);
    return () => {
      map.off("styledata", syncMapPresence);
    };
  }, [mapPresence]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const syncSky = () => {
      setSemanticSkyTransition(map, spaceTransitionStrength);
    };

    syncSky();
    map.on("styledata", syncSky);
    return () => {
      map.off("styledata", syncSky);
    };
  }, [spaceTransitionStrength]);

  useEffect(() => {
    if (!graph || !mapRef.current || isGeoEditing) return;
    setOverviewNodeId(null);
    setPersistentNodeId(null);
    overviewReturnViewRef.current = null;
    overviewFocusModeRef.current = "group";
    setLockedOverviewCardLayouts(new Map());
    setShouldLockOverviewLayout(false);
    const points = graph.nodes
      .filter((node) => node.type === "card")
      .map((node) => pointForNodeRef.current(node));
    focusMapOnPoints2d(
      mapRef.current,
      points.length > 0 ? points : graph.nodes.map((node) => pointForNodeRef.current(node)),
      {
      padding: visualizationPaddingForContainer(mapRef.current.getContainer()),
      maxZoom: 17,
      duration: 900,
      pitch: 70,
      bearing: -22,
      majorityFraction: 0.6,
      singlePointZoom: 16.2
      }
    );
  }, [graph, isGeoEditing]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (isGeoEditing) {
      setOverviewNodeId(null);
      setPersistentNodeId(null);
      overviewReturnViewRef.current = null;
      overviewFocusModeRef.current = "group";
      setLockedOverviewCardLayouts(new Map());
      setShouldLockOverviewLayout(false);
      if (!editViewRef.current) {
        editViewRef.current = {
          pitch: map.getPitch(),
          bearing: map.getBearing()
        };
      }
      map.dragRotate.disable();
      map.touchZoomRotate.disableRotation();
      map.easeTo({
        pitch: 0,
        bearing: 0,
        duration: 450
      });
      return;
    }

    if (!editViewRef.current) return;
    const view = editViewRef.current;
    editViewRef.current = null;
    map.dragRotate.enable();
    map.touchZoomRotate.enableRotation();
    map.easeTo({
      pitch: view.pitch,
      bearing: view.bearing,
      duration: 450
    });
  }, [isGeoEditing]);

  const zoom = mapRef.current?.getZoom() ?? 0;
  const shouldShowGroupOutlines = false;
  const visualThreads = useMemo(() => (graph ? createVisualThreads(graph) : []), [graph]);
  const normalActiveNodeId = isGeoEditing
    ? hoveredId
    : hasPinnedSelection
      ? persistentNodeId
      : hoveredId ?? persistentNodeId ?? selectedCardId;
  const focusNodeId = isRelatedOverview ? overviewNodeId : normalActiveNodeId;
  const layerActiveNodeId = isRelatedOverview ? hoveredId ?? overviewNodeId : normalActiveNodeId;
  const layerHoverNodeId = isRelatedOverview ? hoveredId : layerActiveNodeId;
  const overviewRelations = useMemo(
    () => (graph && overviewNodeId ? overviewRelatedNodeIds(graph, overviewNodeId) : { ids: [], collateralIds: new Set<string>() }),
    [graph, overviewNodeId]
  );
  const overviewNodeIds = overviewRelations.ids;
  const overviewIdSet = useMemo(() => new Set(overviewNodeIds), [overviewNodeIds]);
  const overviewCollateralIdSet = overviewRelations.collateralIds;
  const relatedIds = useMemo(
    () => {
      if (!graph || !focusNodeId) return new Set<string>();
      return isRelatedOverview ? overviewIdSet : connectedVisualIds(visualThreads, focusNodeId);
    },
    [focusNodeId, graph, isRelatedOverview, overviewIdSet, visualThreads]
  );
  const activeVisualThreads = useMemo(
    () =>
      isRelatedOverview
        ? visualThreads.filter((edge) => overviewIdSet.has(edge.source) && overviewIdSet.has(edge.target))
        : normalActiveNodeId && !isGeoEditing
          ? visualThreads.filter((edge) => edge.source === normalActiveNodeId || edge.target === normalActiveNodeId)
          : [],
    [isGeoEditing, isRelatedOverview, normalActiveNodeId, overviewIdSet, visualThreads]
  );

  const screenNodes = useMemo(() => {
    if (!graph || !mapRef.current) return [];

    return graph.nodes.map((node) => {
      const point = pointForNode(node);
      const projected = projectNodeGlowToScreen(mapRef.current!, node, point);
      const isRelated = focusNodeId ? relatedIds.has(node.id) : true;
      return {
        node,
        point,
        screen: projected,
        related: isRelated,
        dimmed: focusNodeId ? !isRelated : false
      } satisfies ScreenNode;
    });
  }, [focusNodeId, graph, pointForNode, relatedIds, tick]);

  const visibleOutlineNodeIds = useMemo(
    () =>
      new Set(
        shouldShowGroupOutlines
          ? screenNodes
              .filter(({ node }) => node.type === "group" && isGroupOutlineVisibleAtZoom(node, zoom))
              .map(({ node }) => node.id)
          : []
      ),
    [screenNodes, shouldShowGroupOutlines, zoom]
  );

  const nodeHitTargets = useMemo(
    () =>
      [...screenNodes]
        .filter((item) => !isRelatedOverview || item.related)
        .sort((a, b) => renderRank(a.node, graph?.maxDepth ?? 0) - renderRank(b.node, graph?.maxDepth ?? 0)),
    [graph?.maxDepth, isRelatedOverview, screenNodes]
  );

  const screenOutlines = useMemo(() => {
    if (!graph || !mapRef.current || !shouldShowGroupOutlines) return [];
    return graph.outlines
      .filter((outline) => visibleOutlineNodeIds.has(outline.groupId))
      .map((outline) => ({
        outline,
        path: outlinePath(outline, mapRef.current!)
      }))
      .filter((item) => item.path.length > 0);
  }, [graph, shouldShowGroupOutlines, tick, visibleOutlineNodeIds]);

  const nodeById = useMemo(() => new Map(screenNodes.map((item) => [item.node.id, item])), [screenNodes]);
  const overviewCards = useMemo(() => {
    const container = mapRef.current?.getContainer();
    if (!container || !isRelatedOverview || !overviewNodeId) return [];

    const orderedIds = overviewNodeIds;
    const seen = new Set<string>();
    return orderedIds
      .filter((id) => {
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .map((id) => nodeById.get(id))
      .filter((item): item is ScreenNode => Boolean(item));
  }, [isRelatedOverview, nodeById, overviewNodeIds, overviewNodeId]);

  const computedTerrainOverviewCardLayouts = useMemo(() => {
    const container = mapRef.current?.getContainer();
    if (!container || !isRelatedOverview || !overviewNodeId) return new Map<string, IdeaLayerCardLayout>();

    const glowObstacles = screenNodes
      .filter((item) => item.related)
      .filter((item) => isGlowVisibleOnScreen(item, container.clientWidth, container.clientHeight))
      .map(glowAvoidanceRect);

    return new Map(
      placeOverviewLayerCards(
        overviewCards,
        container.clientWidth,
        container.clientHeight,
        glowObstacles,
        graph?.maxDepth ?? 0,
        overviewCollateralIdSet,
        overviewNodeId
      ).map(({ item, layout }) => [item.node.id, layout])
    );
  }, [graph?.maxDepth, isRelatedOverview, overviewCards, overviewCollateralIdSet, overviewNodeId, screenNodes]);
  useEffect(() => {
    if (
      !isRelatedOverview ||
      !shouldLockOverviewLayout ||
      lockedOverviewCardLayouts.size > 0 ||
      computedTerrainOverviewCardLayouts.size === 0
    ) {
      return;
    }
    setLockedOverviewCardLayouts(new Map(computedTerrainOverviewCardLayouts));
    setShouldLockOverviewLayout(false);
  }, [computedTerrainOverviewCardLayouts, isRelatedOverview, lockedOverviewCardLayouts.size, shouldLockOverviewLayout]);
  const terrainOverviewCardLayouts =
    isRelatedOverview && lockedOverviewCardLayouts.size > 0 ? lockedOverviewCardLayouts : computedTerrainOverviewCardLayouts;
  const overviewCardLayouts = useMemo(() => {
    const container = mapRef.current?.getContainer();
    if (!container || !isRelatedOverview || overviewCards.length === 0) return terrainOverviewCardLayouts;

    return new Map(
      blendOverviewLayerCards(
        overviewCards,
        terrainOverviewCardLayouts,
        container.clientWidth,
        container.clientHeight,
        graph?.maxDepth ?? 0,
        blend,
        overviewCollateralIdSet
      ).map(({ item, layout }) => [item.node.id, layout])
    );
  }, [blend, graph?.maxDepth, isRelatedOverview, overviewCards, overviewCollateralIdSet, terrainOverviewCardLayouts]);
  const ideaNodes = useMemo<IdeaLayerDatum[]>(
    () =>
      screenNodes.map(({ node, point, related, dimmed }) => ({
        node,
        point,
        related,
        dimmed,
        overviewCard: overviewCardLayouts.get(node.id)
      })),
    [overviewCardLayouts, screenNodes]
  );
  const customLayerThreads = useMemo<IdeaLayerThreadDatum[]>(
    () => {
      const terrainOverviewWeight = isRelatedOverview ? clamp(blend, 0, 1) : 0;
      if (isRelatedOverview && terrainOverviewWeight <= 0.001) {
        return overviewFamilyThreads(overviewCards, overviewCardLayouts, graph?.maxDepth ?? 0);
      }

      const graphThreads: IdeaLayerThreadDatum[] = [];
      for (const edge of activeVisualThreads) {
        const source = nodeById.get(edge.source);
        const target = nodeById.get(edge.target);
        if (!source || !target) continue;
        const sourceLayout = overviewCardLayouts.get(edge.source);
        const targetLayout = overviewCardLayouts.get(edge.target);
        const endpoints =
          isRelatedOverview && sourceLayout && targetLayout
            ? overviewThreadEndpoints(source.screen, target.screen, sourceLayout, targetLayout, terrainOverviewWeight)
            : { source: source.screen, target: target.screen };
        graphThreads.push({
          id: edge.id,
          kind: edge.kind,
          sourceId: edge.source,
          targetId: edge.target,
          source: endpoints.source,
          target: endpoints.target,
          width: threadWidthPixels(source.node, target.node, graph?.maxDepth ?? 0, isRelatedOverview)
        });
      }
      if (!isRelatedOverview || terrainOverviewWeight <= 0.001) return graphThreads;

      const cardLinks: IdeaLayerThreadDatum[] = [];
      for (const [nodeId, layout] of overviewCardLayouts.entries()) {
        const item = nodeById.get(nodeId);
        if (!item) continue;
        cardLinks.push({
          id: `card-link:${nodeId}`,
          kind: "card-link",
          sourceId: nodeId,
          targetId: nodeId,
          source: item.screen,
          target: nearestPointOnRect(item.screen, layout),
          width: 2.4 * terrainOverviewWeight
        });
      }

      return [...graphThreads, ...cardLinks];
    },
    [
      activeVisualThreads,
      blend,
      graph?.maxDepth,
      isRelatedOverview,
      nodeById,
      overviewCardLayouts,
      overviewCards
    ]
  );
  const hoveredCards = useMemo(() => {
    if (!normalActiveNodeId) return [];
    const container = mapRef.current?.getContainer();
    if (!container) return [];
    if (isRelatedOverview) return [];

    const orderedIds = [
      normalActiveNodeId,
      ...activeVisualThreads.map((edge) => (edge.source === normalActiveNodeId ? edge.target : edge.source))
    ];
    const seen = new Set<string>();
    return orderedIds
      .filter((id) => {
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .map((id) => nodeById.get(id))
      .filter((item): item is ScreenNode => Boolean(item))
      .filter((item) => isGlowVisibleOnScreen(item, container.clientWidth, container.clientHeight));
  }, [activeVisualThreads, isRelatedOverview, nodeById, normalActiveNodeId]);
  const relatedGlowObstacles = useMemo<TooltipRect[]>(() => {
    const container = mapRef.current?.getContainer();
    if (!normalActiveNodeId || !container || isRelatedOverview) return [];
    return screenNodes
      .filter((item) => item.related)
      .filter((item) => isGlowVisibleOnScreen(item, container.clientWidth, container.clientHeight))
      .map(glowAvoidanceRect);
  }, [isRelatedOverview, normalActiveNodeId, screenNodes]);
  const tooltipLayouts = useMemo<TooltipLayout[]>(() => {
    const container = mapRef.current?.getContainer();
    if (!container || isRelatedOverview) return [];
    return placeTooltipCards(hoveredCards, container.clientWidth, container.clientHeight, relatedGlowObstacles);
  }, [hoveredCards, isRelatedOverview, relatedGlowObstacles]);

  useEffect(() => {
    ideaLayerRef.current?.setData(ideaNodes, layerHoverNodeId, {
      enabled: isGeoEditing,
      selectedId: isRelatedOverview ? overviewNodeId : selectedCardId,
      overview: isRelatedOverview
    }, customLayerThreads, semanticStructureStrength, graph?.outlines ?? []);
  }, [
    customLayerThreads,
    graph?.outlines,
    ideaNodes,
    isGeoEditing,
    isRelatedOverview,
    layerHoverNodeId,
    overviewNodeId,
    selectedCardId,
    semanticStructureStrength
  ]);

  const updateCardGeoFromPointer = useCallback(
    (nodeId: string, event: React.PointerEvent<HTMLElement>) => {
      const map = mapRef.current;
      if (!map) return;
      const rect = map.getContainer().getBoundingClientRect();
      const lngLat = map.unproject([event.clientX - rect.left, event.clientY - rect.top] as PointLike);
      onUpdateCardGeo(nodeId, lngLat.lng, lngLat.lat);
    },
    [onUpdateCardGeo]
  );

  const panMapTowardPointer = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const map = mapRef.current;
    if (!map) return;
    const rect = map.getContainer().getBoundingClientRect();
    const offset = autoPanOffsetForPointer(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height);
    if (offset.x === 0 && offset.y === 0) return;
    const center = map.unproject([rect.width / 2 + offset.x, rect.height / 2 + offset.y] as PointLike);
    map.setCenter(center);
  }, []);

  const finishCardDrag = useCallback(() => {
    if (!draggingCardIdRef.current) return;
    draggingCardIdRef.current = null;
    mapRef.current?.dragPan.enable();
  }, []);

  const selectPersistentCard = useCallback(
    (nodeId: string | null) => {
      if (!nodeId || !graph) {
        onSelectCard(null);
        return;
      }
      const node = graph.nodes.find((item) => item.id === nodeId);
      onSelectCard(node?.type === "card" ? node.id : null);
    },
    [graph, onSelectCard]
  );

  const setPersistentSelection = useCallback(
    (nodeId: string | null) => {
      setPersistentNodeId(nodeId);
      selectPersistentCard(nodeId);
    },
    [selectPersistentCard]
  );

  const acceptHover = useCallback(
    (nodeId: string) => {
      if (activeViewDragKindsRef.current.size > 0) return;
      if (hasPinnedSelection && persistentNodeId !== nodeId) return;
      if (hoverClearRef.current !== null) {
        window.clearTimeout(hoverClearRef.current);
        hoverClearRef.current = null;
      }
      onHover(nodeId);
    },
    [hasPinnedSelection, onHover, persistentNodeId]
  );

  const releaseHover = useCallback(() => {
    if (hasPinnedSelection) return;
    if (hoverClearRef.current !== null) {
      window.clearTimeout(hoverClearRef.current);
    }
    hoverClearRef.current = window.setTimeout(() => {
      hoverClearRef.current = null;
      onHover(null);
    }, 90);
  }, [hasPinnedSelection, onHover]);

  const enterRelatedOverview = useCallback(
    (nodeId: string, focusMode: "group" | "selected" = "group") => {
      const map = mapRef.current;
      if (!graph || !map || isGeoEditing) return;
      if (!overviewReturnViewRef.current) {
        overviewReturnViewRef.current = snapshotMapView(map);
      }
      overviewFocusModeRef.current = focusMode;
      setLockedOverviewCardLayouts(new Map());
      setShouldLockOverviewLayout(false);
      setOverviewNodeId(nodeId);
      onHover(nodeId);
    },
    [graph, isGeoEditing, onHover]
  );

  const exitRelatedOverview = useCallback(() => {
    const map = mapRef.current;
    const returnView = overviewReturnViewRef.current;
    const overviewSelectionId = overviewNodeId;
    const selectedNode = graph?.nodes.find((node) => node.id === overviewSelectionId) ?? null;
    const selectedPoint = selectedNode ? pointForNode(selectedNode) : null;
    const currentZoom = map?.getZoom();
    setOverviewNodeId(null);
    onHover(selectedNode?.id ?? null);
    overviewReturnViewRef.current = null;
    overviewFocusModeRef.current = "group";
    setLockedOverviewCardLayouts(new Map());
    setShouldLockOverviewLayout(false);
    setPersistentSelection(selectedNode?.id ?? null);

    if (!map || !returnView) return;
    map.dragRotate.enable();
    map.touchZoomRotate.enableRotation();
    map.easeTo({
      center: selectedPoint ? [selectedPoint.lng, selectedPoint.lat] : returnView.center,
      zoom: currentZoom ?? returnView.zoom,
      pitch: returnView.pitch,
      bearing: returnView.bearing,
      duration: 560
    });
  }, [graph, onHover, overviewNodeId, pointForNode, setPersistentSelection]);

  const returnToNode3d = useCallback(
    (node: AyaNode) => {
      const map = mapRef.current;
      if (!map) return;
      const returnView = overviewReturnViewRef.current;
      const point = pointForNode(node);
      setOverviewNodeId(null);
      onHover(node.id);
      overviewReturnViewRef.current = null;
      overviewFocusModeRef.current = "group";
      setLockedOverviewCardLayouts(new Map());
      setShouldLockOverviewLayout(false);
      setPersistentSelection(node.id);
      map.dragRotate.enable();
      map.touchZoomRotate.enableRotation();
      map.easeTo({
        center: [point.lng, point.lat],
        zoom: Math.max(returnView?.zoom ?? 12, 15),
        pitch: Math.max(returnView?.pitch ?? 70, 62),
        bearing: returnView?.bearing ?? -22,
        duration: 700
      });
    },
    [onHover, pointForNode, setPersistentSelection]
  );

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !graph || !overviewNodeId || !isRelatedOverview) return;

    const focusSelectedOnly = overviewFocusModeRef.current === "selected";
    const points = graph.nodes
      .filter((node) => (focusSelectedOnly ? node.id === overviewNodeId : overviewIdSet.has(node.id)))
      .map((node) => pointForNode(node))
      .filter(isFiniteSpatialPoint);

    map.dragRotate.disable();
    map.touchZoomRotate.disableRotation();
    setShouldLockOverviewLayout(false);
    map.once("moveend", () => setShouldLockOverviewLayout(true));
    focusMapOnPoints2d(
      map,
      points,
      focusSelectedOnly
        ? {
            singlePointZoom: Math.min(18, Math.max(map.getZoom() + 0.9, 16.2)),
            duration: 620
          }
        : undefined
    );
  }, [graph, isRelatedOverview, overviewIdSet, overviewNodeId, pointForNode]);

  const handleSceneClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (window.performance.now() - lastViewDragEndedAtRef.current < 220) {
        return;
      }
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          ".geo-point-hit-target, .overview-card-hit-target, .idea-hit-target, .idea-tooltip, .maplibregl-control-container"
        )
      ) {
        return;
      }
      if (isRelatedOverview) {
        exitRelatedOverview();
        return;
      }
      if (!isGeoEditing) {
        setPersistentNodeId(null);
        onHover(null);
        onSelectCard(null);
      }
    },
    [exitRelatedOverview, isGeoEditing, isRelatedOverview, onHover, onSelectCard]
  );

  return (
      <div
        className={`scene ${isRelatedOverview ? "related-overview" : ""}`}
        ref={sceneRef}
        onClick={handleSceneClick}
        data-space-mode={spaceMode}
        style={sceneStyle}
      >
      <div className="space-backdrop" aria-hidden="true">
        <div className="space-stars far" style={starFieldStyles.far} />
        <div className="space-stars near" style={starFieldStyles.near} />
      </div>
      <div className="map-canvas" ref={mapNodeRef} />
      <div className="sky-wash" />
      <svg
        className="outline-layer"
        aria-hidden="true"
        style={{ "--outline-fade": Math.max(0, 1 - blend) } as React.CSSProperties}
      >
        {screenOutlines.map(({ outline, path }) => (
          <path
            key={outline.id}
            className={`group-outline depth-${Math.min(outline.depth, 6)} ${
              focusNodeId && !relatedIds.has(outline.groupId) ? "muted" : ""
            } ${focusNodeId === outline.groupId ? "active" : ""}`}
            d={path}
            style={
              {
                "--outline-color": outline.color,
                "--outline-depth": Math.min(outline.depth, 6)
              } as React.CSSProperties
            }
          />
        ))}
      </svg>
      <div className="geo-point-layer">
        {nodeHitTargets.map(({ node, screen, dimmed, related }) => (
          <button
            key={`${node.id}:geo-hit-target`}
            className={`geo-point-hit-target ${node.type} ${placementClassForNode(node)} depth-${Math.min(node.depth, 6)} ${
              dimmed ? "dimmed" : ""
            } ${related ? "related" : ""} ${hoveredId === node.id ? "hovered" : ""} ${
              isGeoEditing && node.type === "card" ? "geo-edit-target" : ""
            } ${selectedCardId === node.id ? "selected" : ""}`}
            style={
              {
                left: screen.x,
                top: screen.y,
                zIndex: renderRank(node, graph?.maxDepth ?? 0),
                "--node-color": node.color
              } as React.CSSProperties
            }
            onPointerEnter={() => acceptHover(node.id)}
            onPointerLeave={releaseHover}
            onPointerDown={(event) => {
              if (!isGeoEditing || node.type !== "card") return;
              event.preventDefault();
              event.stopPropagation();
              draggingCardIdRef.current = node.id;
              event.currentTarget.setPointerCapture(event.pointerId);
              mapRef.current?.dragPan.disable();
              onSelectCard(node.id);
              acceptHover(node.id);
            }}
            onPointerMove={(event) => {
              if (draggingCardIdRef.current !== node.id) return;
              event.preventDefault();
              panMapTowardPointer(event);
              updateCardGeoFromPointer(node.id, event);
            }}
            onPointerUp={(event) => {
              if (draggingCardIdRef.current !== node.id) return;
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
              finishCardDrag();
            }}
            onPointerCancel={finishCardDrag}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (isGeoEditing && node.type === "card") {
                onSelectCard(node.id);
                return;
              }
              if (isRelatedOverview) {
                returnToNode3d(node);
                return;
              }
              enterRelatedOverview(node.id);
            }}
            onFocus={() => acceptHover(node.id)}
            onBlur={releaseHover}
            type="button"
            aria-pressed={selectedCardId === node.id}
            aria-label={node.shortLabel}
          />
        ))}
      </div>
      {isRelatedOverview ? (
        <div className="overview-card-hit-layer">
          {[...overviewCardLayouts.entries()].map(([nodeId, layout]) => {
            const item = nodeById.get(nodeId);
            if (!item) return null;
            return (
              <button
                key={`${nodeId}:overview-card-hit`}
                className={`overview-card-hit-target ${overviewNodeId === nodeId ? "selected" : ""}`}
                style={
                  overviewCardHitTargetStyle(layout, hoveredId === nodeId)
                }
                onPointerEnter={() => acceptHover(nodeId)}
                onPointerLeave={releaseHover}
                onFocus={() => acceptHover(nodeId)}
                onBlur={releaseHover}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  enterRelatedOverview(item.node.id, "selected");
                }}
                type="button"
                aria-label={item.node.shortLabel}
              />
            );
          })}
        </div>
      ) : null}
      {tooltipLayouts.map(({ item: { node }, left, top }) => (
        <aside
          key={`${node.id}:tooltip-card`}
          className={`idea-tooltip ${node.id === layerActiveNodeId ? "origin" : "connected"} ${
            nodeHasTooltipCatchphrase(node) ? "has-kicker" : "title-only"
          }`}
          onPointerEnter={() => {
            if (layerActiveNodeId) acceptHover(layerActiveNodeId);
          }}
          onPointerLeave={releaseHover}
          style={
            {
              left,
              top,
              "--node-color": node.color
            } as React.CSSProperties
          }
        >
          {nodeHasTooltipCatchphrase(node) ? <span className="idea-tooltip-kicker">{node.shortLabel}</span> : null}
          <strong>{tooltipPrimaryTitle(node)}</strong>
        </aside>
      ))}
    </div>
  );
}

interface TooltipRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function placeTooltipCards(
  cards: ScreenNode[],
  viewportWidth: number,
  viewportHeight: number,
  glowObstacles: TooltipRect[]
): TooltipLayout[] {
  const placed: TooltipRect[] = [];
  return cards.map((item, index) => {
    const width = tooltipWidthForViewport(viewportWidth);
    const height = estimateTooltipHeight(item.node);
    const candidates = tooltipPositionCandidates(item.screen, width, height, viewportWidth, viewportHeight, index);
    const best = candidates.reduce((current, candidate, candidateIndex) => {
      const tooltipOverlap = placed.reduce((total, rect) => total + rectOverlapArea(candidate, rect), 0);
      const glowOverlap = glowObstacles.reduce((total, rect) => total + rectOverlapArea(candidate, rect), 0);
      const distance = Math.hypot(candidate.left + width / 2 - item.screen.x, candidate.top + height / 2 - item.screen.y);
      const score = tooltipOverlap * 1000 + glowOverlap * 1600 + distance + candidateIndex * 0.01;
      return score < current.score ? { rect: candidate, score } : current;
    }, { rect: candidates[0]!, score: Number.POSITIVE_INFINITY });

    placed.push(best.rect);
    return {
      item,
      left: best.rect.left,
      top: best.rect.top
    };
  });
}

function placeOverviewLayerCards(
  cards: ScreenNode[],
  viewportWidth: number,
  viewportHeight: number,
  glowObstacles: TooltipRect[],
  maxDepth: number,
  collateralIds = new Set<string>(),
  selectedId: string | null = null
): Array<{ item: ScreenNode; layout: IdeaLayerCardLayout }> {
  if (cards.length === 0) return [];
  const bounds = overviewLayerPlacementBounds(viewportWidth, viewportHeight);
  const selectedNode = selectedId ? cards.find((item) => item.node.id === selectedId)?.node : undefined;
  const packing = overviewLayerPacking(cards, bounds, maxDepth, collateralIds, selectedNode);
  const fitAttempts = [1, 0.92, 0.84, 0.76];
  let bestLayouts: Array<{ item: ScreenNode; layout: IdeaLayerCardLayout }> = [];
  let bestScore = Number.POSITIVE_INFINITY;

  for (const fitAttempt of fitAttempts) {
    const layouts = placeOverviewLayerCardsNearGlows(
      cards,
      bounds,
      glowObstacles,
      selectedNode,
      packing.scale * fitAttempt
    );
    const score = overviewLayoutCollisionScore(layouts.map(({ layout }) => layout), glowObstacles);
    if (score < bestScore) {
      bestLayouts = layouts;
      bestScore = score;
    }
    if (score <= 1) return layouts;
  }

  return relaxOverviewLayerCards(bestLayouts, bounds, glowObstacles, selectedNode);
}

function placeOverviewLayerCardsNearGlows(
  cards: ScreenNode[],
  bounds: TooltipRect,
  glowObstacles: TooltipRect[],
  selectedNode: AyaNode | undefined,
  fitScale: number
): Array<{ item: ScreenNode; layout: IdeaLayerCardLayout }> {
  const placed: TooltipRect[] = [];
  return cards.map((item, index) => {
    const size = overviewTerrainLayerCardSize(item.node, selectedNode, fitScale);
    const relationKind = overviewRelationKind(item.node, selectedNode);
    const candidates = overviewCardPositionCandidates(item.screen, size.width, size.height, bounds, index);
    const best = candidates.reduce((current, candidate, candidateIndex) => {
      const cardOverlap = placed.reduce((total, rect) => total + rectOverlapArea(candidate, rect), 0);
      const glowOverlap = glowObstacles.reduce((total, rect) => total + rectOverlapArea(candidate, rect), 0);
      const leaderLength = leaderLineLength(item.screen, candidate);
      const originBias = candidateIndex * (relationKind === "selected" ? 0.16 : 0.035);
      const collisionPenalty = cardOverlap + glowOverlap > 0 ? 1_000_000 + (cardOverlap + glowOverlap) * 120 : 0;
      const score = collisionPenalty + leaderLength + originBias;
      return score < current.score ? { rect: candidate, score } : current;
    }, { rect: candidates[0]!, score: Number.POSITIVE_INFINITY });

    placed.push(best.rect);
    return {
      item,
      layout: best.rect
    };
  });
}

function blendOverviewLayerCards(
  cards: ScreenNode[],
  terrainLayouts: Map<string, IdeaLayerCardLayout>,
  viewportWidth: number,
  viewportHeight: number,
  maxDepth: number,
  terrainWeight: number,
  collateralIds = new Set<string>()
): Array<{ item: ScreenNode; layout: IdeaLayerCardLayout }> {
  if (cards.length === 0) return [];
  const weight = clamp(terrainWeight, 0, 1);
  if (weight >= 0.999) {
    return cards
      .map((item) => {
        const layout = terrainLayouts.get(item.node.id);
        return layout ? { item, layout } : undefined;
      })
      .filter((entry): entry is { item: ScreenNode; layout: IdeaLayerCardLayout } => Boolean(entry));
  }

  const treeLayouts = new Map(
    placeOverviewLayerCardsAsTree(cards, viewportWidth, viewportHeight, maxDepth, collateralIds).map(({ item, layout }) => [
      item.node.id,
      layout
    ])
  );

  return cards
    .map((item) => {
      const treeLayout = treeLayouts.get(item.node.id);
      const terrainLayout = terrainLayouts.get(item.node.id) ?? treeLayout;
      if (!terrainLayout || !treeLayout) return undefined;
      return {
        item,
        layout: interpolateRect(treeLayout, terrainLayout, weight)
      };
    })
    .filter((entry): entry is { item: ScreenNode; layout: IdeaLayerCardLayout } => Boolean(entry));
}

function placeOverviewLayerCardsAsTree(
  cards: ScreenNode[],
  viewportWidth: number,
  viewportHeight: number,
  maxDepth: number,
  collateralIds = new Set<string>()
): Array<{ item: ScreenNode; layout: IdeaLayerCardLayout }> {
  if (cards.length === 0) return [];
  const bounds = overviewLayerPlacementBounds(viewportWidth, viewportHeight);
  const cardById = new Map(cards.map((item) => [item.node.id, item]));
  const childrenByParent = new Map<string, ScreenNode[]>();
  for (const item of cards) {
    const parentId = item.node.parentId;
    if (!parentId || !cardById.has(parentId)) continue;
    const children = childrenByParent.get(parentId) ?? [];
    children.push(item);
    childrenByParent.set(parentId, children);
  }
  childrenByParent.forEach((children) => children.sort(compareOverviewTreeNodes));

  const roots = cards
    .filter((item) => !item.node.parentId || !cardById.has(item.node.parentId))
    .sort(compareOverviewTreeNodes);
  const subtreeWidthCache = new Map<string, number>();
  const subtreeWidth = (item: ScreenNode): number => {
    const cached = subtreeWidthCache.get(item.node.id);
    if (cached !== undefined) return cached;
    const children = childrenByParent.get(item.node.id) ?? [];
    const width = children.length === 0 ? 1 : children.reduce((total, child) => total + subtreeWidth(child), 0);
    subtreeWidthCache.set(item.node.id, width);
    return width;
  };

  const positions = new Map<string, { unitX: number; level: number }>();
  const assignTreePositions = (item: ScreenNode, offset: number, level: number): number => {
    const width = subtreeWidth(item);
    const children = childrenByParent.get(item.node.id) ?? [];
    if (children.length === 0) {
      positions.set(item.node.id, { unitX: offset + width / 2, level });
      return width;
    }

    let childOffset = offset;
    for (const child of children) {
      childOffset += assignTreePositions(child, childOffset, level + 1);
    }
    const firstChild = positions.get(children[0]!.node.id);
    const lastChild = positions.get(children[children.length - 1]!.node.id);
    positions.set(item.node.id, {
      unitX: firstChild && lastChild ? (firstChild.unitX + lastChild.unitX) / 2 : offset + width / 2,
      level
    });
    return width;
  };

  const rootGapUnits = 1;
  let offset = 0;
  for (const root of roots) {
    offset += assignTreePositions(root, offset, 0) + rootGapUnits;
  }
  const totalUnits = Math.max(1, offset - rootGapUnits);
  const maxLevel = [...positions.values()].reduce((max, position) => Math.max(max, position.level), 0);
  const maxBaseSize = cards.reduce(
    (size, item) => {
      const next = overviewLayerCardSize(item.node, maxDepth, 1, overviewRelationCardScale(item.node.id, collateralIds));
      return {
        width: Math.max(size.width, next.width),
        height: Math.max(size.height, next.height)
      };
    },
    { width: 1, height: 1 }
  );
  const columnGap = 18;
  const rowGap = 24;
  const horizontalScale = bounds.width / (totalUnits * maxBaseSize.width + Math.max(0, totalUnits - 1) * columnGap);
  const verticalScale =
    bounds.height / ((maxLevel + 1) * maxBaseSize.height + Math.max(0, maxLevel) * rowGap);
  const scale = Math.max(0.04, Math.min(0.86, horizontalScale, verticalScale));
  const maxSize = {
    width: maxBaseSize.width * scale,
    height: maxBaseSize.height * scale
  };
  const totalTreeWidth = totalUnits * maxSize.width + Math.max(0, totalUnits - 1) * columnGap;
  const totalTreeHeight = (maxLevel + 1) * maxSize.height + Math.max(0, maxLevel) * rowGap;
  const originX = bounds.left + (bounds.width - totalTreeWidth) / 2;
  const originY = bounds.top + (bounds.height - totalTreeHeight) / 2;

  return cards.map((item) => {
    const position = positions.get(item.node.id) ?? { unitX: 0.5, level: 0 };
    const size = overviewLayerCardSize(item.node, maxDepth, scale, overviewRelationCardScale(item.node.id, collateralIds));
    const centerX = originX + position.unitX * (maxSize.width + columnGap) - columnGap / 2;
    const top = originY + position.level * (maxSize.height + rowGap);
    return {
      item,
      layout: clampRectToBounds(
        {
          left: centerX - size.width / 2,
          top,
          width: size.width,
          height: size.height
        },
        bounds
      )
    };
  });
}

function compareOverviewTreeNodes(a: ScreenNode, b: ScreenNode): number {
  return a.node.semantic.x - b.node.semantic.x || a.node.semantic.y - b.node.semantic.y || a.node.id.localeCompare(b.node.id);
}

function interpolateRect(from: TooltipRect, to: TooltipRect, weight: number): IdeaLayerCardLayout {
  return {
    left: from.left + (to.left - from.left) * weight,
    top: from.top + (to.top - from.top) * weight,
    width: from.width + (to.width - from.width) * weight,
    height: from.height + (to.height - from.height) * weight
  };
}

function overviewCardHitTargetStyle(layout: IdeaLayerCardLayout, active: boolean): React.CSSProperties {
  const frame = overviewCardDisplayFrame(layout, active);
  const padX = frame.width * (OVERVIEW_CARD_TEXTURE_FRAME.x / OVERVIEW_CARD_TEXTURE_CANVAS.width);
  const padY = frame.height * (OVERVIEW_CARD_TEXTURE_FRAME.y / OVERVIEW_CARD_TEXTURE_CANVAS.height);
  const cornerRadius = Math.max(
    6,
    Math.min(frame.width, frame.height) * (OVERVIEW_CARD_TEXTURE_FRAME.radius / OVERVIEW_CARD_TEXTURE_CANVAS.width)
  );
  const minSide = Math.min(frame.width, frame.height);
  const innerSpread = clamp(minSide * 0.052, 3, 10);
  const outerSpread = clamp(minSide * 0.11, 8, 20);
  const glowSoft = clamp(minSide * 0.18, 18, 42);
  const glowWide = clamp(minSide * 0.34, 34, 82);

  return {
    left: frame.left,
    top: frame.top,
    width: frame.width,
    height: frame.height,
    "--overview-card-halo-inset-x": `${padX}px`,
    "--overview-card-halo-inset-y": `${padY}px`,
    "--overview-card-halo-radius": `${cornerRadius}px`,
    "--overview-card-halo-inner-spread": `${innerSpread}px`,
    "--overview-card-halo-outer-spread": `${outerSpread}px`,
    "--overview-card-halo-glow-soft": `${glowSoft}px`,
    "--overview-card-halo-glow-wide": `${glowWide}px`
  } as React.CSSProperties;
}

function overviewCardDisplayFrame(layout: IdeaLayerCardLayout, active: boolean): IdeaLayerCardLayout {
  if (!active) return layout;
  const width = OVERVIEW_FOCUS_CARD_WIDTH;
  const height = OVERVIEW_FOCUS_CARD_HEIGHT;
  return {
    left: layout.left - (width - layout.width) / 2,
    top: layout.top - (height - layout.height) / 2,
    width,
    height
  };
}

function clampRectToBounds(rect: TooltipRect, bounds: TooltipRect): IdeaLayerCardLayout {
  return {
    ...rect,
    left: clamp(rect.left, bounds.left, bounds.left + Math.max(0, bounds.width - rect.width)),
    top: clamp(rect.top, bounds.top, bounds.top + Math.max(0, bounds.height - rect.height))
  };
}

function overviewLayerCardSize(node: AyaNode, maxDepth: number, scale = 1, relationScale = 1): { width: number; height: number } {
  void node;
  void maxDepth;
  void relationScale;
  const width = Math.round(OVERVIEW_FOCUS_CARD_WIDTH * scale);
  return {
    width,
    height: Math.round(width * 0.66)
  };
}

const OVERVIEW_FOCUS_CARD_WIDTH = 274;
const OVERVIEW_FOCUS_CARD_HEIGHT = 181;
const OVERVIEW_CARD_TEXTURE_CANVAS = { width: 512, height: 340 };
const OVERVIEW_CARD_TEXTURE_FRAME = { x: 18, y: 20, width: 476, height: 300, radius: 16 };
const OVERVIEW_TERRAIN_CARD_SCALE_BY_RELATION: Record<OverviewRelationKind, number> = {
  selected: 0.57,
  parent: 0.64,
  sibling: 0.55,
  other: 0.46
};
const OVERVIEW_TERRAIN_CARD_MIN_WIDTH_BY_RELATION: Record<OverviewRelationKind, number> = {
  selected: 41,
  parent: 49,
  sibling: 45,
  other: 42
};

function overviewTerrainLayerCardSize(
  node: AyaNode,
  selectedNode: AyaNode | undefined,
  fitScale = 1
): { width: number; height: number } {
  const relationKind = overviewRelationKind(node, selectedNode);
  const width = Math.max(
    OVERVIEW_TERRAIN_CARD_MIN_WIDTH_BY_RELATION[relationKind],
    Math.round(OVERVIEW_FOCUS_CARD_WIDTH * OVERVIEW_TERRAIN_CARD_SCALE_BY_RELATION[relationKind] * fitScale)
  );
  return {
    width,
    height: Math.round(width * 0.66)
  };
}

function overviewRelationKind(node: AyaNode, selectedNode: AyaNode | undefined): OverviewRelationKind {
  if (!selectedNode) return "other";
  if (node.id === selectedNode.id) return "selected";
  if (selectedNode.parentId && node.id === selectedNode.parentId) return "parent";
  if (node.parentId && selectedNode.parentId && node.parentId === selectedNode.parentId) return "sibling";
  return "other";
}

function overviewRelationCardScale(nodeId: string, collateralIds: Set<string>): number {
  return collateralIds.has(nodeId) ? 0.72 : 1;
}

function overviewLayerPlacementBounds(viewportWidth: number, viewportHeight: number): TooltipRect {
  const narrow = viewportWidth <= 760;
  const left = narrow ? 20 : 414;
  const top = narrow ? 208 : 92;
  const right = narrow ? 20 : 34;
  const bottom = narrow ? 146 : 124;
  return {
    left,
    top,
    width: Math.max(120, viewportWidth - left - right),
    height: Math.max(120, viewportHeight - top - bottom)
  };
}

function overviewLayerPacking(
  cards: ScreenNode[],
  bounds: TooltipRect,
  maxDepth: number,
  collateralIds = new Set<string>(),
  selectedNode: AyaNode | undefined
): { scale: number } {
  void maxDepth;
  void collateralIds;
  const maxSize = cards.reduce(
    (size, item) => {
      const next = overviewTerrainLayerCardSize(item.node, selectedNode);
      return {
        width: Math.max(size.width, next.width),
        height: Math.max(size.height, next.height)
      };
    },
    { width: 1, height: 1 }
  );
  const gap = 14;
  let best = { columns: 1, rows: cards.length, scale: 0 };

  for (let columns = 1; columns <= cards.length; columns += 1) {
    const rows = Math.ceil(cards.length / columns);
    const cellWidth = bounds.width / columns;
    const cellHeight = bounds.height / rows;
    const scale = Math.min(1, (cellWidth - gap) / maxSize.width, (cellHeight - gap) / maxSize.height);
    if (scale > best.scale) best = { columns, rows, scale };
  }

  return { scale: Math.max(0.04, Math.min(1, best.scale)) };
}

function overviewCardPositionCandidates(
  screen: { x: number; y: number },
  width: number,
  height: number,
  bounds: TooltipRect,
  index: number
): TooltipRect[] {
  const gap = 14;
  const maxLeft = bounds.left + Math.max(0, bounds.width - width);
  const maxTop = bounds.top + Math.max(0, bounds.height - height);
  const clampRect = (left: number, top: number): TooltipRect => ({
    left: clamp(left, bounds.left, maxLeft),
    top: clamp(top, bounds.top, maxTop),
    width,
    height
  });
  const angleOffset = (index % 7) * 0.13;
  const angles = [
    0,
    Math.PI,
    -Math.PI / 2,
    Math.PI / 2,
    -Math.PI / 4,
    Math.PI / 4,
    (-3 * Math.PI) / 4,
    (3 * Math.PI) / 4
  ];
  const candidates: TooltipRect[] = [];

  for (const angle of angles) {
    const xRadius = width / 2 + gap;
    const yRadius = height / 2 + gap;
    candidates.push(
      clampRect(
        screen.x + Math.cos(angle) * xRadius - width / 2,
        screen.y + Math.sin(angle) * yRadius - height / 2
      )
    );
  }

  for (const ring of [18, 34, 56, 84, 118, 158, 204, 258, 320]) {
    for (const angle of angles) {
      const resolvedAngle = angle + angleOffset;
      const xRadius = width / 2 + gap + ring;
      const yRadius = height / 2 + gap + ring * 0.72;
      candidates.push(
        clampRect(
          screen.x + Math.cos(resolvedAngle) * xRadius - width / 2,
          screen.y + Math.sin(resolvedAngle) * yRadius - height / 2
        )
      );
    }
  }

  return uniqueRects(candidates);
}

function relaxOverviewLayerCards(
  layouts: Array<{ item: ScreenNode; layout: IdeaLayerCardLayout }>,
  bounds: TooltipRect,
  glowObstacles: TooltipRect[],
  selectedNode: AyaNode | undefined
): Array<{ item: ScreenNode; layout: IdeaLayerCardLayout }> {
  const states = layouts.map(({ item, layout }) => ({
    item,
    home: { ...layout },
    rect: { ...layout },
    flex: overviewRelationFlex(overviewRelationKind(item.node, selectedNode))
  }));
  let bestRects = states.map((state) => ({ ...state.rect }));
  let bestScore = overviewLayoutCollisionScore(bestRects, glowObstacles);

  for (let iteration = 0; iteration < 120; iteration += 1) {
    for (let index = 0; index < states.length; index += 1) {
      const current = states[index]!;
      for (let nextIndex = index + 1; nextIndex < states.length; nextIndex += 1) {
        const next = states[nextIndex]!;
        const push = rectSeparationPush(current.rect, next.rect, 8);
        if (!push) continue;
        const totalFlex = current.flex + next.flex || 1;
        moveRect(current.rect, -push.x * (current.flex / totalFlex), -push.y * (current.flex / totalFlex));
        moveRect(next.rect, push.x * (next.flex / totalFlex), push.y * (next.flex / totalFlex));
      }
    }

    for (const state of states) {
      for (const obstacle of glowObstacles) {
        const push = rectSeparationPush(state.rect, obstacle, 6);
        if (push) moveRect(state.rect, -push.x, -push.y);
      }
      const pull = 0.018 + (1 - state.flex) * 0.02;
      moveRect(state.rect, (state.home.left - state.rect.left) * pull, (state.home.top - state.rect.top) * pull);
      state.rect = clampRectToBounds(state.rect, bounds);
    }

    const currentRects = states.map((state) => state.rect);
    const score = overviewLayoutCollisionScore(currentRects, glowObstacles);
    if (score < bestScore) {
      bestScore = score;
      bestRects = currentRects.map((rect) => ({ ...rect }));
      if (score <= 1) break;
    }
  }

  return layouts.map(({ item }, index) => ({
    item,
    layout: bestRects[index] ?? layouts[index]!.layout
  }));
}

function overviewRelationFlex(kind: OverviewRelationKind): number {
  if (kind === "selected") return 0.24;
  if (kind === "parent") return 0.36;
  if (kind === "sibling") return 0.48;
  return 0.62;
}

function overviewLayoutCollisionScore(layouts: TooltipRect[], glowObstacles: TooltipRect[]): number {
  let score = 0;
  for (let index = 0; index < layouts.length; index += 1) {
    for (let next = index + 1; next < layouts.length; next += 1) {
      score += rectOverlapArea(layouts[index]!, layouts[next]!) * 2;
    }
    for (const obstacle of glowObstacles) {
      score += rectOverlapArea(layouts[index]!, obstacle) * 2.8;
    }
  }
  return score;
}

function rectSeparationPush(a: TooltipRect, b: TooltipRect, gap: number): { x: number; y: number } | null {
  const paddedA = paddedRect(a, gap / 2);
  const paddedB = paddedRect(b, gap / 2);
  const overlapWidth = Math.min(paddedA.left + paddedA.width, paddedB.left + paddedB.width) - Math.max(paddedA.left, paddedB.left);
  const overlapHeight = Math.min(paddedA.top + paddedA.height, paddedB.top + paddedB.height) - Math.max(paddedA.top, paddedB.top);
  if (overlapWidth <= 0 || overlapHeight <= 0) return null;

  const aCenter = rectCenter(a);
  const bCenter = rectCenter(b);
  const directionX = aCenter.x <= bCenter.x ? 1 : -1;
  const directionY = aCenter.y <= bCenter.y ? 1 : -1;
  if (overlapWidth < overlapHeight) return { x: (overlapWidth + 0.8) * directionX, y: 0 };
  return { x: 0, y: (overlapHeight + 0.8) * directionY };
}

function paddedRect(rect: TooltipRect, padding: number): TooltipRect {
  return {
    left: rect.left - padding,
    top: rect.top - padding,
    width: rect.width + padding * 2,
    height: rect.height + padding * 2
  };
}

function moveRect(rect: TooltipRect, x: number, y: number): void {
  rect.left += x;
  rect.top += y;
}

function glowAvoidanceRect(item: ScreenNode): TooltipRect {
  const size = glowAvoidanceSizePixels(item.node);
  return {
    left: item.screen.x - size / 2,
    top: item.screen.y - size / 2,
    width: size,
    height: size
  };
}

function glowAvoidanceSizePixels(node: AyaNode): number {
  if (node.type === "group" && node.depth === 0) return 96;
  if (node.type === "group") return 84;
  if (node.geoPlacementSource === "fallback" || node.geoPlacementSource === "manual") return 76;
  return 64;
}

function tooltipPositionCandidates(
  screen: { x: number; y: number },
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
  index: number
): TooltipRect[] {
  const gap = 22;
  const gutter = 20;
  const topGutter = 90;
  const bottomGutter = 110;
  const maxLeft = Math.max(gutter, viewportWidth - width - gutter);
  const maxTop = Math.max(topGutter, viewportHeight - height - bottomGutter);
  const clampRect = (left: number, top: number): TooltipRect => ({
    left: clamp(left, gutter, maxLeft),
    top: clamp(top, topGutter, maxTop),
    width,
    height
  });
  const candidates: TooltipRect[] = [
    clampRect(screen.x + gap, screen.y + 18),
    clampRect(screen.x + gap, screen.y - height - gap),
    clampRect(screen.x - width - gap, screen.y + 18),
    clampRect(screen.x - width - gap, screen.y - height - gap),
    clampRect(screen.x - width / 2, screen.y - height - gap),
    clampRect(screen.x - width / 2, screen.y + gap)
  ];
  const rowStep = height + 12;
  const anchorRow = Math.round((screen.y - topGutter) / rowStep);
  const horizontalOptions = [screen.x + gap, screen.x - width - gap, screen.x - width / 2];

  for (let radius = 0; radius <= 4 + index; radius += 1) {
    const rows = radius === 0 ? [anchorRow] : [anchorRow + radius, anchorRow - radius];
    for (const row of rows) {
      const top = topGutter + row * rowStep;
      for (const left of horizontalOptions) {
        candidates.push(clampRect(left, top));
      }
    }
  }

  return uniqueRects(candidates);
}

function tooltipWidthForViewport(viewportWidth: number): number {
  return Math.min(380, Math.max(220, viewportWidth - 44));
}

function estimateTooltipHeight(node: AyaNode): number {
  const titleText = tooltipPrimaryTitle(node);
  const titleLines = Math.min(nodeHasTooltipCatchphrase(node) ? 5 : 6, Math.max(1, Math.ceil(titleText.length / 20)));
  if (!nodeHasTooltipCatchphrase(node)) {
    return 42 + titleLines * 26;
  }
  const kickerLines = Math.min(2, Math.max(1, Math.ceil(node.shortLabel.length / 22)));
  return 58 + kickerLines * 20 + titleLines * 26;
}

function uniqueRects(rects: TooltipRect[]): TooltipRect[] {
  const seen = new Set<string>();
  return rects.filter((rect) => {
    const key = `${Math.round(rect.left)}:${Math.round(rect.top)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rectOverlapArea(a: TooltipRect, b: TooltipRect): number {
  const width = Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left));
  const height = Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top));
  return width * height;
}

function nodeHasTooltipCatchphrase(node: AyaNode): boolean {
  const shortLabel = normalizeTooltipText(node.shortLabel);
  const label = normalizeTooltipText(node.label);
  return shortLabel.length > 0 && label.length > 0 && shortLabel !== label;
}

function tooltipPrimaryTitle(node: AyaNode): string {
  const shortLabel = normalizeTooltipText(node.shortLabel);
  const label = normalizeTooltipText(node.label);
  return nodeHasTooltipCatchphrase(node) ? label : shortLabel || label;
}

function normalizeTooltipText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function overviewCardThreadEndpoints(
  sourceRect: TooltipRect,
  targetRect: TooltipRect
): { source: { x: number; y: number }; target: { x: number; y: number } } {
  const sourceCenter = rectCenter(sourceRect);
  const targetCenter = rectCenter(targetRect);
  return {
    source: nearestPointOnRect(targetCenter, sourceRect),
    target: nearestPointOnRect(sourceCenter, targetRect)
  };
}

function overviewFamilyThreads(
  cards: ScreenNode[],
  layouts: Map<string, IdeaLayerCardLayout>,
  maxDepth: number
): IdeaLayerThreadDatum[] {
  const cardIds = new Set(cards.map((item) => item.node.id));
  const cardById = new Map(cards.map((item) => [item.node.id, item]));
  const threads: IdeaLayerThreadDatum[] = [];

  for (const item of cards) {
    const parentId = item.node.parentId;
    if (!parentId || !cardIds.has(parentId)) continue;
    const parent = cardById.get(parentId);
    const parentLayout = layouts.get(parentId);
    const childLayout = layouts.get(item.node.id);
    if (!parent || !parentLayout || !childLayout) continue;
    threads.push({
      id: `family:${parentId}->${item.node.id}`,
      kind: "family",
      sourceId: parentId,
      targetId: item.node.id,
      source: bottomCenter(parentLayout),
      target: topCenter(childLayout),
      width: threadWidthPixels(parent.node, item.node, maxDepth, true)
    });
  }

  return threads;
}

function overviewThreadEndpoints(
  sourceGlow: { x: number; y: number },
  targetGlow: { x: number; y: number },
  sourceRect: TooltipRect,
  targetRect: TooltipRect,
  terrainWeight: number
): { source: { x: number; y: number }; target: { x: number; y: number } } {
  const cardEndpoints = overviewCardThreadEndpoints(sourceRect, targetRect);
  const weight = clamp(terrainWeight, 0, 1);
  return {
    source: interpolateScreenPoint(cardEndpoints.source, sourceGlow, weight),
    target: interpolateScreenPoint(cardEndpoints.target, targetGlow, weight)
  };
}

function interpolateScreenPoint(
  from: { x: number; y: number },
  to: { x: number; y: number },
  weight: number
): { x: number; y: number } {
  return {
    x: from.x + (to.x - from.x) * weight,
    y: from.y + (to.y - from.y) * weight
  };
}

function topCenter(rect: TooltipRect): { x: number; y: number } {
  return {
    x: rect.left + rect.width / 2,
    y: rect.top
  };
}

function bottomCenter(rect: TooltipRect): { x: number; y: number } {
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height
  };
}

function rectCenter(rect: TooltipRect): { x: number; y: number } {
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2
  };
}

function nearestPointOnRect(point: { x: number; y: number }, rect: TooltipRect): { x: number; y: number } {
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const dx = point.x - centerX;
  const dy = point.y - centerY;
  if (Math.abs(dx) / rect.width > Math.abs(dy) / rect.height) {
    return {
      x: dx > 0 ? rect.left + rect.width : rect.left,
      y: clamp(point.y, rect.top, rect.top + rect.height)
    };
  }
  return {
    x: clamp(point.x, rect.left, rect.left + rect.width),
    y: dy > 0 ? rect.top + rect.height : rect.top
  };
}

function leaderLineLength(point: { x: number; y: number }, rect: TooltipRect): number {
  const target = nearestPointOnRect(point, rect);
  return Math.hypot(target.x - point.x, target.y - point.y);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function snapshotMapView(map: MapLibreMap): StoredMapView {
  const center = map.getCenter();
  return {
    center: [center.lng, center.lat],
    zoom: map.getZoom(),
    pitch: map.getPitch(),
    bearing: map.getBearing()
  };
}

function focusMapOnPoints2d(map: MapLibreMap, points: AyaSpatialPoint[], options: FocusMapOptions = {}): void {
  const allFinitePoints = points.filter(isFiniteSpatialPoint);
  const finitePoints = options.majorityFraction
    ? centralMajorityPoints(allFinitePoints, options.majorityFraction)
    : allFinitePoints;
  if (finitePoints.length === 0) return;

  if (finitePoints.length === 1) {
    const point = finitePoints[0]!;
    map.easeTo({
      center: [point.lng, point.lat],
      zoom: options.singlePointZoom ?? 15,
      pitch: options.pitch ?? 0,
      bearing: options.bearing ?? 0,
      duration: options.duration ?? 620
    });
    return;
  }

  const first = finitePoints[0]!;
  const bounds = new maplibregl.LngLatBounds([first.lng, first.lat], [first.lng, first.lat]);
  for (const point of finitePoints.slice(1)) {
    bounds.extend([point.lng, point.lat]);
  }

  map.fitBounds(bounds, {
    padding: options.padding ?? overviewPaddingForContainer(map.getContainer()),
    maxZoom: options.maxZoom ?? 15.4,
    duration: options.duration ?? 680,
    pitch: options.pitch ?? 0,
    bearing: options.bearing ?? 0
  });
}

function overviewPaddingForContainer(container: HTMLElement): { top: number; right: number; bottom: number; left: number } {
  const narrow = container.clientWidth <= 760;
  return narrow
    ? { top: 230, right: 34, bottom: 150, left: 34 }
    : { top: 130, right: 128, bottom: 130, left: 430 };
}

function visualizationPaddingForContainer(container: HTMLElement): MapPadding {
  const narrow = container.clientWidth <= 760;
  return narrow
    ? { top: 72, right: 18, bottom: 64, left: 18 }
    : { top: 52, right: 44, bottom: 58, left: 180 };
}

function centralMajorityPoints(points: AyaSpatialPoint[], fraction: number): AyaSpatialPoint[] {
  if (points.length < 4) return points;
  const center = {
    lng: median(points.map((point) => point.lng)),
    lat: median(points.map((point) => point.lat))
  };
  const keepCount = Math.max(2, Math.ceil(points.length * clamp(fraction, 0.1, 1)));
  return [...points]
    .sort((a, b) => squaredLngLatDistance(a, center) - squaredLngLatDistance(b, center))
    .slice(0, keepCount);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[midpoint - 1] ?? 0) + (sorted[midpoint] ?? 0)) / 2 : (sorted[midpoint] ?? 0);
}

function squaredLngLatDistance(point: AyaSpatialPoint, center: { lng: number; lat: number }): number {
  const lng = point.lng - center.lng;
  const lat = point.lat - center.lat;
  return lng * lng + lat * lat;
}

function isFiniteSpatialPoint(point: AyaSpatialPoint): boolean {
  return Number.isFinite(point.lng) && Number.isFinite(point.lat);
}

function rootProximity(node: AyaNode, maxDepth: number): number {
  if (maxDepth <= 0) return 1;
  return 1 - Math.min(node.depth, maxDepth) / (maxDepth + 1);
}

function threadWidthPixels(source: AyaNode, target: AyaNode, maxDepth: number, isOverview: boolean): number {
  const proximity = Math.max(rootProximity(source, maxDepth), rootProximity(target, maxDepth));
  const base = isOverview ? 0.95 : 1.1;
  const span = isOverview ? 3.25 : 3.55;
  return Math.round((base + span * proximity) * 10) / 10;
}

function isGroupOutlineVisibleAtZoom(node: AyaNode, zoom: number): boolean {
  if (zoom < 11) return node.type === "group" && node.depth === 0;
  if (zoom < 13.5) return node.type === "group" && node.depth <= 2;
  if (zoom < 15.2) return node.type === "group" || node.depth <= 2;
  return true;
}

function createOrganicSemanticLayout(graph: AyaGraph): Map<string, AyaSpatialPoint> {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const childrenByParent = new Map<string, AyaNode[]>();
  for (const node of graph.nodes) {
    if (!node.parentId) continue;
    const siblings = childrenByParent.get(node.parentId) ?? [];
    siblings.push(node);
    childrenByParent.set(node.parentId, siblings);
  }
  childrenByParent.forEach((siblings) =>
    siblings.sort((a, b) => {
      if (a.type !== b.type) return a.type === "group" ? -1 : 1;
      return a.id.localeCompare(b.id);
    })
  );

  const topIds = Array.from(new Set(graph.nodes.map((node) => node.topAncestorId))).sort();
  const topCenters = organicClusterCenters(topIds.length);
  const layout = new Map<
    string,
    { x: number; y: number; anchorX: number; anchorY: number; pinned: boolean; topAncestorId: string }
  >();

  topIds.forEach((topId, index) => {
    const root = nodeById.get(topId) ?? graph.nodes.find((node) => node.topAncestorId === topId && !node.parentId);
    if (!root) return;
    const center = topCenters[index] ?? { x: 0, y: 0 };
    const next = topCenters[Math.min(topCenters.length - 1, index + 1)] ?? center;
    const previous = topCenters[Math.max(0, index - 1)] ?? center;
    const tangent = Math.atan2(next.y - previous.y, next.x - previous.x) || 0;
    layoutSubtreeOrganic(root, center.x, center.y, tangent, childrenByParent, layout);
    const rootState = layout.get(root.id);
    if (rootState) {
      rootState.pinned = true;
      rootState.anchorX = center.x;
      rootState.anchorY = center.y;
    }
  });

  for (const node of graph.nodes) {
    if (layout.has(node.id)) continue;
    const topIndex = Math.max(0, topIds.indexOf(node.topAncestorId));
    const fallbackCenter = topCenters[topIndex] ?? { x: 0, y: 0 };
    const angle = seededUnit(`${node.id}:fallback-angle`) * Math.PI * 2;
    const radius = 96 + node.depth * 28;
    layout.set(node.id, {
      x: fallbackCenter.x + Math.cos(angle) * radius,
      y: fallbackCenter.y + Math.sin(angle) * radius,
      anchorX: fallbackCenter.x + Math.cos(angle) * radius,
      anchorY: fallbackCenter.y + Math.sin(angle) * radius,
      pinned: false,
      topAncestorId: node.topAncestorId
    });
  }

  const semanticEdges = organicSemanticEdges(graph, childrenByParent, topIds);
  relaxOrganicLayout(layout, semanticEdges, nodeById);

  return new Map(
    graph.nodes.map((node) => [
      node.id,
      localMetersToSpatialPoint(
        graph.center,
        layout.get(node.id) ?? { x: 0, y: 0, anchorX: 0, anchorY: 0, pinned: false, topAncestorId: node.topAncestorId },
        node.semantic.altitude
      )
    ])
  );
}

function organicClusterCenters(count: number): Array<{ x: number; y: number }> {
  if (count <= 0) return [];
  const spanX = 1040;
  const amplitude = 290;
  return Array.from({ length: count }, (_, index) => {
    const progress = count === 1 ? 0.5 : index / (count - 1);
    const x = -spanX / 2 + progress * spanX;
    const y = Math.sin(progress * Math.PI * 1.35 - Math.PI * 0.62) * amplitude + Math.sin(progress * Math.PI * 3.1) * 48;
    return { x, y };
  });
}

function layoutSubtreeOrganic(
  node: AyaNode,
  x: number,
  y: number,
  direction: number,
  childrenByParent: Map<string, AyaNode[]>,
  layout: Map<string, { x: number; y: number; anchorX: number; anchorY: number; pinned: boolean; topAncestorId: string }>
): void {
  if (!layout.has(node.id)) {
    layout.set(node.id, { x, y, anchorX: x, anchorY: y, pinned: false, topAncestorId: node.topAncestorId });
  }

  const children = childrenByParent.get(node.id) ?? [];
  if (children.length === 0) return;

  const span = children.length <= 1 ? 0 : Math.min(1.48, 0.48 + (children.length - 2) * 0.17);
  const state = layout.get(node.id)!;
  children.forEach((child, index) => {
    const spread = children.length === 1 ? 0 : (index - (children.length - 1) / 2) / Math.max(1, children.length - 1);
    const bend = (seededUnit(`${child.id}:bend`) - 0.5) * 0.28;
    const childDirection = direction + spread * span + bend;
    const distance = organicBranchDistance(node, child, index, children.length);
    const childX = state.x + Math.cos(childDirection) * distance;
    const childY = state.y + Math.sin(childDirection) * distance;
    if (!layout.has(child.id)) {
      layout.set(child.id, {
        x: childX,
        y: childY,
        anchorX: childX,
        anchorY: childY,
        pinned: false,
        topAncestorId: child.topAncestorId
      });
    }
    layoutSubtreeOrganic(child, childX, childY, childDirection, childrenByParent, layout);
  });
}

function organicBranchDistance(parent: AyaNode, child: AyaNode, index: number, siblingCount: number): number {
  const base =
    child.type === "group"
      ? 172 + Math.max(0, 4 - child.depth) * 16
      : 116 + Math.max(0, 5 - child.depth) * 10;
  const siblingTightening = siblingCount > 1 ? Math.min(24, siblingCount * 3.5) : 0;
  const jitter = (seededUnit(`${child.id}:distance`) - 0.5) * 24 + index * 3.5;
  const parentLift = parent.type === "group" ? 10 : -4;
  return Math.max(88, base + parentLift - siblingTightening + jitter);
}

function organicSemanticEdges(
  graph: AyaGraph,
  childrenByParent: Map<string, AyaNode[]>,
  topIds: string[]
): Array<{ source: string; target: string; kind: "parent" | "json" | "sibling" | "bridge" }> {
  const edges: Array<{ source: string; target: string; kind: "parent" | "json" | "sibling" | "bridge" }> = [];
  const seen = new Set<string>();
  const push = (source: string, target: string, kind: "parent" | "json" | "sibling" | "bridge") => {
    if (source === target) return;
    const [a, b] = source < target ? [source, target] : [target, source];
    const key = `${kind}:${a}:${b}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ source, target, kind });
  };

  for (const node of graph.nodes) {
    if (node.parentId) push(node.parentId, node.id, "parent");
  }
  for (const edge of graph.edges) {
    push(edge.source, edge.target, "json");
  }
  childrenByParent.forEach((siblings) => {
    for (let index = 1; index < siblings.length; index += 1) {
      push(siblings[index - 1]!.id, siblings[index]!.id, "sibling");
    }
  });
  for (let index = 1; index < topIds.length; index += 1) {
    push(topIds[index - 1]!, topIds[index]!, "bridge");
  }

  return edges;
}

function relaxOrganicLayout(
  layout: Map<string, { x: number; y: number; anchorX: number; anchorY: number; pinned: boolean; topAncestorId: string }>,
  edges: Array<{ source: string; target: string; kind: "parent" | "json" | "sibling" | "bridge" }>,
  nodeById: Map<string, AyaNode>
): void {
  const keys = [...layout.keys()];
  for (let iteration = 0; iteration < 18; iteration += 1) {
    for (const edge of edges) {
      const source = layout.get(edge.source);
      const target = layout.get(edge.target);
      const sourceNode = nodeById.get(edge.source);
      const targetNode = nodeById.get(edge.target);
      if (!source || !target || !sourceNode || !targetNode) continue;

      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const distance = Math.hypot(dx, dy) || 1;
      const desired = organicDesiredDistance(sourceNode, targetNode, edge.kind);
      const force = ((distance - desired) / distance) * organicSpring(edge.kind);
      const moveX = dx * force;
      const moveY = dy * force;

      if (!source.pinned) {
        source.x += moveX * 0.5;
        source.y += moveY * 0.5;
      }
      if (!target.pinned) {
        target.x -= moveX * 0.5;
        target.y -= moveY * 0.5;
      }
    }

    for (let index = 0; index < keys.length; index += 1) {
      const left = layout.get(keys[index]!);
      if (!left) continue;
      for (let nextIndex = index + 1; nextIndex < keys.length; nextIndex += 1) {
        const right = layout.get(keys[nextIndex]!);
        if (!right) continue;
        const dx = right.x - left.x;
        const dy = right.y - left.y;
        const distance = Math.hypot(dx, dy) || 1;
        const minimum = left.topAncestorId === right.topAncestorId ? 82 : 108;
        if (distance >= minimum) continue;
        const push = ((minimum - distance) / distance) * 0.18;
        const moveX = dx * push;
        const moveY = dy * push;
        if (!left.pinned) {
          left.x -= moveX * 0.5;
          left.y -= moveY * 0.5;
        }
        if (!right.pinned) {
          right.x += moveX * 0.5;
          right.y += moveY * 0.5;
        }
      }
    }

    for (const state of layout.values()) {
      const anchorStrength = state.pinned ? 0.42 : 0.12;
      state.x += (state.anchorX - state.x) * anchorStrength;
      state.y += (state.anchorY - state.y) * anchorStrength;
    }
  }
}

function organicDesiredDistance(source: AyaNode, target: AyaNode, kind: "parent" | "json" | "sibling" | "bridge"): number {
  if (kind === "bridge") return 286;
  if (kind === "sibling") return 132 + Math.min(source.depth, target.depth) * 8;
  if (kind === "json") return source.topAncestorId === target.topAncestorId ? 156 : 228;
  return target.type === "group" || source.type === "group" ? 168 : 132;
}

function organicSpring(kind: "parent" | "json" | "sibling" | "bridge"): number {
  if (kind === "bridge") return 0.1;
  if (kind === "json") return 0.08;
  if (kind === "sibling") return 0.11;
  return 0.14;
}

function localMetersToSpatialPoint(
  center: GeoCenter,
  point: { x: number; y: number },
  altitude: number
): AyaSpatialPoint {
  const clamped = clampLocalMeters(point.x, point.y, 1420);
  const lngLat = offsetCenterByMeters(center, clamped.x, clamped.y);
  return {
    x: clamped.x,
    y: clamped.y,
    lng: lngLat.lng,
    lat: lngLat.lat,
    altitude
  };
}

function createSemanticScaffoldThreads(
  graph: AyaGraph,
  visualThreads: VisualThread[],
  nodeById: Map<string, ScreenNode>
): IdeaLayerThreadDatum[] {
  const threads: IdeaLayerThreadDatum[] = [];
  for (const edge of visualThreads) {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) continue;
    threads.push({
      id: `semantic:${edge.id}`,
      kind: edge.kind,
      sourceId: edge.source,
      targetId: edge.target,
      source: source.screen,
      target: target.screen,
      width: Math.max(1.6, threadWidthPixels(source.node, target.node, graph.maxDepth, false) * 0.72)
    });
  }

  const topIds = Array.from(new Set(graph.nodes.map((node) => node.topAncestorId))).sort();
  for (let index = 1; index < topIds.length; index += 1) {
    const source = nodeById.get(topIds[index - 1]!);
    const target = nodeById.get(topIds[index]!);
    if (!source || !target) continue;
    threads.push({
      id: `semantic:bridge:${topIds[index - 1]}:${topIds[index]}`,
      kind: "parent",
      sourceId: topIds[index - 1]!,
      targetId: topIds[index]!,
      source: source.screen,
      target: target.screen,
      width: 2.6
    });
  }

  return threads;
}

function visualPointForNode(node: AyaNode, blend: number, semanticOverride?: AyaSpatialPoint): AyaSpatialPoint {
  return interpolatePoint(semanticOverride ?? node.semantic, node.geo, blend);
}

function placementClassForNode(node: AyaNode): "abstract" | "mapped" {
  return node.type === "card" && node.geoPlacementSource === "fallback" ? "abstract" : "mapped";
}

function isGlowVisibleOnScreen(item: ScreenNode, width: number, height: number): boolean {
  const margin = glowVisibilityMarginPixels(item.node);
  return (
    item.screen.x >= -margin &&
    item.screen.x <= width + margin &&
    item.screen.y >= -margin &&
    item.screen.y <= height + margin
  );
}

function glowVisibilityMarginPixels(node: AyaNode): number {
  if (node.type === "group" && node.depth === 0) return 80;
  if (node.type === "group") return 70;
  if (node.geoPlacementSource === "fallback" || node.geoPlacementSource === "manual") return 60;
  return 52;
}

function renderRank(node: AyaNode, maxDepth: number): number {
  const rootProximity = Math.max(0, maxDepth - node.depth + 1);
  const typeOffset = node.type === "card" ? 80 : 20;
  return typeOffset + rootProximity;
}

interface CustomLayerProjectionTransform {
  getProjectionDataForCustomLayer?: () => { mainMatrix: ArrayLike<number> };
}

function isForwardedWheelEvent(event: WheelEvent): boolean {
  return Boolean((event as WheelEvent & { ayatoposForwardedToMap?: boolean }).ayatoposForwardedToMap);
}

function projectNodeGlowToScreen(map: MapLibreMap, node: AyaNode, point: AyaSpatialPoint): { x: number; y: number } {
  const transform = (map as unknown as { transform?: CustomLayerProjectionTransform }).transform;
  const matrix = transform?.getProjectionDataForCustomLayer?.().mainMatrix;
  if (!matrix) {
    const fallback = map.project([point.lng, point.lat]) as PointLike & { x: number; y: number };
    return { x: fallback.x, y: fallback.y };
  }

  const elevation = nodeElevationMeters(map, node, point);
  const coordinate = MercatorCoordinate.fromLngLat([point.lng, point.lat], elevation);
  const clipX = matrix[0]! * coordinate.x + matrix[4]! * coordinate.y + matrix[8]! * coordinate.z + matrix[12]!;
  const clipY = matrix[1]! * coordinate.x + matrix[5]! * coordinate.y + matrix[9]! * coordinate.z + matrix[13]!;
  const clipW = matrix[3]! * coordinate.x + matrix[7]! * coordinate.y + matrix[11]! * coordinate.z + matrix[15]!;

  if (!Number.isFinite(clipW) || Math.abs(clipW) < 1e-9) {
    const fallback = map.project([point.lng, point.lat]) as PointLike & { x: number; y: number };
    return { x: fallback.x, y: fallback.y };
  }

  const container = map.getContainer();
  const normalizedX = clipX / clipW;
  const normalizedY = clipY / clipW;
  return {
    x: ((normalizedX + 1) / 2) * container.clientWidth,
    y: ((1 - normalizedY) / 2) * container.clientHeight
  };
}

function createVisualThreads(graph: AyaGraph): VisualThread[] {
  const threads = new Map<string, VisualThread>();
  const nodeIds = new Set(graph.nodes.map((node) => node.id));

  const addThread = (source: string, target: string, kind: VisualThread["kind"], id?: string) => {
    if (source === target || !nodeIds.has(source) || !nodeIds.has(target)) return;
    const [a, b] = source < target ? [source, target] : [target, source];
    const key = `${kind}:${a}->${b}`;
    if (!threads.has(key)) {
      threads.set(key, { id: id ?? key, source, target, kind });
    }
  };

  for (const edge of graph.edges) {
    addThread(edge.source, edge.target, "json", `json:${edge.id}`);
  }

  const siblingsByParent = new Map<string, AyaNode[]>();
  for (const node of graph.nodes) {
    if (!node.parentId) continue;
    addThread(node.parentId, node.id, "parent");
    const siblings = siblingsByParent.get(node.parentId) ?? [];
    siblings.push(node);
    siblingsByParent.set(node.parentId, siblings);
  }

  siblingsByParent.forEach((siblings, parentId) => {
    const sorted = [...siblings].sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));
    for (let index = 1; index < sorted.length; index += 1) {
      addThread(sorted[index - 1]!.id, sorted[index]!.id, "sibling", `sibling:${parentId}:${index}`);
    }
  });

  return [...threads.values()];
}

function connectedVisualIds(threads: VisualThread[], nodeId: string): Set<string> {
  const ids = new Set<string>([nodeId]);
  for (const thread of threads) {
    if (thread.source === nodeId) ids.add(thread.target);
    if (thread.target === nodeId) ids.add(thread.source);
  }
  return ids;
}

function overviewRelatedNodeIds(graph: AyaGraph, nodeId: string): { ids: string[]; collateralIds: Set<string> } {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const childrenByParent = new Map<string, AyaNode[]>();
  const rootNodes: AyaNode[] = [];
  for (const node of graph.nodes) {
    if (!node.parentId) {
      rootNodes.push(node);
      continue;
    }
    const children = childrenByParent.get(node.parentId) ?? [];
    children.push(node);
    childrenByParent.set(node.parentId, children);
  }
  childrenByParent.forEach((children) => children.sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id)));
  rootNodes.sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));

  const ids: string[] = [];
  const collateralIds = new Set<string>();
  const seen = new Set<string>();
  const add = (id: string, collateral = false) => {
    if (!nodeById.has(id)) return false;
    if (seen.has(id)) return false;
    if (collateral) collateralIds.add(id);
    seen.add(id);
    ids.push(id);
    return true;
  };

  add(nodeId);

  const siblingsOf = (node: AyaNode): AyaNode[] => {
    const siblings = node.parentId ? childrenByParent.get(node.parentId) ?? [] : rootNodes;
    return siblings.filter((sibling) => sibling.id !== node.id);
  };

  const addDescendants = (parentId: string) => {
    for (const child of childrenByParent.get(parentId) ?? []) {
      if (!add(child.id)) continue;
      addDescendants(child.id);
    }
  };

  const origin = nodeById.get(nodeId);
  if (origin) {
    let current = origin;
    while (current.parentId) {
      const parent = nodeById.get(current.parentId);
      if (!parent) break;
      add(parent.id);
      current = parent;
    }

    addDescendants(origin.id);

    for (const sibling of siblingsOf(origin)) {
      add(sibling.id, true);
    }

    const parent = origin.parentId ? nodeById.get(origin.parentId) : undefined;
    if (parent?.parentId) {
      for (const sibling of siblingsOf(parent)) {
        add(sibling.id, true);
      }
    }
  }

  return { ids, collateralIds };
}

function outlinePath(outline: AyaGroupOutline, map: MapLibreMap): string {
  const points = outline.points.map((point) => map.project([point.lng, point.lat]) as PointLike & { x: number; y: number });
  if (points.length < 3) return "";
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ") + " Z";
}

function mergeGeoPlacements(basePlacements: GeoPlacement[], manualPlacements: ManualPlacementRecord): GeoPlacement[] {
  const placements = new Map(basePlacements.map((placement) => [placement.nodeId, placement]));
  for (const placement of Object.values(manualPlacements)) {
    placements.set(placement.nodeId, placement);
  }
  return [...placements.values()];
}

function bundledDemoPlacementsForCenter(rawExport: HypoWeaveExport, center: GeoCenter): GeoPlacement[] {
  const demoGeo = rawExport.ayatopos?.demoGeo;
  if (!demoGeo || !sameGeoCenter(demoGeo.center, center)) return [];
  return demoGeo.placements
    .filter(
      (placement: GeoPlacement) =>
        typeof placement?.nodeId === "string" &&
        isValidLngLat(placement.lng, placement.lat) &&
        Number.isFinite(placement.confidence)
    )
    .map((placement: GeoPlacement) => ({
      nodeId: placement.nodeId,
      lng: placement.lng,
      lat: placement.lat,
      confidence: placement.confidence,
      source: "preset" as const
    }));
}

function bundledDemoInitialView(rawExport: HypoWeaveExport): { center: GeoCenter; placements: GeoPlacement[] } | null {
  const center = rawExport.ayatopos?.demoGeo?.center;
  if (!center || !isValidLngLat(center.lng, center.lat)) return null;
  return {
    center,
    placements: bundledDemoPlacementsForCenter(rawExport, center)
  };
}

function sameGeoCenter(a: GeoCenter, b: GeoCenter): boolean {
  return Math.abs(a.lng - b.lng) <= 0.000001 && Math.abs(a.lat - b.lat) <= 0.000001;
}

function manualGeoStorageKey(center: GeoCenter, fileName: string, rawExport: HypoWeaveExport): string {
  const centerKey = `${center.lng.toFixed(6)},${center.lat.toFixed(6)}`;
  const ids = getHypoWeaveSnapshot(rawExport).nodes.map((node) => node.id).sort().join("|");
  return `ayatopos:manual-geo:${centerKey}:${fileName || "untitled"}:${hashString(ids)}`;
}

function loadManualGeoPlacements(key: string): ManualPlacementRecord {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? "[]") as GeoPlacement[];
    return parsed.reduce<ManualPlacementRecord>((record, placement) => {
      if (placement.source !== "manual" || !isValidLngLat(placement.lng, placement.lat)) return record;
      record[placement.nodeId] = {
        nodeId: placement.nodeId,
        lng: placement.lng,
        lat: placement.lat,
        confidence: 1,
        source: "manual"
      };
      return record;
    }, {});
  } catch {
    return {};
  }
}

function saveManualGeoPlacements(key: string, placements: ManualPlacementRecord): void {
  const values = Object.values(placements);
  if (values.length === 0) {
    window.localStorage.removeItem(key);
    return;
  }
  window.localStorage.setItem(key, JSON.stringify(values));
}

function isValidLngLat(lng: number, lat: number): boolean {
  return Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lng) <= 180 && Math.abs(lat) <= 90;
}

function autoPanOffsetForPointer(x: number, y: number, width: number, height: number): { x: number; y: number } {
  const edge = 96;
  const maxStep = 34;
  return {
    x: autoPanAxisOffset(x, width, edge, maxStep),
    y: autoPanAxisOffset(y, height, edge, maxStep)
  };
}

function autoPanAxisOffset(value: number, size: number, edge: number, maxStep: number): number {
  if (value < edge) return -Math.min(maxStep, Math.ceil(((edge - value) / edge) * maxStep));
  if (value > size - edge) return Math.min(maxStep, Math.ceil(((value - (size - edge)) / edge) * maxStep));
  return 0;
}

function hashString(input: string): string {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function seededUnit(input: string): number {
  return parseInt(hashString(input), 36) / 4294967295;
}

function clampLocalMeters(x: number, y: number, radiusMeters: number): { x: number; y: number } {
  const distance = Math.hypot(x, y);
  if (distance <= radiusMeters || distance === 0) return { x, y };
  const ratio = radiusMeters / distance;
  return { x: x * ratio, y: y * ratio };
}

function offsetCenterByMeters(center: GeoCenter, eastMeters: number, northMeters: number): { lng: number; lat: number } {
  return {
    lng: center.lng + eastMeters / metersPerDegreeLng(center.lat),
    lat: center.lat + northMeters / METERS_PER_DEGREE_LAT
  };
}

function metersPerDegreeLng(lat: number): number {
  return Math.max(1, METERS_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180));
}

function semanticTransitionStrength(blend: number): number {
  return clamp((0.22 - blend) / 0.22, 0, 1);
}

function spaceModeForStrength(strength: number): "map" | "transition" | "space" {
  if (strength >= 0.999) return "space";
  if (strength <= 0.001) return "map";
  return "transition";
}

function createSpaceStarFieldStyles(): { far: React.CSSProperties; near: React.CSSProperties } {
  return {
    far: createStarFieldStyle(44, 0.45, 1.2, [
      "rgba(255, 251, 245, 0.92)",
      "rgba(174, 210, 255, 0.8)",
      "rgba(255, 224, 182, 0.68)"
    ]),
    near: createStarFieldStyle(28, 0.8, 1.9, [
      "rgba(255, 252, 247, 0.94)",
      "rgba(188, 223, 255, 0.86)",
      "rgba(255, 229, 198, 0.76)"
    ])
  };
}

function createStarFieldStyle(
  count: number,
  minRadius: number,
  maxRadius: number,
  palette: string[]
): React.CSSProperties {
  const gradients: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const x = (Math.random() * 100).toFixed(2);
    const y = (Math.random() * 100).toFixed(2);
    const radius = randomBetween(minRadius, maxRadius);
    const fade = radius + randomBetween(0.45, 0.95);
    const color = palette[Math.floor(Math.random() * palette.length)] ?? palette[0] ?? "rgba(255,255,255,0.9)";
    gradients.push(
      `radial-gradient(circle at ${x}% ${y}%, ${color} 0 ${radius.toFixed(2)}px, rgba(255,255,255,0) ${fade.toFixed(
        2
      )}px)`
    );
  }

  return {
    backgroundImage: gradients.join(", "),
    backgroundRepeat: "no-repeat",
    backgroundSize: "100% 100%"
  };
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
