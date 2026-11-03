'use client';

/**
 * MeshSimulation — simulation interactive de propagation de messages dans un
 * réseau maillé « Bluetooth-like » (inspirée du protocole bitchat) pour
 * Mbote Mesh.
 *
 * Deux modes de propagation :
 *  - Inonder (flood contrôlé) : paquets émeraude propagés hop par hop avec
 *    TTL, gigue de retransmission (60–220 ms) et suppression des doublons.
 *  - Courrier (spray-and-wait) : enveloppes ambre dupliquées (budget de
 *    copies) depuis la source (nœud vivant le plus à gauche) vers la
 *    destination (nœud vivant le plus à droite).
 *
 * Rendu HTML5 Canvas 2D (devicePixelRatio + ResizeObserver), état de
 * simulation dans des refs, boucle requestAnimationFrame, horloge virtuelle
 * (la pause fige le temps simulé). Aucune dépendance supplémentaire.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Mail, Pause, Play, Radio, RotateCcw, Signal, Zap } from 'lucide-react';

// ---------------------------------------------------------------------------
// Constantes (palette STRICTE : émeraude, ambre, zinc, rouge hors-ligne)
// ---------------------------------------------------------------------------
const EMERALD = '#10b981';
const EMERALD_LIGHT = '#34d399';
const AMBER = '#f59e0b';
const TAU = Math.PI * 2;

const KNN = 3; // chaque nœud est relié à ses k plus proches voisins
const NODE_MARGIN = 28; // marge de placement des nœuds (px)
const FLOOD_HOP_MS = 450; // durée d'un saut en mode inondation
const JITTER_MIN_MS = 60; // gigue de retransmission — min
const JITTER_MAX_MS = 220; // gigue de retransmission — max
const AUTO_FLOOD_MS = 6000; // cycle automatique si inactif (~6 s)
const FLASH_MS = 550; // durée du flash « reçu » d'un nœud
const PUFF_MS = 460; // petite disparition d'un paquet mort
const PULSE_MS = 1300; // anneau de livraison
const COURIER_BUDGET = 4; // budget de copies initial de l'enveloppe
const COURIER_MAX_ACTIVE = 4; // enveloppes simultanées max
const COURIER_MAX_COPIES = 8; // plafond total de copies (affichage « n/8 »)
const SPLIT_CHANCE = 0.45; // chance de division à chaque relais
const HUD_INTERVAL_MS = 200; // rafraîchissement du HUD React

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type NodeKind = 'normal' | 'gateway' | 'dead';

interface MeshNode {
  id: number;
  nx: number; // position normalisée (0..1)
  ny: number;
  x: number; // position écran (px, recalculée au redimensionnement)
  y: number;
  kind: NodeKind;
  neighbors: number[];
  visited: boolean; // a reçu le paquet d'inondation courant
  hop: number; // profondeur de réception (sauts depuis l'origine)
  flashUntil: number; // flash émeraude (horloge simulée)
  courierGlowUntil: number; // halo ambre au passage d'une enveloppe
  srcGlow: boolean; // marqueur « Départ » (courrier)
  destGlow: boolean; // marqueur « Arrivée » (courrier)
}

interface Edge {
  a: number;
  b: number;
}

/** Paquet d'inondation en vol sur une arête. */
interface Transit {
  from: number;
  to: number;
  departAt: number;
  arriveAt: number;
  ttl: number;
  hop: number;
}

/** Retransmission programmée (gigue appliquée avant diffusion). */
interface Relay {
  node: number;
  from: number; // début de la fenêtre de gigue (pour l'arc de progression)
  departAt: number;
  ttl: number;
}

/** Enveloppe « spray-and-wait » en vol sur une arête. */
interface Envelope {
  from: number;
  to: number;
  departAt: number;
  arriveAt: number;
  ttl: number;
  hop: number;
  budget: number; // copies restantes transportées
  prev: number; // nœud quitté (anti rebond immédiat)
}

interface Puff {
  x: number;
  y: number;
  at: number;
  tone: 'flood' | 'courier';
}

interface Pulse {
  x: number;
  y: number;
  at: number;
}

interface FloodState {
  reached: number;
  nonDead: number;
  maxHops: number;
  lastTrigger: number;
}

interface CourierState {
  active: boolean;
  src: number;
  dest: number;
  copies: number; // copies émises (duplications)
  delivered: boolean;
  lost: boolean;
  winHops: number; // sauts de la copie gagnante
  startedAt: number;
  note: string;
  noteUntil: number;
}

interface SimState {
  seed: number;
  w: number;
  h: number;
  time: number; // horloge simulée (figée en pause)
  nodes: MeshNode[];
  edges: Edge[];
  edgeIndex: Map<number, number>;
  edgeFlood: Float32Array; // activité émeraude décroissante par arête
  edgeCourier: Float32Array; // activité ambre décroissante par arête
  transits: Transit[];
  relays: Relay[];
  envelopes: Envelope[];
  puffs: Puff[];
  pulses: Pulse[];
  flood: FloodState;
  courier: CourierState;
  lastHudAt: number;
}

interface Hud {
  nodes: number;
  links: number;
  reachedPct: number;
  maxHops: number;
  packets: number;
  courierActive: boolean;
  hasRun: boolean;
  copies: number;
  delivered: boolean;
  lost: boolean;
  note: string;
  noteVisible: boolean;
}

