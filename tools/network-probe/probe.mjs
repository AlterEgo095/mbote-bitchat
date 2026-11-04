#!/usr/bin/env node
/* eslint-disable no-console */
// =============================================================================
// probe.mjs — Sonde réseau Mbote BitChat (protocole 48 h, opérateurs RDC)
// -----------------------------------------------------------------------------
// Node >= 18, ZÉRO dépendance externe.
// Chaque cycle mesure, vers PROBE_TARGET :
//   a) DNS        : dns.promises.lookup (durée + IP résolue)
//   b) TCP + TLS  : tls.connect :443 (temps TCP = événement "connect",
//                   temps handshake TLS = "secureConnect" − "connect", IP du edge)
//   c) HTTP       : fetch GET ${PROBE_TARGET}/manifest.webmanifest (cache: no-store)
//                   → durée totale, code HTTP, taille du corps
//   d) En-têtes   : cf-ray → cf_colo (datacenter Cloudflare, ex. "HKG") —
//                   le format réel est <hex>-<IATA> (tiret ; "_" toléré aussi),
//                   cf-cache-status, age, server
//   e) Contrôle   : ping ICMP 1.1.1.1 si disponible (non bloquant, tolérant)
//   f) CSV        : 1 ligne/cycle dans ${PROBE_OUT}/probe-<label>-<date>.csv
//
// Conçu pour les réseaux RDC : toute exception est capturée → ligne CSV avec
// l'erreur, la sonde continue, ne crashe JAMAIS. Reprise après sommeil/reboot
// grâce au fichier .end-at (fin prévue conservée).
// Guide volontaire : voir README-RDC.md. Protocole : docs/NETWORK-MEASUREMENT-48H.md
// =============================================================================

import dns from 'node:dns';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const VERSION = '1.0.0';

// -----------------------------------------------------------------------------
// Configuration (variables d'environnement)
// -----------------------------------------------------------------------------
const env = process.env;

const RAW_TARGET = (env.PROBE_TARGET || 'https://mbotemesh.aenews.online').trim();
let TARGET;
try {
  TARGET = new URL(RAW_TARGET);
} catch {
  console.error(`[probe] PROBE_TARGET invalide : "${RAW_TARGET}" (attendu : https://...)`);
  process.exit(2);
}
if (!/^https?:$/.test(TARGET.protocol)) {
  console.error(`[probe] PROBE_TARGET doit être http(s), reçu : "${RAW_TARGET}"`);
  process.exit(2);
}
const HTTPS = TARGET.protocol === 'https:';
const TLS_PORT = Number(TARGET.port) || 443;
const HTTP_URL = new URL('/manifest.webmanifest', TARGET.origin + '/').toString();

const INTERVAL_S = Math.max(1, Number(env.PROBE_INTERVAL_S) || 300);
const INTERVAL_MS = INTERVAL_S * 1000;
const LABEL = (env.PROBE_LABEL || 'sans-label').trim();
const FILE_LABEL = LABEL.toLowerCase().replace(/[^a-z0-9._-]+/g, '-') || 'sans-label';
const DURATION_H = Number(env.PROBE_DURATION_H) || 48; // accepte les fractions (0.001 pour un test)
const OUT_DIR = env.PROBE_OUT || './probe-data';

const DNS_TIMEOUT_MS = 8000;
const TLS_TIMEOUT_MS = 10000;
const HTTP_TIMEOUT_MS = 20000;
const PING_TIMEOUT_MS = 4000;
const END_FILE = path.join(OUT_DIR, `probe-${FILE_LABEL}.end-at`);

// -----------------------------------------------------------------------------
// CSV — colonnes demandées (timestamp_iso, label, dns_ms, tls_ms, http_ms,
// status, bytes, cf_colo, error) + colonnes complémentaires de mesure
// (dns_ip, tcp_ms, edge_ip, cf_cache_status, server, icmp_ms).
// -----------------------------------------------------------------------------
const CSV_HEADER =
  'timestamp_iso,label,dns_ms,dns_ip,tcp_ms,tls_ms,edge_ip,http_ms,status,bytes,' +
  'cf_colo,cf_cache_status,cf_age,server,icmp_ms,error';

