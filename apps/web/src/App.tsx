import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { type Map as MapLibreMap, type PointLike } from "maplibre-gl";
import {
  Blend,
  CircleHelp,
  Eye,
  FileJson,
  Map as MapIcon,
  Share2,
  Sparkles,
  Upload
} from "lucide-react";
import {
  connectedIds,
  DEFAULT_CENTER,
  interpolatePoint,
  normalizeHypoWeave,
  parseManualCenter,
  toPlacementInputs
} from "@ayatopos/shared";
import type { AyaGraph, AyaGroupOutline, AyaNode, AyaSpatialPoint, HypoWeaveExport } from "@ayatopos/shared";
import { requestPlacements, resolveArea } from "./api";
import { mapStyle } from "./mapStyle";

type LoadState = "idle" | "loading" | "ready" | "error";

interface ScreenNode {
  node: AyaNode;
  point: AyaSpatialPoint;
  screen: { x: number; y: number };
  related: boolean;
  dimmed: boolean;
}

interface ScreenGeoPoint {
  node: AyaNode;
  screen: { x: number; y: number };
  related: boolean;
  dimmed: boolean;
}

export function App() {
  const [rawExport, setRawExport] = useState<HypoWeaveExport | null>(null);
  const [fileName, setFileName] = useState("");
  const [areaText, setAreaText] = useState("");
  const [graph, setGraph] = useState<AyaGraph | null>(null);
  const [blend, setBlend] = useState(0.28);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [status, setStatus] = useState<LoadState>("idle");
  const [message, setMessage] = useState("JSONと中心エリアを指定してください。");

  const handleFile = useCallback(async (file: File) => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as HypoWeaveExport;
      if (!parsed.snapshot?.nodes?.length) throw new Error("snapshot.nodes が見つかりません。");
      setRawExport(parsed);
      setFileName(file.name);
      setGraph(null);
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
      setGraph(semanticGraph);
      setBlend(0.18);
      setMessage("地理配置を推定しています。");

      const response = await requestPlacements({
        areaText: areaText.trim(),
        center,
        nodes: toPlacementInputs(semanticGraph)
      });
      const nextGraph = normalizeHypoWeave(rawExport, {
        center,
        placements: response.placements
      });
      setGraph(nextGraph);
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
      setGraph(fallbackGraph);
      setStatus("error");
      setMessage(error instanceof Error ? `${error.message} フォールバック表示に切り替えました。` : "フォールバック表示に切り替えました。");
    }
  }, [areaText, rawExport]);

  return (
    <main className="app-shell" style={{ "--blend": blend } as React.CSSProperties}>
      <MapScene graph={graph} blend={blend} hoveredId={hoveredId} onHover={setHoveredId} />

      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <Sparkles size={27} strokeWidth={1.8} />
          </div>
          <span>AyaTopos</span>
        </div>
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
        </div>
      </header>

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

function MapScene({
  graph,
  blend,
  hoveredId,
  onHover
}: {
  graph: AyaGraph | null;
  blend: number;
  hoveredId: string | null;
  onHover: (nodeId: string | null) => void;
}) {
  const mapNodeRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!mapNodeRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapNodeRef.current,
      style: mapStyle(),
      center: [DEFAULT_CENTER.lng, DEFAULT_CENTER.lat],
      zoom: 14.2,
      pitch: 42,
      bearing: -18,
      attributionControl: false
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    mapRef.current = map;

    const rerender = () => setTick((value) => value + 1);
    map.on("move", rerender);
    map.on("zoom", rerender);
    map.on("pitch", rerender);
    map.on("rotate", rerender);
    map.on("load", rerender);

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!graph || !mapRef.current) return;
    mapRef.current.easeTo({
      center: [graph.center.lng, graph.center.lat],
      zoom: 14.2,
      pitch: 42,
      bearing: -16,
      duration: 900
    });
  }, [graph?.center.lat, graph?.center.lng, graph]);

  const zoom = mapRef.current?.getZoom() ?? 0;
  const relatedIds = useMemo(
    () => (graph && hoveredId ? connectedIds(graph.edges, hoveredId) : new Set<string>()),
    [graph, hoveredId]
  );

  const screenNodes = useMemo(() => {
    if (!graph || !mapRef.current) return [];

    return graph.nodes.map((node) => {
      const point = interpolatePoint(node.semantic, node.geo, blend);
      const projected = mapRef.current!.project([point.lng, point.lat]) as PointLike & { x: number; y: number };
      const raisedY = projected.y - point.altitude * 0.18;
      return {
        node,
        point,
        screen: { x: projected.x, y: raisedY },
        related: hoveredId ? relatedIds.has(node.id) : true,
        dimmed: hoveredId ? !relatedIds.has(node.id) : false
      } satisfies ScreenNode;
    });
  }, [blend, graph, hoveredId, relatedIds, tick]);

  const visibleScreenNodes = useMemo(
    () =>
      screenNodes
        .filter(({ node }) => isLabelVisibleAtZoom(node, zoom))
        .sort((a, b) => renderRank(a.node, graph?.maxDepth ?? 0) - renderRank(b.node, graph?.maxDepth ?? 0)),
    [graph?.maxDepth, screenNodes, zoom]
  );

  const visibleNodeIds = useMemo(() => new Set(visibleScreenNodes.map(({ node }) => node.id)), [visibleScreenNodes]);

  const geoPointNodes = useMemo(() => {
    if (!graph || !mapRef.current) return [];
    return graph.nodes
      .filter((node) => node.type === "card")
      .sort((a, b) => renderRank(a, graph.maxDepth) - renderRank(b, graph.maxDepth))
      .map((node) => {
        const projected = mapRef.current!.project([node.geo.lng, node.geo.lat]) as PointLike & { x: number; y: number };
        return {
          node,
          screen: { x: projected.x, y: projected.y },
          related: hoveredId ? relatedIds.has(node.id) : true,
          dimmed: hoveredId ? !relatedIds.has(node.id) : false
        } satisfies ScreenGeoPoint;
      });
  }, [graph, hoveredId, relatedIds, tick]);

  const screenOutlines = useMemo(() => {
    if (!graph || !mapRef.current) return [];
    return graph.outlines
      .filter((outline) => visibleNodeIds.has(outline.groupId))
      .map((outline) => ({
        outline,
        path: outlinePath(outline, mapRef.current!)
      }))
      .filter((item) => item.path.length > 0);
  }, [graph, tick, visibleNodeIds]);

  const nodeById = useMemo(() => new Map(visibleScreenNodes.map((item) => [item.node.id, item])), [visibleScreenNodes]);
  const hoveredNode = hoveredId ? nodeById.get(hoveredId) : undefined;

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
        {graph?.edges.map((edge) => {
          const source = nodeById.get(edge.source);
          const target = nodeById.get(edge.target);
          if (!source || !target) return null;
          const active = hoveredId ? edge.source === hoveredId || edge.target === hoveredId : false;
          const mx = (source.screen.x + target.screen.x) / 2;
          const my = (source.screen.y + target.screen.y) / 2 - Math.min(120, Math.abs(source.screen.x - target.screen.x) * 0.18);
          return (
            <path
              key={edge.id}
              className={`thread ${active ? "active" : hoveredId ? "muted" : ""}`}
              d={`M ${source.screen.x} ${source.screen.y} Q ${mx} ${my} ${target.screen.x} ${target.screen.y}`}
            />
          );
        })}
      </svg>
      <div className="geo-point-layer" aria-hidden="true">
        {geoPointNodes.map(({ node, screen, dimmed, related }) => (
          <span
            key={`${node.id}:geo-point`}
            className={`geo-point-glow ${dimmed ? "dimmed" : ""} ${related ? "related" : ""}`}
            style={
              {
                left: screen.x,
                top: screen.y,
                zIndex: renderRank(node, graph?.maxDepth ?? 0),
                "--node-color": node.color,
                "--geo-glow-opacity": Math.max(0.08, 0.12 + blend * 0.78)
              } as React.CSSProperties
            }
          />
        ))}
      </div>
      <div className="node-layer">
        {visibleScreenNodes.map(({ node, screen, dimmed, related }) => (
          <button
            key={node.id}
            className={`node-card ${node.type} depth-${Math.min(node.depth, 6)} ${dimmed ? "dimmed" : ""} ${
              hoveredId === node.id ? "hovered" : ""
            } ${related ? "related" : ""}`}
            style={
              {
                left: screen.x,
                top: screen.y,
                zIndex: renderRank(node, graph?.maxDepth ?? 0),
                "--node-color": node.color,
                "--node-size": `${node.size}px`,
                "--node-opacity": node.opacity
              } as React.CSSProperties
            }
            onPointerEnter={() => onHover(node.id)}
            onPointerLeave={() => onHover(null)}
            type="button"
          >
            <span>{node.shortLabel}</span>
          </button>
        ))}
      </div>
      {hoveredNode ? (
        <aside
          className="node-tooltip"
          style={{
            left: Math.min(window.innerWidth - 340, Math.max(20, hoveredNode.screen.x + 22)),
            top: Math.min(window.innerHeight - 180, Math.max(90, hoveredNode.screen.y + 18))
          }}
        >
          <strong>{hoveredNode.node.shortLabel}</strong>
          <p>{hoveredNode.node.label}</p>
        </aside>
      ) : null}
    </div>
  );
}

function isLabelVisibleAtZoom(node: AyaNode, zoom: number): boolean {
  if (zoom < 13) return node.type === "group" && node.depth === 0;
  if (zoom < 14.5) return node.type === "group" && node.depth <= 2;
  if (zoom < 15.8) return node.type === "group" || node.depth <= 2;
  return true;
}

function renderRank(node: AyaNode, maxDepth: number): number {
  const rootProximity = Math.max(0, maxDepth - node.depth + 1);
  const typeOffset = node.type === "card" ? 80 : 20;
  return typeOffset + rootProximity;
}

function outlinePath(outline: AyaGroupOutline, map: MapLibreMap): string {
  const points = outline.points.map((point) => map.project([point.lng, point.lat]) as PointLike & { x: number; y: number });
  if (points.length < 3) return "";
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ") + " Z";
}
