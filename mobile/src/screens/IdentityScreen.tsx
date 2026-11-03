/**
 * Écran PROFIL — identité locale, canal du pont VPS, wipe
 */
import React, { useState } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { keyHue, shortKey } from "../core/crypto-rn";
import { useApp } from "../state/AppStore";

const C = {
  bg: "#0B0F0E",
  card: "#141A18",
  border: "#1F2A27",
  text: "#E7F0EC",
  dim: "#7C8F88",
  accent: "#10B981",
  bad: "#E11D48",
};

export default function IdentityScreen() {
  const { identity, nickname, setNickname, bridgeUrl, setBridgeUrl, resetIdentity } = useApp();
  const [nick, setNick] = useState(nickname);
  const [url, setUrl] = useState(bridgeUrl);

  const hue = identity ? keyHue(identity.pubkey) : 160;

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <View style={styles.headRow}>
          <View style={[styles.avatar, { backgroundColor: `hsl(${hue} 55% 42%)` }]}>
            <Text style={styles.avatarText}>
              {(nick || "?").slice(0, 2).toUpperCase()}
            </Text>
          </View>
          <View style={styles.headText}>
            <Text style={styles.title}>Identité locale</Text>
            <Text style={styles.sub}>
              {identity ? shortKey(identity.pubkey) : "génération…"}
            </Text>
          </View>
        </View>

        <Text style={styles.label}>Nickname (annoncé sur le mesh)</Text>
        <View style={styles.inlineForm}>
          <TextInput style={styles.input} value={nick} onChangeText={setNick} maxLength={24} />
          <Pressable
            style={styles.btn}
            onPress={() => {
              setNickname(nick);
              Alert.alert("Profil", `Nickname enregistré : ${nick.trim().slice(0, 24) || "anonyme"}`);
            }}
          >
            <Text style={styles.btnText}>OK</Text>
          </Pressable>
        </View>

        <Text style={styles.note}>
          Les clés privées (ECDSA + ECDH P-256) restent sur cet appareil. La clé
          publique sert d'identité — aucun numéro, aucun e-mail.
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>Pont VPS (optionnel)</Text>
        <Text style={styles.label}>URL du serveur Mbote</Text>
        <View style={styles.inlineForm}>
          <TextInput
            style={[styles.input, { flex: 1 }]}
            value={url}
            onChangeText={setUrl}
            placeholder="https://mon-vps.exemple"
            placeholderTextColor={C.dim}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <Pressable style={styles.btn} onPress={() => setBridgeUrl(url)}>
            <Text style={styles.btnText}>OK</Text>
          </Pressable>
        </View>
        <Text style={styles.note}>
          Dès qu'un internet est disponible, les paquets mesh accumulés sont
          remontés au pont (/api/mesh/bridge) puis purgés de la file locale.
        </Text>
      </View>

      <Pressable
        style={styles.dangerBtn}
        onPress={() =>
          Alert.alert(
            "Effacer l'identité ?",
            "Les clés locales seront détruites. Les messages déjà diffusés sur le mesh ne le seront pas.",
            [
              { text: "Annuler", style: "cancel" },
              { text: "Effacer", style: "destructive", onPress: () => resetIdentity() },
            ]
          )
        }
      >
        <Text style={styles.dangerText}>Effacer l'identité locale</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0B0F0E" },
  content: { padding: 12, gap: 12, paddingBottom: 40 },
  card: {
    backgroundColor: "#141A18",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#1F2A27",
    padding: 14,
    gap: 10,
  },
  headRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  headText: { gap: 2 },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: "#04110C", fontWeight: "900", fontSize: 16 },
  title: { color: "#E7F0EC", fontSize: 16, fontWeight: "800" },
  sub: { color: "#7C8F88", fontSize: 12 },
  label: { color: "#7C8F88", fontSize: 11, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.8 },
  inlineForm: { flexDirection: "row", gap: 8 },
  input: {
    flex: 1,
    backgroundColor: "#0B0F0E",
    borderWidth: 1,
    borderColor: "#1F2A27",
    borderRadius: 10,
    color: "#E7F0EC",
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 14,
  },
  btn: {
    backgroundColor: "#10B981",
    borderRadius: 10,
    paddingHorizontal: 18,
    justifyContent: "center",
  },
  btnText: { color: "#04110C", fontWeight: "800" },
  note: { color: "#7C8F88", fontSize: 12, lineHeight: 18 },
  dangerBtn: {
    borderWidth: 1,
    borderColor: "#E11D48",
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
  },
  dangerText: { color: "#E11D48", fontWeight: "700" },
});
