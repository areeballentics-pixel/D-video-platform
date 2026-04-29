import { useState } from "react";
import {
  Alert,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useAuthStore } from "@/store/authStore";
import { cache } from "@/lib/storage";

export default function SettingsScreen() {
  const { email, tenantId, logout } = useAuthStore();
  const [hapticOn, setHapticOn] = useState(
    cache.getBoolean("haptic_on") ?? true,
  );

  const toggleHaptic = (v: boolean) => {
    setHapticOn(v);
    cache.set("haptic_on", v);
  };

  const handleLogout = () => {
    Alert.alert("Sign out", "Are you sure? You'll need to sign in again to play videos.", [
      { text: "Cancel", style: "cancel" },
      { text: "Sign out", style: "destructive", onPress: logout },
    ]);
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Settings</Text>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Account</Text>
        <Row label="Email" value={email ?? "—"} />
        <Row
          label="Tenant"
          value={tenantId ? `${tenantId.slice(0, 8)}…` : "—"}
        />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Preferences</Text>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Haptic feedback on tap</Text>
          <Switch value={hapticOn} onValueChange={toggleHaptic} />
        </View>
      </View>

      <TouchableOpacity style={styles.dangerButton} onPress={handleLogout}>
        <Text style={styles.dangerText}>Sign out</Text>
      </TouchableOpacity>
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, backgroundColor: "#020617" },
  title: {
    color: "#f1f5f9",
    fontSize: 22,
    fontWeight: "700",
    marginBottom: 24,
  },
  section: {
    backgroundColor: "#0f172a",
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  sectionLabel: {
    color: "#94a3b8",
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 8,
  },
  rowLabel: { color: "#cbd5e1", fontSize: 14 },
  rowValue: { color: "#f1f5f9", fontSize: 14, fontWeight: "500" },
  dangerButton: {
    marginTop: "auto",
    backgroundColor: "rgba(127,29,29,0.3)",
    borderRadius: 10,
    padding: 14,
    alignItems: "center",
    borderColor: "rgba(220,38,38,0.4)",
    borderWidth: 1,
  },
  dangerText: { color: "#fca5a5", fontWeight: "600", fontSize: 15 },
});