const headerWritten = new Set();

function csvField(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvFilePath(d = new Date()) {
  const date = d.toISOString().slice(0, 10); // UTC → un fichier par jour
  return path.join(OUT_DIR, `probe-${FILE_LABEL}-${date}.csv`);
}

function appendRow(rec) {
  const file = csvFilePath();
  if (!headerWritten.has(file)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, CSV_HEADER + '\n', 'utf8');
    headerWritten.add(file);
  }
  const line = [
    rec.timestamp_iso, rec.label, rec.dns_ms, rec.dns_ip, rec.tcp_ms, rec.tls_ms,
    rec.edge_ip, rec.http_ms, rec.status, rec.bytes, rec.cf_colo,
    rec.cf_cache_status, rec.cf_age, rec.server, rec.icmp_ms, rec.error,
  ].map(csvField).join(',');
  fs.appendFileSync(file, line + '\n', 'utf8');
  return file;
}

const ms = (v) => (v == null || !Number.isFinite(v)) ? '' : String(Math.round(v * 10) / 10);
const now = () => performance.now();
const errStr = (e) => String(e?.code || e?.cause?.code || e?.cause?.message || e?.message || e).slice(0, 120);

// -----------------------------------------------------------------------------
// a) DNS — durée + IP résolue
// -----------------------------------------------------------------------------
function withTimeout(promise, ms_, message) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(message)), ms_);
  });
  timeout.catch(() => {}); // évite unhandledRejection si l'autre branche gagne
  return { raced: Promise.race([promise, timeout]), clear: () => clearTimeout(t) };
}

async function dnsProbe(host) {
  const t0 = now();
  const { raced, clear } = withTimeout(dns.promises.lookup(host), DNS_TIMEOUT_MS, 'dns_timeout');
  try {
    const r = await raced;
    return { dns_ms: now() - t0, dns_ip: r?.address || '', error: '' };
  } catch (e) {
    return { dns_ms: null, dns_ip: '', error: errStr(e) };
  } finally {
    clear();
  }
}

// -----------------------------------------------------------------------------
// b) TCP + TLS — temps TCP (événement "connect"), temps handshake TLS
//    ("secureConnect" − "connect"), IP du edge Cloudflare (socket distant)
// -----------------------------------------------------------------------------
function tlsProbe(host, port) {
  return new Promise((resolve) => {
    const t0 = now();
    let tcpMs = null;
    let ip = '';
    let settled = false;
    let hardGuard = null;

    const sock = tls.connect({ host, port, servername: host });
    sock.setTimeout(TLS_TIMEOUT_MS);

    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (hardGuard) clearTimeout(hardGuard);
      const at = now();
      const tlsMs = tcpMs != null ? at - t0 - tcpMs : (error ? null : at - t0);
      try { sock.destroy(); } catch {}
      resolve({ tcpMs, tlsMs, ip, error: error || '' });
    };

    sock.on('lookup', (err, address) => { if (!err && address) ip = address; });
    sock.on('connect', () => { tcpMs = now() - t0; });
    sock.on('secureConnect', () => finish(''));
    sock.on('timeout', () => finish('tls_timeout'));
    sock.on('error', (e) => finish(errStr(e)));
    sock.on('close', () => finish('connexion fermée avant TLS'));

    hardGuard = setTimeout(() => finish('tls_timeout_hard'), TLS_TIMEOUT_MS + 2000);
  });
}

