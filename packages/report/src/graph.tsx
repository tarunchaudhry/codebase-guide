import { useEffect, useMemo, useState } from 'react';
import { Background, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import ELK, { type ElkNode } from 'elkjs/lib/elk-api.js';
import workerSrc from 'elkjs/lib/elk-worker.min.js?raw';
import type { Family } from './data.ts';

// ---- ELK: one inlined copy, run in a Web Worker (blob URL) when the browser allows it, else on the main thread ----
type ElkApi = InstanceType<typeof ELK>;
let elkPromise: Promise<ElkApi> | undefined;
function inThread(): ElkApi {
  const mod: { exports: { Worker?: new () => Worker } } = { exports: {} };
  new Function('module', 'exports', workerSrc)(mod, mod.exports);
  return new ELK({ workerFactory: () => new mod.exports.Worker!() });
}
function getElk(): Promise<ElkApi> {
  elkPromise ??= (async () => {
    try {
      const url = URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' }));
      const elk = new ELK({ workerFactory: () => new Worker(url) });
      // Probe once: file:// or CSP can block blob workers; fall back to the main thread then.
      await Promise.race([elk.layout({ id: 'probe', children: [{ id: 'a', width: 1, height: 1 }], edges: [] }), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]);
      return elk;
    } catch {
      return inThread();
    }
  })();
  return elkPromise;
}

export type GNode = { id: string; label: string; sub?: string; family: Family; inferred?: boolean; runtime?: string; cluster?: boolean; active?: boolean; dim?: boolean; focus?: boolean; width?: number; height?: number; dir?: 'RIGHT' | 'DOWN' };
export interface GEdge { id: string; source: string; target: string; kind: string; label?: string; inferred?: boolean; active?: boolean; weight?: number; confidence?: string }

const layoutCache = new Map<string, Record<string, { x: number; y: number }>>();

export async function layoutGraph(nodes: GNode[], edges: GEdge[], direction: 'RIGHT' | 'DOWN' = 'RIGHT'): Promise<Record<string, { x: number; y: number }>> {
  const key = `${direction}|${nodes.map((n) => n.id).sort().join(',')}|${edges.map((e) => `${e.source}>${e.target}`).sort().join(',')}`;
  const hit = layoutCache.get(key);
  if (hit) return hit;
  const elk = await getElk();
  const ids = new Set(nodes.map((n) => n.id));
  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered', 'elk.direction': direction, 'elk.spacing.nodeNode': '28', 'elk.layered.spacing.nodeNodeBetweenLayers': '64',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF', 'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP', 'elk.separateConnectedComponents': 'true',
      'elk.spacing.componentComponent': '48',
    },
    children: nodes.map((n) => ({ id: n.id, width: n.width ?? 220, height: n.height ?? (n.sub ? 50 : 34) })),
    edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target).map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };
  const res = await elk.layout(graph);
  const pos: Record<string, { x: number; y: number }> = {};
  for (const c of res.children ?? []) pos[c.id] = { x: c.x ?? 0, y: c.y ?? 0 };
  layoutCache.set(key, pos);
  return pos;
}

function GraphNodeView({ data }: NodeProps<Node<GNode>>) {
  const cls = ['gn', `fam-${data.family}`, data.cluster && 'cluster', data.inferred && 'inferred', data.runtime && `runtime-${data.runtime}`, data.active && 'active', data.dim && 'dim', data.focus && 'focus'].filter(Boolean).join(' ');
  const down = data.dir === 'DOWN';
  return (
    <div className={cls} title={data.inferred ? 'inferred: not proven statically' : data.label}>
      <Handle type="target" position={down ? Position.Top : Position.Left} isConnectable={false} style={{ opacity: 0 }} />
      <Handle type="source" position={down ? Position.Bottom : Position.Right} isConnectable={false} style={{ opacity: 0 }} />
      <div className="t">{data.cluster ? '▸ ' : ''}{data.label}</div>
      {data.sub ? <div className="s">{data.sub}</div> : null}
    </div>
  );
}
const nodeTypes = { g: GraphNodeView };

