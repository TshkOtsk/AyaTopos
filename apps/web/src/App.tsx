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
import { addIdeaObjectLayer, nodeElevationMeters, type IdeaLayerDatum, type IdeaObjectLayer } from "./ideaLayer";
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
  const mapRef = useRef<MapLibreMap | null>(null);
  const ideaLayerRef = useRef<IdeaObjectLayer | null>(null);
  const frameRef = useRef<number | null>(null);
  const hoverClearRef = useRef<number | null>(null);
  const draggingCardIdRef = useRef<string | null>(null);
  const editViewRef = useRef<{ pitch: number; bearing: number } | null>(null);
  const [tick, setTick] = useState(0);

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
      map.remove();
      mapRef.current = null;
      ideaLayerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!graph || !mapRef.current) return;
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
  const visualThreads = useMemo(() => (graph ? createVisualThreads(graph) : []), [graph]);
  const activeVisualThreads = useMemo(
    () =>
      hoveredId && !isGeoEditing
        ? visualThreads.filter((edge) => edge.source === hoveredId || edge.target === hoveredId)
        : [],
    [hoveredId, isGeoEditing, visualThreads]
  );
  const relatedIds = useMemo(
    () => (graph && hoveredId ? connectedVisualIds(visualThreads, hoveredId) : new Set<string>()),
    [graph, hoveredId, visualThreads]
  );

  const screenNodes = useMemo(() => {
    if (!graph || !mapRef.current) return [];

    return graph.nodes.map((node) => {
      const point = visualPointForNode(node, blend);
      const projected = projectNodeGlowToScreen(mapRef.current!, node, point);
      const isRelated = hoveredId ? relatedIds.has(node.id) : true;
      return {
        node,
        point,
        screen: projected,
        related: isRelated,
        dimmed: hoveredId ? !isRelated : false
      } satisfies ScreenNode;
    });
  }, [blend, graph, hoveredId, relatedIds, tick]);

  const visibleOutlineNodeIds = useMemo(
    () =>
      new Set(
        screenNodes
          .filter(({ node }) => node.type === "group" && isGroupOutlineVisibleAtZoom(node, zoom))
          .map(({ node }) => node.id)
      ),
    [graph?.maxDepth, screenNodes, zoom]
  );

  const ideaNodes = useMemo<IdeaLayerDatum[]>(
    () =>
      screenNodes.map(({ node, point, related, dimmed }) => ({
        node,
        point,
        related,
        dimmed
      })),
    [screenNodes]
  );

  const nodeHitTargets = useMemo(
    () =>
      [...screenNodes]
        .sort((a, b) => renderRank(a.node, graph?.maxDepth ?? 0) - renderRank(b.node, graph?.maxDepth ?? 0)),
    [graph?.maxDepth, screenNodes]
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
  const hoveredCards = useMemo(() => {
    if (!hoveredId) return [];
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
  }, [activeVisualThreads, hoveredId, nodeById]);

  useEffect(() => {
    ideaLayerRef.current?.setData(ideaNodes, hoveredId, {
      enabled: isGeoEditing,
      selectedId: selectedCardId
    });
  }, [hoveredId, ideaNodes, isGeoEditing, selectedCardId]);

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

  return (
      <div className="scene">
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
              hoveredId && !relatedIds.has(outline.groupId) ? "muted" : ""
            } ${hoveredId === outline.groupId ? "active" : ""}`}
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
      <svg className="thread-layer" aria-hidden="true">
        {activeVisualThreads.map((edge) => {
          const source = nodeById.get(edge.source);
          const target = nodeById.get(edge.target);
          if (!source || !target) return null;
          const mx = (source.screen.x + target.screen.x) / 2;
          const my = (source.screen.y + target.screen.y) / 2 - Math.min(120, Math.abs(source.screen.x - target.screen.x) * 0.18);
          return (
            <path
              key={edge.id}
              className={`thread ${edge.kind} active`}
              d={`M ${source.screen.x} ${source.screen.y} Q ${mx} ${my} ${target.screen.x} ${target.screen.y}`}
            />
          );
        })}
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
              if (!isGeoEditing || node.type !== "card") return;
              event.preventDefault();
              onSelectCard(node.id);
            }}
            onFocus={() => acceptHover(node.id)}
            onBlur={releaseHover}
            type="button"
            aria-pressed={selectedCardId === node.id}
            aria-label={node.shortLabel}
          />
        ))}
      </div>
      {hoveredCards.map(({ node, screen }) => (
        <aside
          key={`${node.id}:tooltip-card`}
          className={`idea-tooltip ${node.id === hoveredId ? "origin" : "connected"}`}
          onPointerEnter={() => {
            if (hoveredId) acceptHover(hoveredId);
          }}
          onPointerLeave={releaseHover}
          style={
            {
              left: Math.max(20, Math.min(window.innerWidth - 340, screen.x + 22)),
              top: Math.max(90, Math.min(window.innerHeight - 180, screen.y + 18)),
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