// -----------------------------------------------------------------------------
// c) + d) HTTP — GET /manifest.webmanifest (no-store) : durée totale, status,
//    bytes + capture cf-ray / cf-cache-status / server
// -----------------------------------------------------------------------------
function cfColo(cfRay) {
  if (!cfRay) return '';
  // Format réel observé : "8a1b...-HKG" (tiret). On tolère aussi "_" par prudence.
  const parts = String(cfRay).split(/[-_]/);
  return parts.length > 1 ? parts[parts.length - 1] : '';
}

async function httpProbe(url) {
  const t0 = now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('http_timeout')), HTTP_TIMEOUT_MS);
  const init = { method: 'GET', redirect: 'follow', cache: 'no-store', signal: ctrl.signal };
  try {
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      // Robustesse Node 18.x : si l'option `cache` n'est pas supportée, retente sans.
      if (/cache/i.test(String(e?.message))) res = await fetch(url, { ...init, cache: undefined });
      else throw e;
    }
    const buf = await res.arrayBuffer();
    return {
      http_ms: now() - t0,
      status: res.status,
      bytes: buf.byteLength,
      cf_colo: cfColo(res.headers.get('cf-ray')),
      cf_cache_status: res.headers.get('cf-cache-status') || '',
      cf_age: res.headers.get('age') || '',
      server: res.headers.get('server') || '',
      error: '',
    };
  } catch (e) {
    return {
      http_ms: null, status: '', bytes: '', cf_colo: '', cf_cache_status: '', cf_age: '',
      server: '', error: e?.name === 'AbortError' ? 'http_timeout' : errStr(e),
    };
  } finally {
    clearTimeout(timer);
  }
}

// -----------------------------------------------------------------------------
// e) Contrôle ICMP 1.1.1.1 — non bloquant, tolérant à l'absence de `ping`
// -----------------------------------------------------------------------------
function pingOnce(host = '1.1.1.1') {
  return new Promise((resolve) => {
    try {
      let args;
      if (process.platform === 'win32') args = ['-n', '1', '-w', String(PING_TIMEOUT_MS), host];
      else if (process.platform === 'darwin') args = ['-c', '1', '-W', String(PING_TIMEOUT_MS), host];
      else args = ['-c', '1', '-W', '2', host]; // Linux / Termux
      execFile('ping', args, { timeout: PING_TIMEOUT_MS + 1500, windowsHide: true }, (err, stdout) => {
        const m = /time[=<]\s*([\d.]+)\s*ms/i.exec(String(stdout || ''));
        resolve(m ? Number(m[1]) : null);
      });
    } catch {
      resolve(null); // ping absent → toléré
    }
  });
}

// -----------------------------------------------------------------------------
// Cycle de mesure + échantillons pour le résumé
// -----------------------------------------------------------------------------
const samples = []; // { t, ok, httpMs, colo }
let rowCount = 0;
let lastFile = '';

