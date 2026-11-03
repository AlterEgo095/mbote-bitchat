/**
 * Écran CHAT — fil mesh local + composer (posts signés)
 */
import React, { useCallback, useState } from "react";
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useApp, type MeshMessage } from "../state/AppStore";

const C = {
  bg: "#0B0F0E",
  card: "#141A18",
  cardAlt: "#101615",
  border: "#1F2A27",
  text: "#E7F0EC",
  dim: "#7C8F88",
  accent: "#10B981",
  mine: "#0E2A22",
};

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `il y a ${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `il y a ${m} min`;
  return `il y a ${Math.floor(m / 60)} h`;
}

function MessageRow({ item }: { item: MeshMessage }) {
  return (
    <View style={[styles.row, item.mine && styles.rowMine]}>
      <View style={styles.bubble}>
        <View style={styles.bubbleHead}>
          <Text style={[styles.author, item.mine && { color: C.accent }]}>
            {item.mine ? "Moi" : item.nickname}
          </Text>
          <Text style={styles.meta}>
            {timeAgo(item.at)}
            {item.hops > 0 ? `  ·  ${item.hops} saut${item.hops > 1 ? "s" : ""}` : ""}
            {item.rssi > 0 && item.rssi !== 127 ? `  ·  ${item.rssi} dBm` : ""}
          </Text>
        </View>
        <Text style={styles.content}>{item.content}</Text>
      </View>
    </View>
  );
}

export default function ChatScreen() {
  const { messages, sendPost, meshState, peers, bridgeQueueSize, syncBridge, bridgeUrl } = useApp();
  const [draft, setDraft] = useState("");
  const [syncing, setSyncing] = useState(false);

  const onSend = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    try {
      await sendPost(text);
    } catch (t) {
      Alert.alert("Échec d'envoi", t instanceof Error ? t.message : "erreur inconnue");
    }
  }, [draft, sendPost]);

  const onSync = useCallback(async () => {
    setSyncing(true);
    try {
      const msg = await syncBridge();
      Alert.alert("Pont VPS", msg);
    } finally {
      setSyncing(false);
    }
  }, [syncBridge]);

  const online = meshState === "running";

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={90}
    >
      <View style={styles.statusBar}>
        <View style={[styles.dot, { backgroundColor: online ? C.accent : "#E11D48" }]} />
        <Text style={styles.statusText}>
          {online ? `mesh actif — ${peers.length} voisin${peers.length > 1 ? "s" : ""}` : `mesh : ${meshState}`}
        </Text>
        <Pressable onPress={onSync} disabled={syncing || !bridgeUrl} style={styles.syncBtn}>
          <Text style={styles.syncText}>
            {syncing ? "…" : bridgeUrl ? `Pont VPS${bridgeQueueSize ? ` (${bridgeQueueSize})` : ""}` : "Pont off"}
          </Text>
        </Pressable>
      </View>

      <FlatList
        data={messages}
        keyExtractor={(m) => m.id}
        renderItem={({ item }) => <MessageRow item={item} />}
        inverted
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>Aucun message pour l'instant</Text>
            <Text style={styles.emptyText}>
              Approchez deux téléphones avec le Bluetooth activé : les messages
              circulent de proche en proche, sans internet.
            </Text>
          </View>
        }
      />

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="Message pour le mesh local…"
          placeholderTextColor={C.dim}
          multiline
          maxLength={500}
        />
        <Pressable style={[styles.sendBtn, !draft.trim() && { opacity: 0.4 }]} onPress={onSend}>
          <Text style={styles.sendText}>Envoyer</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  statusBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    gap: 8,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { flex: 1, color: C.dim, fontSize: 12 },
  syncBtn: {
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: C.cardAlt,
  },
  syncText: { color: C.accent, fontSize: 11, fontWeight: "600" },
  list: { padding: 12, paddingBottom: 24 },
  row: { marginBottom: 10, flexDirection: "row" },
  rowMine: { justifyContent: "flex-end" },
  bubble: {
    maxWidth: "88%",
    backgroundColor: C.card,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: C.border,
  },
  bubbleHead: { flexDirection: "row", alignItems: "baseline", gap: 8, marginBottom: 2 },
  author: { color: C.text, fontWeight: "700", fontSize: 13 },
  meta: { color: C.dim, fontSize: 10 },
  content: { color: C.text, fontSize: 15, lineHeight: 20 },
  empty: { padding: 32, alignItems: "center", gap: 8 },
  emptyTitle: { color: C.text, fontSize: 16, fontWeight: "700", textAlign: "center" },
  emptyText: { color: C.dim, fontSize: 13, textAlign: "center", lineHeight: 19 },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    padding: 10,
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: C.border,
    backgroundColor: C.cardAlt,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 110,
    backgroundColor: C.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    color: C.text,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 15,
  },
  sendBtn: {
    backgroundColor: C.accent,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  sendText: { color: "#04110C", fontWeight: "800", fontSize: 14 },
});
