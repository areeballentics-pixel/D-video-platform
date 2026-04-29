import { StyleSheet, Text, View } from "react-native";

// Downloads — list of locally-cached .svf files with size + last-played time.
// v1.1 wiring: the player keeps a small JSON index in MMKV under
// `downloaded_videos_v1` listing { videoId, quality, sizeBytes, downloadedAt }.
// This screen renders that index. Until the native player module lands and
// downloads happen, it's an empty-state placeholder.

export default function DownloadsScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Downloads</Text>
      <Text style={styles.subtitle}>
        Your downloaded videos appear here. Anything downloaded plays even
        without internet (within your institute&rsquo;s offline grace period).
      </Text>
      <View style={styles.empty}>
        <Text style={styles.emptyText}>No downloads yet.</Text>
        <Text style={styles.emptyHint}>
          Tap the download icon on any video to save it for offline playback.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, backgroundColor: "#020617" },
  title: { color: "#f1f5f9", fontSize: 22, fontWeight: "700" },
  subtitle: { color: "#94a3b8", fontSize: 14, marginTop: 8, marginBottom: 24 },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#0f172a",
    borderRadius: 12,
    padding: 24,
  },
  emptyText: { color: "#cbd5e1", fontSize: 16, fontWeight: "600" },
  emptyHint: {
    color: "#64748b",
    fontSize: 13,
    marginTop: 8,
    textAlign: "center",
  },
});