async function runCycle() {
  const rec = {
    timestamp_iso: new Date().toISOString(),
    label: LABEL,
    dns_ms: '', dns_ip: '', tcp_ms: '', tls_ms: '', edge_ip: '',
    http_ms: '', status: '', bytes: '', cf_colo: '', cf_cache_status: '', cf_age: '',
    server: '', icmp_ms: '', error: '',
  };
  const sample = { t: Date.parse(rec.timestamp_iso), ok: false, httpMs: null, colo: '' };

  try {
    const icmpPromise = pingOnce(); // lancé en premier, non bloquant

    // a) DNS
    const d = await dnsProbe(TARGET.hostname);
    rec.dns_ms = ms(d.dns_ms);
    rec.dns_ip = d.dns_ip;
    if (d.error) rec.error = d.error;

    // b) TCP + TLS (uniquement si cible https)
    if (HTTPS) {
      const tl = await tlsProbe(TARGET.hostname, TLS_PORT);
      rec.tcp_ms = ms(tl.tcpMs);
      rec.tls_ms = ms(tl.tlsMs);
      rec.edge_ip = tl.ip || '';
      if (tl.error && !rec.error) rec.error = tl.error;
    }

    // c) + d) HTTP + en-têtes Cloudflare
    const h = await httpProbe(HTTP_URL);
    rec.http_ms = ms(h.http_ms);
    rec.status = h.status;
    rec.bytes = h.bytes;
    rec.cf_colo = h.cf_colo;
    rec.cf_cache_status = h.cf_cache_status;
    rec.cf_age = h.cf_age;
    rec.server = h.server;
    if (h.error && !rec.error) rec.error = h.error;
    if (typeof h.status === 'number' && h.status >= 200 && h.status < 300) {
      sample.ok = true;
      sample.httpMs = h.http_ms;
      sample.colo = h.cf_colo;
    }

    // e) ICMP : pris en compte seulement s'il est déjà prêt (jamais bloquant)
    const icmp = await Promise.race([icmpPromise, Promise.resolve(undefined)]);
    rec.icmp_ms = icmp == null ? '' : String(icmp);
  } catch (e) {
    rec.error = rec.error || errStr(e);
  }

  // f) CSV — une ligne par cycle, quoi qu'il arrive
  try {
    lastFile = appendRow(rec);
  } catch (e) {
    console.error(`[probe] ÉCRITURE CSV impossible : ${e.message}`);
  }

  rowCount += 1;
  samples.push(sample);
  console.log(
    `[${rec.timestamp_iso}] ${rec.label} | dns=${rec.dns_ms} tcp=${rec.tcp_ms} tls=${rec.tls_ms} ` +
    `http=${rec.http_ms} status=${rec.status} bytes=${rec.bytes} colo=${rec.cf_colo || '-'} ` +
    `icmp=${rec.icmp_ms}${rec.error ? ' | ERREUR: ' + rec.error : ''}`
  );
}

// -----------------------------------------------------------------------------
// Résumé à l'arrêt — nb mesures, taux de succès, p50/p95 http_ms par tranche
// -----------------------------------------------------------------------------
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function fmtMs(v) {
  return v == null ? 'n/a' : `${Math.round(v * 10) / 10} ms`;
}

function printSummary(reason) {
  const okCount = samples.filter((s) => s.ok).length;
  const httpVals = samples.map((s) => s.httpMs).filter((v) => v != null).sort((a, b) => a - b);
  const rate = rowCount ? ((okCount / rowCount) * 100).toFixed(1) : 'n/a';

  console.log('\n============================================================');
  console.log(`RÉSUMÉ DE LA SONDE — Mbote BitChat v${VERSION}`);
  console.log(`Arrêt            : ${reason}`);
  console.log(`Fichier CSV      : ${lastFile || path.join(OUT_DIR, `probe-${FILE_LABEL}-<date>.csv`)}`);
  console.log(`Mesures          : ${rowCount}`);
  console.log(`Taux de succès   : ${rate} % (${okCount}/${rowCount} réponses HTTP 2xx)`);

  if (httpVals.length) {
    console.log(`http_ms global   : p50=${fmtMs(percentile(httpVals, 50))}  p95=${fmtMs(percentile(httpVals, 95))}`);
  } else {
    console.log('http_ms global   : aucune mesure HTTP réussie');
  }

  // Tranches horaires (UTC)
  const buckets = new Map();
  for (const s of samples) {
    const key = new Date(s.t).toISOString().slice(0, 13) + 'h UTC';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(s);
  }
  if (buckets.size) {
    console.log('Par tranche horaire (UTC) :');
    console.log('  tranche             n    succès%   p50 http_ms   p95 http_ms');
    for (const [key, arr] of [...buckets.entries()].sort()) {
      const vals = arr.map((s) => s.httpMs).filter((v) => v != null).sort((a, b) => a - b);
      const oks = arr.filter((s) => s.ok).length;
      console.log(
        `  ${key}  ${String(arr.length).padStart(3)}  ` +
        `${((oks / arr.length) * 100).toFixed(1).padStart(7)}   ` +
        `${String(vals.length ? Math.round(percentile(vals, 50)) : 'n/a').padStart(10)}   ` +
        `${String(vals.length ? Math.round(percentile(vals, 95)) : 'n/a').padStart(10)}`
      );
    }
  }

  // Distribution des edges Cloudflare observés
  const colos = new Map();
  for (const s of samples) if (s.colo) colos.set(s.colo, (colos.get(s.colo) || 0) + 1);
  if (colos.size) {
    const top = [...colos.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([k, v]) => `${k} ×${v}`).join(', ');
    console.log(`Edges Cloudflare : ${top}`);
  }
  console.log('============================================================\n');
}

