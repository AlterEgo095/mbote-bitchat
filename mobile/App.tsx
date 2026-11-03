/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Mbote BitChat — App mobile (React Native / Expo)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Point d'entrée : les polyfills Hermes DOIVENT être importés en premier
 *  (TextEncoder/TextDecoder/getRandomValues utilisés par le cœur du protocole).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import "./polyfills";

import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";

import { AppProvider } from "./src/state/AppStore";
import ChatScreen from "./src/screens/ChatScreen";
import MeshScreen from "./src/screens/MeshScreen";
import IdentityScreen from "./src/screens/IdentityScreen";

type TabKey = "chat" | "mesh" | "profil";

const TABS: { key: TabKey; label: string }[] = [
  { key: "chat", label: "Chat" },
  { key: "mesh", label: "Mesh" },
  { key: "profil", label: "Profil" },
];

function Shell() {
  const [tab, setTab] = useState<TabKey>("chat");

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.logo}>mbote</Text>
        <Text style={styles.tag}>mesh sans internet · BitChat</Text>
      </View>

      <View style={styles.body}>
        {tab === "chat" && <ChatScreen />}
        {tab === "mesh" && <MeshScreen />}
        {tab === "profil" && <IdentityScreen />}
      </View>

      <View style={styles.tabbar}>
        {TABS.map((t) => (
          <Pressable
            key={t.key}
            style={[styles.tab, tab === t.key && styles.tabActive]}
            onPress={() => setTab(t.key)}
            accessibilityRole="tab"
            accessibilityLabel={t.label}
          >
            <Text style={[styles.tabText, tab === t.key && styles.tabTextActive]}>
              {t.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export default function App() {
  return (
    <AppProvider>
      <StatusBar style="light" />
      <Shell />
    </AppProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0B0F0E" },
  header: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#1F2A27",
  },
  logo: { color: "#10B981", fontSize: 22, fontWeight: "900", letterSpacing: 1 },
  tag: { color: "#7C8F88", fontSize: 11 },
  body: { flex: 1 },
  tabbar: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderTopColor: "#1F2A27",
    backgroundColor: "#101615",
  },
  tab: { flex: 1, alignItems: "center", paddingVertical: 14 },
  tabActive: { borderTopWidth: 2, borderTopColor: "#10B981", marginTop: -1 },
  tabText: { color: "#7C8F88", fontSize: 13, fontWeight: "600" },
  tabTextActive: { color: "#10B981", fontWeight: "800" },
});
