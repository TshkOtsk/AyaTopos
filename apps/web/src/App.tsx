import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { MercatorCoordinate, type Map as MapLibreMap, type PointLike } from "maplibre-gl";
import {
  Blend,
  CircleHelp,
  Eye,
  FileJson,
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
import { ensureTerrain, mapStyle } from "./mapStyle";

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

interface TooltipLayout {
  item: ScreenNode;
  left: number;
  top: number;
}

export function App() {
  const [rawExport, setRawExport] = useState<HypoWeaveExport | null>(null);
  const [fileName, setFileName] = useState("");
  const [areaText, setAreaText] = useState("");
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
      if (!parsed.snapshot?.nodes?.length) throw new Error("snapshot.nodes が見つかりません。");
      setRawExport(parsed);
      setFileName(file.name);
      setGraph(null);
      setCurrentCenter(null);
      setBasePlacements([]);
      setManualPlacements({});
      setViewMode("view");
      setSelectedCardId(null);
      setHoveredId(null);
      setStatus("ready");
      setMessage(`${parsed.snapshot.nodes.length} ノードを読み込みました。`);
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "JSONの読み込みに失敗しました。");
    }
  }, []);

  const loadSample = useCallback(async () => {
    try {
      setStatus("loading");
      const response = await fetch("/samples/minyo-nepal.json");
      if (!response.ok) throw new Error("サンプルJSONが見つかりません。");
      const parsed = (await response.json()) as HypoWeaveExport;
      setRawExport(parsed);
      setFileName("民謡とネパール.json");
      setGraph(null);
      setCurrentCenter(null);
      setBasePlacements([]);
      setManualPlacements({});
      setViewMode("view");
      setSelectedCardId(null);
      setHoveredId(null);
      setStatus("ready");
      setMessage(`${parsed.snapshot?.nodes?.length ?? 0} ノードを読み込みました。`);
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "サンプルの読み込みに失敗しました。");
    }
  }, []);

  const visualize = useCallback(async () => {
    if (!rawExport) {
      setStatus("error");
      setMessage("先にJSONを読み込んでください。");
      return;
    }
    if (!areaText.trim()) {
      setStatus("error");
      setMessage("中心エリアを入力してください。");
      return;
    }

    try {
      setStatus("loading");
      setMessage("中心エリアを解決しています。");
      const resolved = await resolveArea(areaText.trim());
      const manual = parseManualCenter(areaText.trim());
      const center = resolved.center ?? manual;

      if (!center) {
        setStatus("error");
        setMessage("中心エリアを解決できませんでした。緯度,経度 形式でも入力できます。");
        return;
      }

      const semanticGraph = normalizeHypoWeave(rawExport, { center });
      setCurrentCenter(center);
      setBasePlacements([]);
      setViewMode("view");
      setSelectedCardId(null);
      setGraph(semanticGraph);
      setBlend(0.18);
      setMessage("地理配置を推定しています。");

      const response = await requestPlacements({
        areaText: areaText.trim(),
        center,
        nodes: toPlacementInputs(semanticGraph)
      });
      setBasePlacements(response.placements);
      setBlend(response.mode === "gemini" ? 0.62 : 0.42);
      setStatus("ready");
      setMessage(
        response.mode === "gemini"
          ? "Geminiによる地理配置を反映しました。"
          : "フォールバック配置で可視化しました。"
      );
    } catch (error) {
      const center = parseManualCenter(areaText.trim()) ?? DEFAULT_CENTER;
      const fallbackGraph = normalizeHypoWeave(rawExport, { center });
      setCurrentCenter(center);
      setBasePlacements([]);
      setViewMode("view");
      setSelectedCardId(null);
      setGraph(fallbackGraph);
      setStatus("error");
      setMessage(error instanceof Error ? `${error.message} フォールバック表示に切り替えました。` : "フォールバック表示に切り替えました。");
    }
  }, [areaText, rawExport]);

  return (
    <main className={`app-shell ${isGeoEditing ? "geo-editing" : ""}`} style={{ "--blend": blend } as React.CSSProperties}>
      <MapScene
        graph={graph}
        blend={blend}
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
            <button className="secondary-action" type="button" onClick={loadSample}>
              <FileJson size={18} />
              サンプル
            </button>
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
  hoveredId,
  onHover,
  isGeoEditing,
  selectedCardId,
  onSelectCard,
  onUpdateCardGeo
}: {
  graph: AyaGraph | null;
  blend: number;
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
  const editViewRef = useRef<{ pitch: number; bearing: number } | null>(null);
  const overviewReturnViewRef = useRef<StoredMapView | null>(null);
  const [overviewNodeId, setOverviewNodeId] = useState<string | null>(null);
  const [lockedOverviewCardLayouts, setLockedOverviewCardLayouts] = useState<Map<string, IdeaLayerCardLayout>>(new Map());
  const [shouldLockOverviewLayout, setShouldLockOverviewLayout] = useState(false);
  const [tick, setTick] = useState(0);
  const isRelatedOverview = Boolean(overviewNodeId) && !isGeoEditing;

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
      center: [DEFAULT_CENTER.lng, DEFAULT_CENTER.lat],
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
    window.requestAnimationFrame(initialize3d);

    return () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
      }
      sceneRef.current?.removeEventListener("wheel", forwardOverlayWheelToMap, { capture: true });
      map.remove();
      mapRef.current = null;
      ideaLayerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!graph || !mapRef.current) return;
    setOverviewNodeId(null);
    overviewReturnViewRef.current = null;
    setLockedOverviewCardLayouts(new Map());
    setShouldLockOverviewLayout(false);
    mapRef.current.easeTo({
      center: [graph.center.lng, graph.center.lat],
      zoom: 12,
      pitch: 70,
      bearing: -22,
      duration: 900
    });
  }, [graph?.center.lat, graph?.center.lng]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (isGeoEditing) {
      setOverviewNodeId(null);
      overviewReturnViewRef.current = null;
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

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isRelatedOverview) return;
    disableOverviewMapZoom(map);
    return () => {
      enableOverviewMapZoom(map);
    };
  }, [isRelatedOverview]);

  const zoom = mapRef.current?.getZoom() ?? 0;
  const visualThreads = useMemo(() => (graph ? createVisualThreads(graph) : []), [graph]);
  const focusNodeId = isRelatedOverview ? overviewNodeId : hoveredId;
  const layerActiveNodeId = isRelatedOverview ? hoveredId ?? overviewNodeId : hoveredId;
  const relatedIds = useMemo(
    () =>
      graph && focusNodeId
        ? connectedVisualIds(visualThreads, focusNodeId)
        : new Set<string>(),
    [focusNodeId, graph, visualThreads]
  );
  const activeVisualThreads = useMemo(
    () =>
      isRelatedOverview
        ? visualThreads.filter((edge) => edge.source === overviewNodeId || edge.target === overviewNodeId)
        : hoveredId && !isGeoEditing
          ? visualThreads.filter((edge) => edge.source === hoveredId || edge.target === hoveredId)
          : [],
    [hoveredId, isGeoEditing, isRelatedOverview, overviewNodeId, visualThreads]
  );

  const screenNodes = useMemo(() => {
    if (!graph || !mapRef.current) return [];

    return graph.nodes.map((node) => {
      const point = visualPointForNode(node, blend);
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
  }, [blend, focusNodeId, graph, relatedIds, tick]);

  const visibleOutlineNodeIds = useMemo(
    () =>
      new Set(
        screenNodes
          .filter(({ node }) => node.type === "group" && isGroupOutlineVisibleAtZoom(node, zoom))
          .map(({ node }) => node.id)
      ),
    [graph?.maxDepth, screenNodes, zoom]
  );

  const nodeHitTargets = useMemo(
    () =>
      [...screenNodes]
        .filter((item) => !isRelatedOverview || item.related)
        .sort((a, b) => renderRank(a.node, graph?.maxDepth ?? 0) - renderRank(b.node, graph?.maxDepth ?? 0)),
    [graph?.maxDepth, isRelatedOverview, screenNodes]
  );

  const screenOutlines = useMemo(() => {
    if (!graph || !mapRef.current) return [];
    return graph.outlines
      .filter((outline) => visibleOutlineNodeIds.has(outline.groupId))
      .map((outline) => ({
        outline,
        path: outlinePath(outline, mapRef.current!)
      }))
      .filter((item) => item.path.length > 0);
  }, [graph, tick, visibleOutlineNodeIds]);

  const nodeById = useMemo(() => new Map(screenNodes.map((item) => [item.node.id, item])), [screenNodes]);
  const computedOverviewCardLayouts = useMemo(() => {
    const container = mapRef.current?.getContainer();
    if (!container || !isRelatedOverview || !overviewNodeId) return new Map<string, IdeaLayerCardLayout>();

    const orderedIds = [
      overviewNodeId,
      ...activeVisualThreads.map((edge) => (edge.source === overviewNodeId ? edge.target : edge.source))
    ];
    const seen = new Set<string>();
    const cards = orderedIds
      .filter((id) => {
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .map((id) => nodeById.get(id))
      .filter((item): item is ScreenNode => Boolean(item))
      .filter((item) => isGlowVisibleOnScreen(item, container.clientWidth, container.clientHeight));
    const glowObstacles = screenNodes
      .filter((item) => item.related)
      .filter((item) => isGlowVisibleOnScreen(item, container.clientWidth, container.clientHeight))
      .map(glowAvoidanceRect);

    return new Map(
      placeOverviewLayerCards(cards, container.clientWidth, container.clientHeight, glowObstacles, graph?.maxDepth ?? 0).map(
        ({ item, layout }) => [item.node.id, layout]
      )
    );
  }, [activeVisualThreads, graph?.maxDepth, isRelatedOverview, nodeById, overviewNodeId, screenNodes]);
  useEffect(() => {
    if (!isRelatedOverview || !shouldLockOverviewLayout || lockedOverviewCardLayouts.size > 0 || computedOverviewCardLayouts.size === 0) {
      return;
    }
    setLockedOverviewCardLayouts(new Map(computedOverviewCardLayouts));
    setShouldLockOverviewLayout(false);
  }, [computedOverviewCardLayouts, isRelatedOverview, lockedOverviewCardLayouts.size, shouldLockOverviewLayout]);
  const overviewCardLayouts =
    isRelatedOverview && lockedOverviewCardLayouts.size > 0 ? lockedOverviewCardLayouts : computedOverviewCardLayouts;
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
      const graphThreads: IdeaLayerThreadDatum[] = [];
      for (const edge of activeVisualThreads) {
        const source = nodeById.get(edge.source);
        const target = nodeById.get(edge.target);
        if (!source || !target) continue;
        graphThreads.push({
          id: edge.id,
          kind: edge.kind,
          source: source.screen,
          target: target.screen,
          width: threadWidthPixels(source.node, target.node, graph?.maxDepth ?? 0, isRelatedOverview)
        });
      }
      if (!isRelatedOverview) return graphThreads;

      const cardLinks: IdeaLayerThreadDatum[] = [];
      for (const [nodeId, layout] of overviewCardLayouts.entries()) {
        const item = nodeById.get(nodeId);
        if (!item) continue;
        cardLinks.push({
          id: `card-link:${nodeId}`,
          kind: "card-link",
          source: item.screen,
          target: nearestPointOnRect(item.screen, layout),
          width: 2.4
        });
      }

      return [...graphThreads, ...cardLinks];
    },
    [activeVisualThreads, graph?.maxDepth, isRelatedOverview, nodeById, overviewCardLayouts]
  );
  const hoveredCards = useMemo(() => {
    if (!hoveredId || isRelatedOverview) return [];
    const container = mapRef.current?.getContainer();
    if (!container) return [];

    const orderedIds = [
      hoveredId,
      ...activeVisualThreads.map((edge) => (edge.source === hoveredId ? edge.target : edge.source))
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
  }, [activeVisualThreads, hoveredId, isRelatedOverview, nodeById]);
  const relatedGlowObstacles = useMemo<TooltipRect[]>(() => {
    const container = mapRef.current?.getContainer();
    if (!hoveredId || isRelatedOverview || !container) return [];
    return screenNodes
      .filter((item) => item.related)
      .filter((item) => isGlowVisibleOnScreen(item, container.clientWidth, container.clientHeight))
      .map(glowAvoidanceRect);
  }, [hoveredId, isRelatedOverview, screenNodes]);
  const tooltipLayouts = useMemo<TooltipLayout[]>(() => {
    const container = mapRef.current?.getContainer();
    if (!container) return [];
    return placeTooltipCards(hoveredCards, container.clientWidth, container.clientHeight, relatedGlowObstacles);
  }, [hoveredCards, relatedGlowObstacles]);

  useEffect(() => {
    ideaLayerRef.current?.setData(ideaNodes, layerActiveNodeId, {
      enabled: isGeoEditing,
      selectedId: selectedCardId,
      overview: isRelatedOverview
    }, customLayerThreads);
  }, [customLayerThreads, ideaNodes, isGeoEditing, isRelatedOverview, layerActiveNodeId, selectedCardId]);

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

  const acceptHover = useCallback(
    (nodeId: string) => {
      if (hoverClearRef.current !== null) {
        window.clearTimeout(hoverClearRef.current);
        hoverClearRef.current = null;
      }
      onHover(nodeId);
    },
    [onHover]
  );

  const releaseHover = useCallback(() => {
    if (hoverClearRef.current !== null) {
      window.clearTimeout(hoverClearRef.current);
    }
    hoverClearRef.current = window.setTimeout(() => {
      hoverClearRef.current = null;
      onHover(null);
    }, 90);
  }, [onHover]);

  const enterRelatedOverview = useCallback(
    (nodeId: string) => {
      const map = mapRef.current;
      if (!graph || !map || isGeoEditing) return;
      if (!overviewReturnViewRef.current) {
        overviewReturnViewRef.current = snapshotMapView(map);
      }
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
    setOverviewNodeId(null);
    onHover(null);
    overviewReturnViewRef.current = null;
    setLockedOverviewCardLayouts(new Map());
    setShouldLockOverviewLayout(false);

    if (!map || !returnView) return;
    map.dragRotate.enable();
    map.touchZoomRotate.enableRotation();
    enableOverviewMapZoom(map);
    map.easeTo({
      center: returnView.center,
      zoom: returnView.zoom,
      pitch: returnView.pitch,
      bearing: returnView.bearing,
      duration: 560
    });
  }, [onHover]);

  const returnToNode3d = useCallback(
    (node: AyaNode) => {
      const map = mapRef.current;
      if (!map) return;
      const returnView = overviewReturnViewRef.current;
      const point = visualPointForNode(node, blend);
      setOverviewNodeId(null);
      onHover(node.id);
      overviewReturnViewRef.current = null;
      setLockedOverviewCardLayouts(new Map());
      setShouldLockOverviewLayout(false);
      map.dragRotate.enable();
      map.touchZoomRotate.enableRotation();
      enableOverviewMapZoom(map);
      map.easeTo({
        center: [point.lng, point.lat],
        zoom: Math.max(returnView?.zoom ?? 12, 15),
        pitch: Math.max(returnView?.pitch ?? 70, 62),
        bearing: returnView?.bearing ?? -22,
        duration: 700
      });
    },
    [blend, onHover]
  );

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !graph || !overviewNodeId || !isRelatedOverview) return;

    const ids = connectedVisualIds(visualThreads, overviewNodeId);
    const points = graph.nodes
      .filter((node) => ids.has(node.id))
      .map((node) => visualPointForNode(node, blend))
      .filter(isFiniteSpatialPoint);

    map.dragRotate.disable();
    map.touchZoomRotate.disableRotation();
    disableOverviewMapZoom(map);
    setShouldLockOverviewLayout(false);
    map.once("moveend", () => setShouldLockOverviewLayout(true));
    focusMapOnPoints2d(map, points);
  }, [blend, graph, isRelatedOverview, overviewNodeId, visualThreads]);

  const handleSceneClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!isRelatedOverview) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          ".geo-point-hit-target, .overview-card-hit-target, .idea-hit-target, .idea-tooltip, .maplibregl-control-container"
        )
      ) {
        return;
      }
      exitRelatedOverview();
    },
    [exitRelatedOverview, isRelatedOverview]
  );

  return (
      <div className={`scene ${isRelatedOverview ? "related-overview" : ""}`} ref={sceneRef} onClick={handleSceneClick}>
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
                className="overview-card-hit-target"
                style={
                  {
                    left: layout.left,
                    top: layout.top,
                    width: layout.width,
                    height: layout.height
                  } as React.CSSProperties
                }
                onPointerEnter={() => acceptHover(nodeId)}
                onPointerLeave={() => {
                  if (overviewNodeId) acceptHover(overviewNodeId);
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  returnToNode3d(item.node);
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
          className={`idea-tooltip ${node.id === hoveredId ? "origin" : "connected"}`}
          onPointerEnter={() => {
            if (hoveredId) acceptHover(hoveredId);
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
          <strong>{node.shortLabel}</strong>
          <p>{node.label}</p>
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
  maxDepth: number
): Array<{ item: ScreenNode; layout: IdeaLayerCardLayout }> {
  if (cards.length === 0) return [];
  const bounds = overviewLayerPlacementBounds(viewportWidth, viewportHeight);
  const packing = overviewLayerPacking(cards, bounds, maxDepth);
  const placed: TooltipRect[] = [];
  const layouts = cards.map((item, index) => {
    const size = overviewLayerCardSize(item.node, maxDepth, packing.scale);
    const candidates = overviewCardPositionCandidates(item.screen, size.width, size.height, bounds, index);
    const best = candidates.reduce((current, candidate, candidateIndex) => {
      const cardOverlap = placed.reduce((total, rect) => total + rectOverlapArea(candidate, rect), 0);
      const glowOverlap = glowObstacles.reduce((total, rect) => total + rectOverlapArea(candidate, rect), 0);
      const leaderLength = leaderLineLength(item.screen, candidate);
      const originBias = item.node.id === cards[0]?.node.id ? candidateIndex * 0.2 : candidateIndex * 0.04;
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

  return hasOverviewLayoutCollision(layouts.map(({ layout }) => layout), glowObstacles)
    ? placeOverviewLayerCardsOnGrid(cards, bounds, glowObstacles, maxDepth, packing)
    : layouts;
}

function overviewLayerCardSize(node: AyaNode, maxDepth: number, scale = 1): { width: number; height: number } {
  const proximity = rootProximity(node, maxDepth);
  const width = Math.round(((node.type === "group" ? 226 : 202) + (node.type === "group" ? 48 : 42) * proximity) * scale);
  return {
    width,
    height: Math.round(width * 0.66)
  };
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
  maxDepth: number
): { columns: number; rows: number; scale: number } {
  const maxSize = cards.reduce(
    (size, item) => {
      const next = overviewLayerCardSize(item.node, maxDepth);
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
    const scale = Math.min(0.86, (cellWidth - gap) / maxSize.width, (cellHeight - gap) / maxSize.height);
    if (scale > best.scale) best = { columns, rows, scale };
  }

  return {
    ...best,
    scale: Math.max(0.04, best.scale)
  };
}

function overviewCardPositionCandidates(
  screen: { x: number; y: number },
  width: number,
  height: number,
  bounds: TooltipRect,
  index: number
): TooltipRect[] {
  const gap = 18;
  const maxLeft = bounds.left + Math.max(0, bounds.width - width);
  const maxTop = bounds.top + Math.max(0, bounds.height - height);
  const clampRect = (left: number, top: number): TooltipRect => ({
    left: clamp(left, bounds.left, maxLeft),
    top: clamp(top, bounds.top, maxTop),
    width,
    height
  });
  const candidates = [
    clampRect(screen.x + gap, screen.y - height / 2),
    clampRect(screen.x - width - gap, screen.y - height / 2),
    clampRect(screen.x - width / 2, screen.y - height - gap),
    clampRect(screen.x - width / 2, screen.y + gap),
    clampRect(screen.x + gap, screen.y + gap),
    clampRect(screen.x - width - gap, screen.y + gap)
  ];
  for (const offset of [12, 24, 42, 68, 96]) {
    candidates.push(
      clampRect(screen.x + offset, screen.y - height / 2),
      clampRect(screen.x - width - offset, screen.y - height / 2),
      clampRect(screen.x - width / 2, screen.y - height - offset),
      clampRect(screen.x - width / 2, screen.y + offset),
      clampRect(screen.x + offset, screen.y + offset),
      clampRect(screen.x - width - offset, screen.y + offset),
      clampRect(screen.x + offset, screen.y - height - offset),
      clampRect(screen.x - width - offset, screen.y - height - offset)
    );
  }
  const rowStep = height + 10;
  const anchorRow = Math.round((screen.y - bounds.top) / rowStep);
  const horizontalOptions = [screen.x + gap, screen.x - width - gap, screen.x - width / 2];

  for (let radius = 0; radius <= 5 + index; radius += 1) {
    const rows = radius === 0 ? [anchorRow] : [anchorRow + radius, anchorRow - radius];
    for (const row of rows) {
      const top = bounds.top + row * rowStep;
      for (const left of horizontalOptions) {
        candidates.push(clampRect(left, top));
      }
    }
  }

  return uniqueRects(candidates);
}

function placeOverviewLayerCardsOnGrid(
  cards: ScreenNode[],
  bounds: TooltipRect,
  glowObstacles: TooltipRect[],
  maxDepth: number,
  packing: { columns: number; rows: number; scale: number }
): Array<{ item: ScreenNode; layout: IdeaLayerCardLayout }> {
  const cells = overviewGridCells(bounds, packing.columns, packing.rows);
  const used = new Set<number>();
  return cards.map((item) => {
    const size = overviewLayerCardSize(item.node, maxDepth, packing.scale);
    const best = cells.reduce(
      (current, cell, index) => {
        if (used.has(index)) return current;
        const rect = centerRectInCell(size, cell);
        const glowOverlap = glowObstacles.reduce((total, obstacle) => total + rectOverlapArea(rect, obstacle), 0);
        const collisionPenalty = glowOverlap > 0 ? 1_000_000 + glowOverlap * 120 : 0;
        const score = collisionPenalty + leaderLineLength(item.screen, rect);
        return score < current.score ? { index, rect, score } : current;
      },
      { index: -1, rect: centerRectInCell(size, cells[0] ?? bounds), score: Number.POSITIVE_INFINITY }
    );
    if (best.index >= 0) used.add(best.index);
    return {
      item,
      layout: best.rect
    };
  });
}

function overviewGridCells(bounds: TooltipRect, columns: number, rows: number): TooltipRect[] {
  const cells: TooltipRect[] = [];
  const width = bounds.width / columns;
  const height = bounds.height / rows;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      cells.push({
        left: bounds.left + column * width,
        top: bounds.top + row * height,
        width,
        height
      });
    }
  }
  return cells;
}

function centerRectInCell(size: { width: number; height: number }, cell: TooltipRect): TooltipRect {
  return {
    left: cell.left + (cell.width - size.width) / 2,
    top: cell.top + (cell.height - size.height) / 2,
    width: size.width,
    height: size.height
  };
}

function hasOverviewLayoutCollision(layouts: IdeaLayerCardLayout[], glowObstacles: TooltipRect[]): boolean {
  for (let index = 0; index < layouts.length; index += 1) {
    for (let next = index + 1; next < layouts.length; next += 1) {
      if (rectOverlapArea(layouts[index]!, layouts[next]!) > 1) return true;
    }
    if (glowObstacles.some((obstacle) => rectOverlapArea(layouts[index]!, obstacle) > 1)) return true;
  }
  return false;
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
  return Math.min(320, Math.max(180, viewportWidth - 40));
}

function estimateTooltipHeight(node: AyaNode): number {
  const titleLines = Math.min(3, Math.max(1, Math.ceil(node.shortLabel.length / 22)));
  const bodyLines = Math.min(7, Math.max(1, Math.ceil(node.label.length / 34)));
  return 36 + titleLines * 20 + bodyLines * 21;
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

function focusMapOnPoints2d(map: MapLibreMap, points: AyaSpatialPoint[]): void {
  const finitePoints = points.filter(isFiniteSpatialPoint);
  if (finitePoints.length === 0) return;

  if (finitePoints.length === 1) {
    const point = finitePoints[0]!;
    map.easeTo({
      center: [point.lng, point.lat],
      zoom: 15,
      pitch: 0,
      bearing: 0,
      duration: 620
    });
    return;
  }

  const first = finitePoints[0]!;
  const bounds = new maplibregl.LngLatBounds([first.lng, first.lat], [first.lng, first.lat]);
  for (const point of finitePoints.slice(1)) {
    bounds.extend([point.lng, point.lat]);
  }

  map.fitBounds(bounds, {
    padding: overviewPaddingForContainer(map.getContainer()),
    maxZoom: 15.4,
    duration: 680,
    pitch: 0,
    bearing: 0
  });
}

function disableOverviewMapZoom(map: MapLibreMap): void {
  map.scrollZoom.disable();
  map.boxZoom.disable();
  map.doubleClickZoom.disable();
  map.keyboard.disable();
  map.touchZoomRotate.disable();
}

function enableOverviewMapZoom(map: MapLibreMap): void {
  map.scrollZoom.enable();
  map.boxZoom.enable();
  map.doubleClickZoom.enable();
  map.keyboard.enable();
  map.touchZoomRotate.enable();
  map.touchZoomRotate.enableRotation();
}

function overviewPaddingForContainer(container: HTMLElement): { top: number; right: number; bottom: number; left: number } {
  const narrow = container.clientWidth <= 760;
  return narrow
    ? { top: 230, right: 34, bottom: 150, left: 34 }
    : { top: 130, right: 128, bottom: 130, left: 430 };
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
  const base = isOverview ? 3.5 : 4.5;
  const span = isOverview ? 9 : 7;
  return Math.round((base + span * proximity) * 10) / 10;
}

function isGroupOutlineVisibleAtZoom(node: AyaNode, zoom: number): boolean {
  if (zoom < 11) return node.type === "group" && node.depth === 0;
  if (zoom < 13.5) return node.type === "group" && node.depth <= 2;
  if (zoom < 15.2) return node.type === "group" || node.depth <= 2;
  return true;
}

function visualPointForNode(node: AyaNode, blend: number): AyaSpatialPoint {
  return interpolatePoint(node.semantic, node.geo, blend);
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

function manualGeoStorageKey(center: GeoCenter, fileName: string, rawExport: HypoWeaveExport): string {
  const centerKey = `${center.lng.toFixed(6)},${center.lat.toFixed(6)}`;
  const ids = (rawExport.snapshot?.nodes ?? []).map((node) => node.id).sort().join("|");
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