// -----------------------------------------------------------------------------
// Fin prévue + reprise après sommeil/reboot (fichier .end-at)
// -----------------------------------------------------------------------------
fs.mkdirSync(OUT_DIR, { recursive: true });

let endAt = Date.now() + DURATION_H * 3600_000;
let resumed = false;
if (fs.existsSync(END_FILE)) {
  try {
    const prev = Date.parse(fs.readFileSync(END_FILE, 'utf8').trim());
    if (Number.isFinite(prev) && prev > Date.now()) {
      endAt = prev; // campagne en cours → on garde la même fin prévue
      resumed = true;
    }
  } catch { /* fichier illisible → nouvelle campagne */ }
}
fs.writeFileSync(END_FILE, new Date(endAt).toISOString() + '\n', 'utf8');

// -----------------------------------------------------------------------------
// Boucle principale — setTimeout chaîné (pas de dérive), jamais de crash
// -----------------------------------------------------------------------------
console.log(`Sonde réseau Mbote BitChat v${VERSION}`);
console.log(`  cible HTTP    : ${HTTP_URL}`);
console.log(`  TCP/TLS       : ${HTTPS ? `${TARGET.hostname}:${TLS_PORT}` : '(ignoré, cible non https)'}`);
console.log(`  étiquette     : ${LABEL}`);
console.log(`  intervalle    : ${INTERVAL_S} s`);
console.log(`  durée         : ${DURATION_H} h → fin prévue : ${new Date(endAt).toISOString()}`);
console.log(`  sortie        : ${path.resolve(OUT_DIR)}`);
console.log(`  mode          : ${resumed ? 'REPRISE (fin prévue conservée depuis .end-at)' : 'DÉMARRAGE (nouvelle campagne)'}`);
console.log('  arrêt manuel  : Ctrl+C (un résumé est affiché)\n');

let timer = null;
let nextAt = Date.now() + INTERVAL_MS;
let stopped = false;

function stop(reason) {
  if (stopped) return;
  stopped = true;
  if (timer) clearTimeout(timer);
  printSummary(reason);
  process.exit(0);
}

async function loop() {
  if (Date.now() >= endAt) return stop('durée du protocole atteinte');
  await runCycle();
  if (stopped) return;
  if (Date.now() >= endAt) return stop('durée du protocole atteinte');
  const t = Date.now();
  let delay = nextAt - t;
  if (delay <= 0) {
    // Retard (réseau coupé, sommeil de l'appareil, cycle long) → on repart
    // immédiatement avec la cadence réinitialisée (pas de rafale de rattrapage).
    delay = 0;
    nextAt = t + INTERVAL_MS;
  } else {
    nextAt += INTERVAL_MS;
  }
  timer = setTimeout(loop, delay);
}

process.on('SIGINT', () => stop('interrompu par SIGINT (Ctrl+C)'));
process.on('SIGTERM', () => stop('interrompu par SIGTERM'));
process.on('uncaughtException', (e) => {
  console.error(`[probe] exception non capturée (la sonde continue) : ${errStr(e)}`);
});
process.on('unhandledRejection', (e) => {
  console.error(`[probe] promesse rejetée non capturée (la sonde continue) : ${errStr(e)}`);
});

loop();