const EDGE_COLOR: Record<string, string> = { http: 'var(--accent)', 'middleware-chain': 'var(--f-middleware)', 'reads-model': 'var(--f-model)', 'writes-model': 'var(--f-model)', injects: 'var(--f-service)', handles: 'var(--f-endpoint)', renders: 'var(--f-ui)' };

function Inner({ nodes, edges, direction, onNodeClick, height, fitKey, minimap }: GraphProps) {
  const [pos, setPos] = useState<Record<string, { x: number; y: number }> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const rf = useReactFlow();
  const structKey = useMemo(() => `${nodes.map((n) => n.id).join(',')}|${edges.map((e) => e.id).join(',')}`, [nodes, edges]);
  useEffect(() => {
    let live = true;
    setErr(null);
    layoutGraph(nodes, edges, direction).then((p) => { if (live) setPos(p); }, (e: unknown) => { if (live) setErr(String(e)); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structKey, direction]);
  // Re-fit when asked (e.g. the active flow step changes); the first fit happens on mount, after layout.
  useEffect(() => { if (pos && fitKey) rf.fitView({ padding: 0.12, maxZoom: 1.1, duration: 200 }); }, [fitKey, rf, pos]);
  const rfNodes: Node<GNode>[] = useMemo(() => nodes.map((n) => ({ id: n.id, type: 'g', position: pos?.[n.id] ?? { x: 0, y: 0 }, data: { ...n, dir: direction ?? 'RIGHT' }, draggable: true, connectable: false, ariaLabel: n.label })), [nodes, pos]);
  const rfEdges: Edge[] = useMemo(() => edges.map((e) => {
    const color = e.active ? 'var(--accent)' : EDGE_COLOR[e.kind] ?? 'var(--rule-2)';
    return {
      id: e.id, source: e.source, target: e.target, animated: !!e.active,
      ...(e.label ? { label: e.label, labelStyle: { fontFamily: 'var(--mono)', fontSize: 10, fill: 'var(--muted)' }, labelBgStyle: { fill: 'var(--card)' } } : {}),
      style: { stroke: color, strokeWidth: e.active ? 2.6 : Math.min(1 + Math.log2(1 + (e.weight ?? 1)) * 0.6, 3.5), ...(e.inferred ? { strokeDasharray: '6 4' } : {}), opacity: e.confidence === 'low' ? 0.5 : 1 },
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
    };
  }), [edges]);
  if (err) return <p className="note">Layout failed: {err}</p>;
  return (
    <div style={{ height, width: '100%', position: 'relative' }}>
      {!pos ? <p className="note" style={{ position: 'absolute', top: 10, left: 14 }}>Laying out {nodes.length} nodes…</p> : (
      // Mount only once positions exist (keyed by structure) so xyflow's own initial fitView sees the real layout.
      <ReactFlow key={structKey} fitViewOptions={{ padding: 0.12, maxZoom: 1.1 }} nodes={rfNodes} edges={rfEdges} nodeTypes={nodeTypes} minZoom={0.05} maxZoom={2.5} fitView proOptions={{ hideAttribution: true }}
        onNodeClick={(_, n) => onNodeClick?.(n.id)} nodesConnectable={false} elementsSelectable onlyRenderVisibleElements={nodes.length > 200}>
        <Background gap={28} size={1} color="var(--rule)" />
        <Controls showInteractive={false} />
        {minimap ? <MiniMap pannable zoomable nodeColor={(n) => `var(--f-${(n.data as unknown as GNode).family})`} maskColor="color-mix(in srgb, var(--paper) 70%, transparent)" style={{ background: 'var(--card)', border: '1px solid var(--rule)' }} /> : null}
      </ReactFlow>)}
    </div>
  );
}

export interface GraphProps { nodes: GNode[]; edges: GEdge[]; direction?: 'RIGHT' | 'DOWN'; onNodeClick?: (id: string) => void; height: number | string; fitKey?: string; minimap?: boolean }
export function GraphView(p: GraphProps) {
  return <ReactFlowProvider><Inner {...p} /></ReactFlowProvider>;
}
