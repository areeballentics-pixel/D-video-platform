// PlayerScreen — placeholder until Tasks #9 (Android Kotlin) and #10 (iOS Swift)
// land. Once the native modules are installed, this screen:
//   1. Calls api.getVideoKey() to resolve key + download_url + content_hash
//   2. If the .svf isn't already cached locally, downloads it (RN fetch +
//      streaming-write via react-native-fs or expo-file-system)
//   3. Calls SvpVideoPlayer.play({ svfPath, keyHex, quality })
//   4. Renders the watermark overlay + ticks watch heartbeats every 15-30 s
//
// For now, it shows a "coming in Tasks #9/#10" message so the JS layer is
// shippable on its own and the navigation tree compiles.

import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { isNativeModuleInstalled, SvpVideoPlayer } from "@/native/SvpVideoPlayer";
import WatermarkOverlay from "@/components/WatermarkOverlay";
import { useAuthStore } from "@/store/authStore";
import { RootStackParamList } from "../navigation";

type Props = NativeStackScreenProps<RootStackParamList, "Player">;

export default function PlayerScreen({ route, navigation }: Props) {
  const { title } = route.params;
  const { email, licensedKeys } = useAuthStore();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isNativeModuleInstalled) {
      setError(
        "The native video module is not installed yet. Build the platform module from Task #9 (Android) or #10 (iOS).",
      );
      return;
    }
    SvpVideoPlayer.isReady()
      .then(setReady)
      .catch((e) => setError(String(e)));
  }, []);

  // The first licensed key entry is just a stand-in for v1 — the real flow
  // looks up a specific (video_id, quality) from `licensedKeys` after the
  // user picks a quality. Native module wiring lands in Tasks #9/#10.
  const licenseKeyShort =
    licensedKeys[0]?.key.slice(0, 8) ?? "no-license";

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={styles.back}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
      </View>

      <View style={styles.surface}>
        {error ? (
          <Text style={styles.errorText}>{error}</Text>
        ) : !ready ? (
          <>
            <ActivityIndicator color="#6366f1" />
            <Text style={styles.statusText}>Initialising player…</Text>
          </>
        ) : (
          <Text style={styles.statusText}>
            Native module ready. Wire `SvpVideoPlayer.play()` here.
          </Text>
        )}

        {email && (
          <WatermarkOverlay email={email} licenseKeyShort={licenseKeyShort} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingTop: 32,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  back: { color: "#94a3b8", fontSize: 15, paddingRight: 16 },
  title: { color: "#f1f5f9", fontSize: 17, fontWeight: "600", flexShrink: 1 },
  surface: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#0f172a",
    margin: 16,
    borderRadius: 12,
  },
  statusText: { color: "#94a3b8", marginTop: 12, fontSize: 14 },
  errorText: { color: "#fca5a5", padding: 16, textAlign: "center" },
});
