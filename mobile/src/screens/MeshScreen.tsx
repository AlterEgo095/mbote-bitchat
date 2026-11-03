/**
 * Écran MESH — radio, pairs BLE, journal du protocole
 */
import React from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useApp } from "../state/AppStore";

const C = {
  bg: "#0B0F0E",
  card: "#141A18",
  border: "#1F2A27",
  text: "#E7F0EC",
  dim: "#7C8F88",
  accent: "#10B981",
  warn: "#F59E0B",
  bad: "#E11D48",
};

function stateColor(state: string): string {
  if (state === "running") return C.accent;
  if (state === "starting") return C.warn;
  if (state === "stopped") return C.dim;
  return C.bad;
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      {children}
    </View>
  );
}

export default function MeshScreen() {
  const { meshState, peers, logs, transport } = useApp();
  const color = stateColor(meshState);

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Card title="Radio">
        <View style={styles.stateRow}>
          <View style={[styles.dot, { backgroundColor: color }]} />
          <Text style={[styles.stateText, { color }]}>{meshState}</Text>
        </View>
        <Text style={styles.line}>
          Service GATT · F7C41D5A… · dual-rôle (central + périphérique)
        </Text>
        <Text style={styles.line}>
          TTL max 7 · gigue 10–220 ms · dédup LRU {1000} entrées
        </Text>
      </Card>

      <Card title={`Pairs (${peers.length})`}>
        {peers.length === 0 && (
          <Text style={styles.line}>
            Aucun voisin. Lancez Mbote sur un second téléphone à proximité.
          </Text>
        )}
        {peers.map((p) => (
          <View key={p.peerId} style={styles.peer}>
            <Text style={styles.peerId}>{p.peerId.slice(0, 17)}</Text>
            <Text style={styles.peerMeta}>
              {(p.roles ?? []).join("+") || "?"} · {p.rssi !== 127 ? `${p.rssi} dBm` : "rssi ?"}
            </Text>
          </View>
        ))}
      </Card>

      <Card title={`Journal (${logs.length})`}>
        {logs.length === 0 && <Text style={styles.line}>Silence radio…</Text>}
        {logs.map((l, i) => (
          <Text key={`${i}-${l.slice(0, 8)}`} style={styles.logLine}>
            {l}
          </Text>
        ))}
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0B0F0E" },
  content: { padding: 12, gap: 12, paddingBottom: 32 },
  card: {
    backgroundColor: "#141A18",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#1F2A27",
    padding: 14,
    gap: 6,
  },
  cardTitle: { color: "#7C8F88", fontSize: 12, fontWeight: "800", textTransform: "uppercase", letterSpacing: 1 },
  stateRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  stateText: { fontSize: 17, fontWeight: "800" },
  line: { color: "#7C8F88", fontSize: 12, lineHeight: 18 },
  peer: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: "#1F2A27",
  },
  peerId: { color: "#E7F0EC", fontFamily: undefined, fontWeight: "700", fontSize: 13 },
  peerMeta: { color: "#7C8F88", fontSize: 11 },
  logLine: { color: "#5C6F68", fontSize: 10, fontFamily: undefined },
});