export interface MeshSimulationProps {
  className?: string;
}

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------
function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/** PRNG déterministe (mulberry32) — disposition reproductible par graine. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function edgeKey(a: number, b: number): number {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return lo * 1000 + hi;
}

function jitterMs(): number {
  return JITTER_MIN_MS + Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------
// Construction du graphe (graine déterministe)
// ---------------------------------------------------------------------------
function buildGraph(
  seed: number,
  count: number,
  aspect: number
): { nodes: MeshNode[]; edges: Edge[] } {
  const rng = mulberry32(seed);
  const nodes: MeshNode[] = [];

  // Placement aléatoire avec écartement minimal (espace corrigé du ratio).
  const minD2 = 0.085 * 0.085;
  const dist2 = (ax: number, ay: number, bx: number, by: number): number => {
    const dx = (ax - bx) * aspect;
    const dy = ay - by;
    return dx * dx + dy * dy;
  };

  for (let i = 0; i < count; i++) {
    let nx = 0.5;
    let ny = 0.5;
    for (let tries = 0; tries < 60; tries++) {
      const cx0 = 0.04 + rng() * 0.92;
      const cy0 = 0.06 + rng() * 0.88;
      nx = cx0;
      ny = cy0;
      let ok = true;
      for (const n of nodes) {
        if (dist2(cx0, cy0, n.nx, n.ny) < minD2) {
          ok = false;
          break;
        }
      }
      if (ok) break;
    }
    nodes.push({
      id: i,
      nx,
      ny,
      x: 0,
      y: 0,
      kind: 'normal',
      neighbors: [],
      visited: false,
      hop: 0,
      flashUntil: 0,
      courierGlowUntil: 0,
      srcGlow: false,
      destGlow: false,
    });
  }

  // Rôles : ~8 % passerelles (anneau ambre), ~5 % hors ligne (rouge, muets).
  const order = nodes.map((n) => n.id);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = order[i];
    order[i] = order[j];
    order[j] = tmp;
  }
  const gwCount = Math.max(1, Math.round(count * 0.08));
  const deadCount = Math.max(1, Math.round(count * 0.05));
  for (let rank = 0; rank < order.length; rank++) {
    const id = order[rank];
    if (rank < gwCount) nodes[id].kind = 'gateway';
    else if (rank < gwCount + deadCount) nodes[id].kind = 'dead';
  }

  // Arêtes non orientées : k plus proches voisins, dédupliquées.
  const edges: Edge[] = [];
  const seen = new Set<number>();
  const addEdge = (a: number, b: number): void => {
    if (a === b) return;
    const key = edgeKey(a, b);
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ a: Math.min(a, b), b: Math.max(a, b) });
    nodes[a].neighbors.push(b);
    nodes[b].neighbors.push(a);
  };

  for (const n of nodes) {
    const cand: number[] = [];
    for (const m of nodes) {
      if (m.id !== n.id) cand.push(m.id);
    }
    cand.sort(
      (a, b) =>
        dist2(n.nx, n.ny, nodes[a].nx, nodes[a].ny) -
        dist2(n.nx, n.ny, nodes[b].nx, nodes[b].ny)
    );
    const k = Math.min(KNN, cand.length);
    for (let idx = 0; idx < k; idx++) addEdge(n.id, cand[idx]);
  }

  // Sécurité : aucun nœud isolé (relié au plus proche voisin).
  for (const n of nodes) {
    if (n.neighbors.length > 0) continue;
    let best = -1;
    let bestD = Infinity;
    for (const m of nodes) {
      if (m.id === n.id) continue;
      const d = dist2(n.nx, n.ny, m.nx, m.ny);
      if (d < bestD) {
        bestD = d;
        best = m.id;
      }
    }
    if (best >= 0) addEdge(n.id, best);
  }

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// État de simulation
// ---------------------------------------------------------------------------
function placeNodes(sim: SimState): void {
  const iw = Math.max(10, sim.w - NODE_MARGIN * 2);
  const ih = Math.max(10, sim.h - NODE_MARGIN * 2);
  for (const n of sim.nodes) {
    n.x = NODE_MARGIN + n.nx * iw;
    n.y = NODE_MARGIN + n.ny * ih;
  }
}

function rebuildSim(sim: SimState, count: number, seed: number): void {
  const aspect = sim.h > 0 ? sim.w / sim.h : 2;
  const g = buildGraph(seed, count, aspect);
  sim.seed = seed;
  sim.nodes = g.nodes;
  sim.edges = g.edges;
  sim.edgeIndex = new Map<number, number>();
  for (let i = 0; i < g.edges.length; i++) {
    sim.edgeIndex.set(edgeKey(g.edges[i].a, g.edges[i].b), i);
  }
  sim.edgeFlood = new Float32Array(g.edges.length);
  sim.edgeCourier = new Float32Array(g.edges.length);
  sim.transits = [];
  sim.relays = [];
  sim.envelopes = [];
  sim.puffs = [];
  sim.pulses = [];

  let nonDead = 0;
  for (const n of g.nodes) if (n.kind !== 'dead') nonDead++;
  sim.flood = {
    reached: 0,
    nonDead,
    maxHops: 0,
    // première inondation automatique ~0,9 s après (re)construction
    lastTrigger: sim.time - (AUTO_FLOOD_MS - 900),
  };
  sim.courier = {
    active: false,
    src: -1,
    dest: -1,
    copies: 0,
    delivered: false,
    lost: false,
    winHops: 0,
    startedAt: 0,
    note: '',
    noteUntil: 0,
  };
  placeNodes(sim);
}

// ---------------------------------------------------------------------------
// Mode A — Inondation (flood contrôlé avec TTL)
// ---------------------------------------------------------------------------
function pickRandomAlive(sim: SimState): number {
  const alive: number[] = [];
  for (const n of sim.nodes) if (n.kind !== 'dead') alive.push(n.id);
  if (alive.length === 0) return -1;
  return alive[Math.floor(Math.random() * alive.length)];
}

function triggerFlood(sim: SimState, ttl: number): void {
  sim.transits.length = 0;
  sim.relays.length = 0;
  for (const n of sim.nodes) {
    n.visited = false;
    n.hop = 0;
    n.flashUntil = 0;
  }
  sim.flood.lastTrigger = sim.time;

  const origin = pickRandomAlive(sim);
  if (origin < 0) return;
  const o = sim.nodes[origin];
  o.visited = true;
  o.hop = 0;
  o.flashUntil = sim.time + FLASH_MS;
  sim.flood.reached = 1;
  sim.flood.maxHops = 0;

  for (const nb of o.neighbors) {
    const target = sim.nodes[nb];
    if (target.kind === 'dead') continue; // les nœuds morts ne relaient pas
    const ei = sim.edgeIndex.get(edgeKey(origin, nb));
    if (ei === undefined) continue;
    const j = jitterMs();
    sim.transits.push({
      from: origin,
      to: nb,
      departAt: sim.time + j,
      arriveAt: sim.time + j + FLOOD_HOP_MS,
      ttl,
      hop: 1,
    });
    sim.edgeFlood[ei] = 1;
  }
}

function onFloodArrive(sim: SimState, p: Transit): void {
  const t = sim.time;
  const node = sim.nodes[p.to];

  // Nœud hors ligne : le paquet meurt, petite disparition.
  if (node.kind === 'dead') {
    sim.puffs.push({ x: node.x, y: node.y, at: t, tone: 'flood' });
    return;
  }

  const first = !node.visited;
  if (first) {
    node.visited = true;
    node.hop = p.hop;
    node.flashUntil = t + FLASH_MS;
    sim.flood.reached += 1;
    if (p.hop > sim.flood.maxHops) sim.flood.maxHops = p.hop;
  }

  const ttl = p.ttl - 1; // chaque saut décrémente le TTL
  if (ttl <= 0) {
    // TTL épuisé : le paquet meurt avec un petit fondu.
    sim.puffs.push({ x: node.x, y: node.y, at: t, tone: 'flood' });
    return;
  }
  if (!first) {
    // Doublon absorbé (suppression des doublons du flood).
    sim.puffs.push({ x: node.x, y: node.y, at: t, tone: 'flood' });
    return;
  }

  // Le nœud retransmet après une gigue aléatoire (visualisée par un arc).
  sim.relays.push({ node: node.id, from: t, departAt: t + jitterMs(), ttl });
}

function departRelay(sim: SimState, r: Relay): void {
  const node = sim.nodes[r.node];
  if (node.kind === 'dead') return;
  for (const nb of node.neighbors) {
    const target = sim.nodes[nb];
    if (target.kind === 'dead' || target.visited) continue;
    const ei = sim.edgeIndex.get(edgeKey(node.id, nb));
    if (ei === undefined) continue;
    sim.transits.push({
      from: node.id,
      to: nb,
      departAt: r.departAt,
      arriveAt: r.departAt + FLOOD_HOP_MS,
      ttl: r.ttl,
      hop: node.hop + 1,
    });
    sim.edgeFlood[ei] = 1;
  }
}

// ---------------------------------------------------------------------------
// Mode B — Courrier (spray-and-wait simplifié)
// ---------------------------------------------------------------------------
function travelMs(sim: SimState, a: number, b: number): number {
  const na = sim.nodes[a];
  const nb = sim.nodes[b];
  const dx = nb.x - na.x;
  const dy = nb.y - na.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  return clamp(Math.round(d / 0.3), 380, 950);
}

function pickNextHop(
  sim: SimState,
  atId: number,
  excludeId: number,
  avoidId: number
): number {
  const dest = sim.courier.dest >= 0 ? sim.nodes[sim.courier.dest] : null;
  if (!dest) return -1;
  const node = sim.nodes[atId];
  const d2 = (id: number): number => {
    const n = sim.nodes[id];
    const dx = n.x - dest.x;
    const dy = n.y - dest.y;
    return dx * dx + dy * dy;
  };

  const candidates: number[] = [];
  for (const nb of node.neighbors) {
    const n = sim.nodes[nb];
    if (n.kind === 'dead') continue;
    if (excludeId >= 0 && nb === excludeId) continue;
    if (avoidId >= 0 && nb === avoidId) continue;
    candidates.push(nb);
  }
  if (candidates.length === 0) {
    // Détente : autoriser le retour arrière (le TTL borne la boucle).
    for (const nb of node.neighbors) {
      const n = sim.nodes[nb];
      if (n.kind === 'dead') continue;
      if (avoidId >= 0 && nb === avoidId) continue;
      candidates.push(nb);
    }
  }
  if (candidates.length === 0) return -1;

  candidates.sort((a, b) => d2(a) - d2(b));
  // 15 % de chance de tenter le second meilleur (exploration d'itinéraires).
  const pick = candidates.length > 1 && Math.random() < 0.15 ? 1 : 0;
  return candidates[pick];
}

function spawnEnvelopeOn(
  sim: SimState,
  fromId: number,
  nextId: number,
  ttl: number,
  hop: number,
  budget: number,
  departAt: number
): Envelope | null {
  const ei = sim.edgeIndex.get(edgeKey(fromId, nextId));
  if (ei === undefined) return null;
  const env: Envelope = {
    from: fromId,
    to: nextId,
    departAt,
    arriveAt: departAt + travelMs(sim, fromId, nextId),
    ttl,
    hop: hop + 1,
    budget,
    prev: fromId,
  };
  sim.envelopes.push(env);
  sim.edgeCourier[ei] = 1;
  return env;
}

function maybeSplit(
  sim: SimState,
  env: Envelope,
  nodeId: number,
  parentNext: number
): void {
  if (Math.random() > SPLIT_CHANCE) return;
  if (env.budget < 2) return;
  if (sim.envelopes.length >= COURIER_MAX_ACTIVE) return;
  if (sim.courier.copies >= COURIER_MAX_COPIES) return;

  // Itinéraire alternatif distinct de celui du parent, si possible.
  const alt = pickNextHop(sim, nodeId, env.prev, parentNext);
  if (alt < 0) return;

  const childBudget = Math.floor(env.budget / 2);
  if (childBudget < 1) return;
  env.budget -= childBudget;

  const child = spawnEnvelopeOn(
    sim,
    nodeId,
    alt,
    env.ttl,
    env.hop,
    childBudget,
    sim.time + 150 + Math.random() * 150
  );
  if (child) sim.courier.copies += 1;
}

function checkCourierLost(sim: SimState): void {
  if (!sim.courier.active) return;
  if (sim.courier.delivered) return;
  if (sim.envelopes.length > 0) return;
  sim.courier.active = false;
  sim.courier.lost = true;
  sim.courier.note = '✗ Enveloppe perdue — TTL épuisé ou destination injoignable';
  sim.courier.noteUntil = sim.time + 4500;
}

function onEnvelopeArrive(sim: SimState, env: Envelope, idx: number): void {
  const t = sim.time;
  const node = sim.nodes[env.to];
  node.courierGlowUntil = t + 420;

  // Course déjà livrée : les copies restantes s'estompent discrètement.
  if (sim.courier.delivered) {
    sim.puffs.push({ x: node.x, y: node.y, at: t, tone: 'courier' });
    sim.envelopes.splice(idx, 1);
    return;
  }

  // Livraison à destination : anneau pulsant + mise à jour « toast ».
  if (node.id === sim.courier.dest) {
    sim.courier.delivered = true;
    sim.courier.active = false;
    sim.courier.winHops = env.hop;
    const copies = sim.courier.copies;
    const copiesTxt =
      copies > 0
        ? `${copies} copie${copies > 1 ? 's' : ''} émise${copies > 1 ? 's' : ''}`
        : 'sans duplication';
    sim.courier.note = `✓ Enveloppe livrée en ${env.hop} saut${env.hop > 1 ? 's' : ''} — ${copiesTxt}`;
    sim.courier.noteUntil = t + 4500;
    sim.pulses.push({ x: node.x, y: node.y, at: t });
    sim.envelopes.splice(idx, 1);
    return;
  }

  // TTL : chaque saut consomme une unité, expiration = « perdu ».
  env.ttl -= 1;
  if (env.ttl <= 0) {
    sim.puffs.push({ x: node.x, y: node.y, at: t, tone: 'courier' });
    sim.envelopes.splice(idx, 1);
    checkCourierLost(sim);
    return;
  }

  // Choix du prochain saut (avide vers la destination).
  const next = pickNextHop(sim, node.id, env.prev, -1);
  if (next < 0) {
    // Bloquée (voisins hors ligne uniquement) : état « perdu ».
    sim.puffs.push({ x: node.x, y: node.y, at: t, tone: 'courier' });
    sim.envelopes.splice(idx, 1);
    checkCourierLost(sim);
    return;
  }

  // Duplication éventuelle du budget de copies (spray-and-wait).
  maybeSplit(sim, env, node.id, next);

  // Redépart de l'enveloppe parente vers le prochain saut.
  const ei = sim.edgeIndex.get(edgeKey(node.id, next));
  if (ei === undefined) {
    sim.envelopes.splice(idx, 1);
    checkCourierLost(sim);
    return;
  }
  env.from = node.id;
  env.to = next;
  env.prev = node.id;
  env.departAt = t + 120 + Math.random() * 160;
  env.arriveAt = env.departAt + travelMs(sim, node.id, next);
  env.hop += 1;
  sim.edgeCourier[ei] = 1;
}

function triggerCourier(sim: SimState, ttl: number): void {
  if (sim.courier.active) return;
  const t = sim.time;

  // Source = nœud vivant le plus à gauche, destination = le plus à droite.
  let src = -1;
  let dest = -1;
  for (const n of sim.nodes) {
    if (n.kind === 'dead') continue;
    if (src < 0 || n.nx < sim.nodes[src].nx) src = n.id;
    if (dest < 0 || n.nx > sim.nodes[dest].nx) dest = n.id;
  }
  if (src < 0 || dest < 0 || src === dest) return;

  for (const n of sim.nodes) {
    n.srcGlow = false;
    n.destGlow = false;
    n.courierGlowUntil = 0;
  }
  sim.nodes[src].srcGlow = true;
  sim.nodes[dest].destGlow = true;

  sim.courier = {
    active: true,
    src,
    dest,
    copies: 0,
    delivered: false,
    lost: false,
    winHops: 0,
    startedAt: t,
    note: '',
    noteUntil: 0,
  };

  const first = pickNextHop(sim, src, -1, -1);
  if (first < 0) {
    sim.courier.active = false;
    sim.courier.lost = true;
    sim.courier.note = '✗ Enveloppe perdue — destination injoignable';
    sim.courier.noteUntil = t + 4500;
    return;
  }
  spawnEnvelopeOn(sim, src, first, ttl, 0, COURIER_BUDGET, t + 260);
}

// ---------------------------------------------------------------------------
// Boucle de simulation
// ---------------------------------------------------------------------------
function stepSim(
  sim: SimState,
  dt: number,
  opts: { paused: boolean; ttl: number }
): void {
  const t = sim.time;

  // Cycle automatique : toutes les ~6 s si aucune diffusion en cours.
  if (
    !opts.paused &&
    sim.transits.length === 0 &&
    sim.relays.length === 0 &&
    t - sim.flood.lastTrigger >= AUTO_FLOOD_MS
  ) {
    triggerFlood(sim, opts.ttl);
  }

  // Arrivées de paquets d'inondation.
  for (let i = sim.transits.length - 1; i >= 0; i--) {
    const p = sim.transits[i];
    if (t >= p.arriveAt) {
      sim.transits.splice(i, 1);
      onFloodArrive(sim, p);
    }
  }

  // Départs de retransmissions (fin de la gigue).
  for (let i = sim.relays.length - 1; i >= 0; i--) {
    const r = sim.relays[i];
    if (t >= r.departAt) {
      sim.relays.splice(i, 1);
      departRelay(sim, r);
    }
  }

  // Arrivées d'enveloppes.
  for (let i = sim.envelopes.length - 1; i >= 0; i--) {
    const e = sim.envelopes[i];
    if (t >= e.arriveAt) onEnvelopeArrive(sim, e, i);
  }

  // Décroissance de l'activité visuelle des arêtes.
  for (let i = 0; i < sim.edgeFlood.length; i++) {
    if (sim.edgeFlood[i] > 0) {
      sim.edgeFlood[i] = Math.max(0, sim.edgeFlood[i] - dt * 0.0025);
    }
    if (sim.edgeCourier[i] > 0) {
      sim.edgeCourier[i] = Math.max(0, sim.edgeCourier[i] - dt * 0.0018);
    }
  }
}

// ---------------------------------------------------------------------------
// Rendu Canvas 2D
// ---------------------------------------------------------------------------
function drawSim(ctx: CanvasRenderingContext2D, sim: SimState): void {
  const { w, h, time: t, nodes, edges } = sim;
  ctx.clearRect(0, 0, w, h);

  // Trame de fond discrète.
  ctx.fillStyle = 'rgba(255,255,255,0.032)';
  for (let gx = 18; gx < w; gx += 34) {
    for (let gy = 18; gy < h; gy += 34) {
      ctx.fillRect(gx, gy, 1.3, 1.3);
    }
  }

  // Liens (base zinc + surcouche colorée si activité).
  ctx.lineWidth = 1;
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    const a = nodes[e.a];
    const b = nodes[e.b];
    ctx.strokeStyle = 'rgba(82,82,91,0.30)';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();

    const f = sim.edgeFlood[i];
    const c = sim.edgeCourier[i];
    if (f > 0.03 || c > 0.03) {
      ctx.lineWidth = 1.4;
      ctx.strokeStyle =
        f >= c
          ? `rgba(52,211,153,${(0.08 + 0.3 * f).toFixed(3)})`
          : `rgba(245,158,11,${(0.08 + 0.3 * c).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.lineWidth = 1;
    }
  }

  // Anneaux pulsants de livraison (ambre).
  for (let i = sim.pulses.length - 1; i >= 0; i--) {
    const p = sim.pulses[i];
    const age = t - p.at;
    if (age > PULSE_MS) {
      sim.pulses.splice(i, 1);
      continue;
    }
    for (let ring = 0; ring < 2; ring++) {
      const age2 = age - ring * 180;
      if (age2 < 0) continue;
      const k = 1 - age2 / PULSE_MS;
      ctx.strokeStyle = `rgba(245,158,11,${(0.7 * k).toFixed(3)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6 + age2 * 0.05, 0, TAU);
      ctx.stroke();
    }
    ctx.lineWidth = 1;
  }

  // Petites disparitions (paquets morts / doublons absorbés).
  for (let i = sim.puffs.length - 1; i >= 0; i--) {
    const p = sim.puffs[i];
    const age = t - p.at;
    if (age > PUFF_MS) {
      sim.puffs.splice(i, 1);
      continue;
    }
    const k = 1 - age / PUFF_MS;
    ctx.fillStyle =
      p.tone === 'flood'
        ? `rgba(52,211,153,${(0.35 * k).toFixed(3)})`
        : `rgba(245,158,11,${(0.35 * k).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3 + age * 0.018, 0, TAU);
    ctx.fill();
  }

  // Nœuds.
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'center';
  for (const n of nodes) {
    const isGw = n.kind === 'gateway';

    if (n.kind === 'dead') {
      // Hors ligne : rouge atténué + barre diagonale, ne relaie jamais.
      ctx.fillStyle = 'rgba(239,68,68,0.28)';
      ctx.beginPath();
      ctx.arc(n.x, n.y, 3, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = 'rgba(239,68,68,0.55)';
      ctx.beginPath();
      ctx.moveTo(n.x - 4.2, n.y + 4.2);
      ctx.lineTo(n.x + 4.2, n.y - 4.2);
      ctx.stroke();
      continue;
    }

    // Halo ambre récent (passage d'une enveloppe).
    if (t < n.courierGlowUntil) {
      ctx.fillStyle = 'rgba(245,158,11,0.14)';
      ctx.beginPath();
      ctx.arc(n.x, n.y, 9, 0, TAU);
      ctx.fill();
    }

    if (t < n.flashUntil) {
      // Flash émeraude vif à la réception.
      ctx.fillStyle = 'rgba(52,211,153,0.16)';
      ctx.beginPath();
      ctx.arc(n.x, n.y, 11, 0, TAU);
      ctx.fill();
      ctx.fillStyle = EMERALD_LIGHT;
      ctx.beginPath();
      ctx.arc(n.x, n.y, 5.2, 0, TAU);
      ctx.fill();
    } else if (n.visited) {
      // État « reçu » plus sombre.
      ctx.fillStyle = 'rgba(16,185,129,0.45)';
      ctx.beginPath();
      ctx.arc(n.x, n.y, 3.6, 0, TAU);
      ctx.fill();
    } else {
      ctx.fillStyle = isGw
        ? 'rgba(212,212,216,0.92)'
        : 'rgba(161,161,170,0.66)';
      ctx.beginPath();
      ctx.arc(n.x, n.y, isGw ? 4 : 3.2, 0, TAU);
      ctx.fill();
    }

    // Passerelle : anneau ambre.
    if (isGw) {
      ctx.strokeStyle = 'rgba(245,158,11,0.8)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(n.x, n.y, 7.4, 0, TAU);
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    // Marqueurs Départ / Arrivée du courrier.
    if (n.srcGlow || n.destGlow) {
      ctx.strokeStyle = 'rgba(245,158,11,0.9)';
      ctx.setLineDash([3, 3]);
      ctx.lineDashOffset = -t * 0.012;
      ctx.beginPath();
      ctx.arc(n.x, n.y, 10.5, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(245,158,11,0.95)';
      ctx.fillText(n.srcGlow ? 'Départ' : 'Arrivée', n.x, n.y - 15);
    }
  }

  // Arcs de gigue de retransmission (délai visualisé).
  for (const r of sim.relays) {
    const n = sim.nodes[r.node];
    const span = r.departAt - r.from;
    const k = span > 0 ? clamp((t - r.from) / span, 0, 1) : 1;
    ctx.strokeStyle = 'rgba(52,211,153,0.85)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(n.x, n.y, 8.6, -Math.PI / 2, -Math.PI / 2 + k * TAU);
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  // Paquets d'inondation en vol (point lumineux + halo).
  for (const p of sim.transits) {
    const a = nodes[p.from];
    const b = nodes[p.to];
    const span = p.arriveAt - p.departAt;
    const k = span > 0 ? clamp((t - p.departAt) / span, 0, 1) : 1;
    const x = a.x + (b.x - a.x) * k;
    const y = a.y + (b.y - a.y) * k;
    ctx.fillStyle = 'rgba(52,211,153,0.16)';
    ctx.beginPath();
    ctx.arc(x, y, 6.5, 0, TAU);
    ctx.fill();
    ctx.fillStyle = EMERALD;
    ctx.beginPath();
    ctx.arc(x, y, 2.4, 0, TAU);
    ctx.fill();
  }

  // Enveloppes du courrier (glyphe ambre + traînée sans allocation).
  for (const e of sim.envelopes) {
    const a = nodes[e.from];
    const b = nodes[e.to];
    const span = e.arriveAt - e.departAt;
    const k = span > 0 ? clamp((t - e.departAt) / span, 0, 1) : 1;
    const x = a.x + (b.x - a.x) * k;
    const y = a.y + (b.y - a.y) * k;

    for (let s = 3; s >= 1; s--) {
      const kk = k - s * 0.085;
      if (kk <= 0) continue;
      const tx = a.x + (b.x - a.x) * kk;
      const ty = a.y + (b.y - a.y) * kk;
      ctx.fillStyle = `rgba(245,158,11,${(0.16 / s).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(tx, ty, 2.6, 0, TAU);
      ctx.fill();
    }

    ctx.fillStyle = 'rgba(245,158,11,0.15)';
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, TAU);
    ctx.fill();

    ctx.strokeStyle = AMBER;
    ctx.fillStyle = 'rgba(245,158,11,0.3)';
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.rect(x - 5, y - 3.5, 10, 7);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 5, y - 3.5);
    ctx.lineTo(x, y + 1);
    ctx.lineTo(x + 5, y - 3.5);
    ctx.stroke();
    ctx.lineWidth = 1;
  }
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
const INITIAL_HUD: Hud = {
  nodes: 42,
  links: 0,
  reachedPct: 0,
  maxHops: 0,
  packets: 0,
  courierActive: false,
  hasRun: false,
  copies: 0,
  delivered: false,
  lost: false,
  note: '',
  noteVisible: false,
};

function snapshotHud(sim: SimState): Hud {
  const pct =
    sim.flood.nonDead > 0
      ? Math.round((100 * sim.flood.reached) / sim.flood.nonDead)
      : 0;
  return {
    nodes: sim.nodes.length,
    links: sim.edges.length,
    reachedPct: pct,
    maxHops: sim.flood.maxHops,
    packets: sim.transits.length + sim.relays.length,
    courierActive: sim.courier.active,
    hasRun: sim.courier.startedAt > 0,
    copies: sim.courier.copies,
    delivered: sim.courier.delivered,
    lost: sim.courier.lost,
    note: sim.courier.note,
    noteVisible: sim.courier.note !== '' && sim.time < sim.courier.noteUntil,
  };
}

function hudEqual(a: Hud, b: Hud): boolean {
  return (
    a.nodes === b.nodes &&
    a.links === b.links &&
    a.reachedPct === b.reachedPct &&
    a.maxHops === b.maxHops &&
    a.packets === b.packets &&
    a.courierActive === b.courierActive &&
    a.hasRun === b.hasRun &&
    a.copies === b.copies &&
    a.delivered === b.delivered &&
    a.lost === b.lost &&
    a.noteVisible === b.noteVisible &&
    a.note === b.note
  );
}

function createSim(w: number, h: number): SimState {
  return {
    seed: 0,
    w,
    h,
    time: 0,
    nodes: [],
    edges: [],
    edgeIndex: new Map<number, number>(),
    edgeFlood: new Float32Array(0),
    edgeCourier: new Float32Array(0),
    transits: [],
    relays: [],
    envelopes: [],
    puffs: [],
    pulses: [],
    flood: { reached: 0, nonDead: 0, maxHops: 0, lastTrigger: 0 },
    courier: {
      active: false,
      src: -1,
      dest: -1,
      copies: 0,
      delivered: false,
      lost: false,
      winHops: 0,
      startedAt: 0,
      note: '',
      noteUntil: 0,
    },
    lastHudAt: 0,
  };
}

// ---------------------------------------------------------------------------
// Composant
// ---------------------------------------------------------------------------
export default function MeshSimulation({ className }: MeshSimulationProps) {
  const [paused, setPaused] = useState(false);
  const [nodeCount, setNodeCount] = useState(42);
  const [ttl, setTtl] = useState(7);
  const [hud, setHud] = useState<Hud>(INITIAL_HUD);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const simRef = useRef<SimState | null>(null);
  const seedRef = useRef<number>(0);
  const pausedRef = useRef(false);
  const ttlRef = useRef(7);
  const nodeCountRef = useRef(42);
  const prevCountRef = useRef(42);

  // Synchronisation refs ← état (lecture dans la boucle RAF sans re-render).
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);
  useEffect(() => {
    ttlRef.current = ttl;
  }, [ttl]);
  useEffect(() => {
    nodeCountRef.current = nodeCount;
  }, [nodeCount]);

  // Montage : mesure, création de l'état, mise à l'échelle devicePixelRatio,
  // ResizeObserver pour remplir la largeur du conteneur.
  useEffect(() => {
    const wrap = wrapRef.current;
    const cv = canvasRef.current;
    if (!wrap || !cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;

    const applySize = (): void => {
      const rect = wrap.getBoundingClientRect();
      const dpr = Math.min(2.5, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const sim = simRef.current;
      if (sim) {
        sim.w = w;
        sim.h = h;
        placeNodes(sim);
      }
    };

    if (!simRef.current) {
      if (seedRef.current === 0) {
        seedRef.current = Math.floor(Math.random() * 2147483647) + 1;
      }
      const rect = wrap.getBoundingClientRect();
      const sim = createSim(
        Math.max(1, Math.round(rect.width)),
        Math.max(1, Math.round(rect.height))
      );
      simRef.current = sim;
      rebuildSim(sim, nodeCountRef.current, seedRef.current);
    }
    applySize();

    const ro = new ResizeObserver(applySize);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  // Changement du nombre de nœuds : reconstruction du graphe (même graine,
  // disposition déterministe), positions précalculées.
  useEffect(() => {
    if (prevCountRef.current === nodeCount) return;
    prevCountRef.current = nodeCount;
    const sim = simRef.current;
    if (!sim) return;
    rebuildSim(sim, nodeCount, sim.seed);
  }, [nodeCount]);

  // Boucle de rendu requestAnimationFrame + nettoyage au démontage.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const frame = (now: number): void => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(50, now - last);
      last = now;
      const sim = simRef.current;
      const cv = canvasRef.current;
      if (!sim || !cv) return;
      const ctx = cv.getContext('2d');
      if (!ctx) return;

      // La pause fige l'horloge simulée (le rendu continue, figé).
      if (!pausedRef.current) sim.time += dt;
      stepSim(sim, dt, { paused: pausedRef.current, ttl: ttlRef.current });
      drawSim(ctx, sim);

      if (sim.time - sim.lastHudAt >= HUD_INTERVAL_MS) {
        sim.lastHudAt = sim.time;
        const snap = snapshotHud(sim);
        setHud((prev) => (hudEqual(prev, snap) ? prev : snap));
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  const handleFlood = useCallback((): void => {
    const sim = simRef.current;
    if (!sim) return;
    triggerFlood(sim, ttlRef.current);
  }, []);

  const handleCourier = useCallback((): void => {
    const sim = simRef.current;
    if (!sim) return;
    triggerCourier(sim, ttlRef.current);
  }, []);

  const handleTogglePause = useCallback((): void => {
    setPaused((p) => !p);
  }, []);

  const handleReset = useCallback((): void => {
    const sim = simRef.current;
    if (!sim) return;
    seedRef.current = Math.floor(Math.random() * 2147483647) + 1;
    rebuildSim(sim, nodeCountRef.current, seedRef.current);
  }, []);

  const floodBtnCls =
    'border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-300 dark:border-emerald-500/40 dark:hover:bg-emerald-500/10 dark:hover:text-emerald-300';
  const courierBtnCls =
    'border-amber-500/40 text-amber-400 hover:bg-amber-500/10 hover:text-amber-300 dark:border-amber-500/40 dark:hover:bg-amber-500/10 dark:hover:text-amber-300';
  const neutralBtnCls =
    'border-zinc-700 text-zinc-300 hover:bg-zinc-800/60 hover:text-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800/60 dark:hover:text-zinc-100';

  return (
    <div className={cx('w-full', className)}>
      {/* Canevas de simulation */}
      <div
        ref={wrapRef}
        className="relative w-full h-[420px] md:h-[500px] rounded-xl border border-border/60 bg-zinc-950 overflow-hidden"
      >
        <canvas
          ref={canvasRef}
          role="img"
          aria-label="Simulation animée d'un réseau maillé sans fil Mbote : des paquets émeraude inondent le réseau de nœud en nœud avec une durée de vie TTL, et des enveloppes ambre sont livrées de la source vers la destination en mode courrier. Les boutons sous le canevas permettent de lancer, mettre en pause ou réinitialiser la simulation."
          className="block h-full w-full select-none"
        />

        {/* Barre de statistiques live (superposée, non interactive) */}
        <div className="pointer-events-none absolute right-3 top-3 z-10 flex max-w-[calc(100%-1.5rem)] flex-col items-end gap-1.5 font-mono text-[11px]">
          <div className="flex flex-wrap items-center justify-end gap-x-1.5 gap-y-0.5 rounded-lg border border-border/60 bg-zinc-900/80 px-2.5 py-1.5 text-zinc-300 shadow-lg shadow-black/20 backdrop-blur-sm">
            <Radio
              aria-hidden="true"
              className={cx(
                'h-3 w-3 shrink-0',
                paused
                  ? 'text-zinc-500'
                  : hud.packets > 0
                    ? 'animate-pulse text-emerald-400'
                    : 'text-emerald-400'
              )}
            />
            <span>Nœuds&nbsp;: {hud.nodes}</span>
            <span className="text-zinc-600">·</span>
            <span>Liens&nbsp;: {hud.links}</span>
            <span className="text-zinc-600">·</span>
            <span className="text-emerald-400">
              Atteints&nbsp;: {hud.reachedPct}%
            </span>
            <span className="text-zinc-600">·</span>
            <span>Sauts max&nbsp;: {hud.maxHops > 0 ? hud.maxHops : '–'}</span>
          </div>

          {hud.packets > 0 && (
            <div className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-zinc-900/80 px-2.5 py-1 text-emerald-300 shadow-lg shadow-black/20 backdrop-blur-sm">
              <Signal aria-hidden="true" className="h-3 w-3 shrink-0" />
              <span>Paquets actifs&nbsp;: {hud.packets}</span>
            </div>
          )}

          {hud.hasRun && (
            <div className="flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-zinc-900/80 px-2.5 py-1 text-amber-300 shadow-lg shadow-black/20 backdrop-blur-sm">
              <Mail aria-hidden="true" className="h-3 w-3 shrink-0" />
              <span>
                Copies&nbsp;: {hud.copies}/{COURIER_MAX_COPIES} · Livré&nbsp;:{' '}
                {hud.delivered ? '✓' : hud.lost ? '✗' : '…'}
              </span>
            </div>
          )}
        </div>

        {/* Message éphémère « toast » (livraison / perte) */}
        {hud.noteVisible && hud.note !== '' && (
          <div
            role="status"
            className="pointer-events-none absolute bottom-3 left-1/2 z-10 max-w-[calc(100%-1.5rem)] -translate-x-1/2 truncate rounded-lg border border-amber-500/40 bg-zinc-900/90 px-3 py-1.5 font-mono text-[11px] text-amber-200 shadow-lg shadow-black/30 backdrop-blur-sm"
          >
            {hud.note}
          </div>
        )}
      </div>

      {/* Contrôles */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={handleFlood}
          className={floodBtnCls}
        >
          <Zap aria-hidden="true" className="h-3.5 w-3.5" />
          Inonder
        </Button>

        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={handleCourier}
          className={courierBtnCls}
        >
          <Mail aria-hidden="true" className="h-3.5 w-3.5" />
          Courrier
        </Button>

        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={handleTogglePause}
          aria-pressed={paused}
          className={neutralBtnCls}
        >
          {paused ? (
            <Play aria-hidden="true" className="h-3.5 w-3.5" />
          ) : (
            <Pause aria-hidden="true" className="h-3.5 w-3.5" />
          )}
          {paused ? 'Reprendre' : 'Pause'}
        </Button>

        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={handleReset}
          className={neutralBtnCls}
        >
          <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
          Réinitialiser
        </Button>

        <div className="ml-1 flex items-center gap-2">
          <label htmlFor="mbote-slider-noeuds" className="text-xs text-zinc-400">
            Nœuds
          </label>
          <Slider
            id="mbote-slider-noeuds"
            min={20}
            max={80}
            step={1}
            value={[nodeCount]}
            onValueChange={(v) => setNodeCount(v[0] ?? 42)}
            aria-label="Nombre de nœuds du réseau"
            className="w-24"
          />
          <span className="w-6 text-right font-mono text-xs text-zinc-300">
            {nodeCount}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <label htmlFor="mbote-slider-ttl" className="text-xs text-zinc-400">
            TTL
          </label>
          <Slider
            id="mbote-slider-ttl"
            min={3}
            max={7}
            step={1}
            value={[ttl]}
            onValueChange={(v) => setTtl(v[0] ?? 7)}
            aria-label="Durée de vie des paquets (TTL, en sauts)"
            className="w-28"
          />
          <span className="w-6 text-right font-mono text-xs text-zinc-300">
            {ttl}
          </span>
        </div>

        {/* Légende */}
        <div
          aria-label="Légende de la simulation"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-400 md:ml-auto"
        >
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="h-2 w-2 rounded-full bg-emerald-500"
            />
            Inondation
          </span>
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="h-2 w-2 rounded-full bg-amber-500"
            />
            Courrier
          </span>
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="h-2 w-2 rounded-full bg-zinc-500"
            />
            Nœud
          </span>
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="h-2.5 w-2.5 rounded-full border-2 border-amber-500/80"
            />
            Passerelle
          </span>
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="h-2 w-2 rounded-full bg-red-500/70"
            />
            Hors ligne
          </span>
        </div>
      </div>
    </div>
  );
}
