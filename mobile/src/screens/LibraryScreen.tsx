import { useEffect } from "react";
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCoursesStore } from "@/store/coursesStore";
import { useAuthStore } from "@/store/authStore";
import { Course } from "@/lib/types";
import { RootStackParamList } from "../navigation";

type Props = NativeStackScreenProps<RootStackParamList, "Library">;

export default function LibraryScreen({ navigation }: Props) {
  const { courses, loading, error, loadCourses } = useCoursesStore();
  const logout = useAuthStore((s) => s.logout);

  useEffect(() => {
    loadCourses();
  }, [loadCourses]);

  const renderItem = ({ item }: { item: Course }) => (
    <TouchableOpacity
      style={styles.card}
      onPress={() => navigation.navigate("CourseDetail", { courseId: item.id })}
    >
      <Text style={styles.cardTitle}>{item.name}</Text>
      <Text style={styles.cardMeta}>
        {item.video_count} videos · {item.is_published ? "Published" : "Draft"}
      </Text>
      {item.description ? (
        <Text style={styles.cardDescription} numberOfLines={2}>
          {item.description}
        </Text>
      ) : null}
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Your courses</Text>
        <TouchableOpacity onPress={logout}>
          <Text style={styles.signOut}>Sign out</Text>
        </TouchableOpacity>
      </View>

      {error && <Text style={styles.error}>{error}</Text>}

      {loading && courses.length === 0 ? (
        <ActivityIndicator color="#6366f1" style={{ marginTop: 32 }} />
      ) : (
        <FlatList
          data={courses}
          keyExtractor={(c) => c.id}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <Text style={styles.empty}>
              No courses yet. Ask your institute&rsquo;s admin to enroll you.
            </Text>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#020617" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 20,
    paddingTop: 28,
  },
  title: { color: "#f1f5f9", fontSize: 22, fontWeight: "700" },
  signOut: { color: "#94a3b8", fontSize: 14 },
  list: { padding: 16 },
  card: {
    backgroundColor: "#0f172a",
    borderColor: "#1e293b",
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  cardTitle: { color: "#f1f5f9", fontSize: 16, fontWeight: "600" },
  cardMeta: { color: "#94a3b8", fontSize: 12, marginTop: 4 },
  cardDescription: { color: "#cbd5e1", fontSize: 13, marginTop: 8 },
  error: {
    color: "#fca5a5",
    margin: 16,
    padding: 10,
    backgroundColor: "rgba(127,29,29,0.4)",
    borderRadius: 6,
    fontSize: 13,
  },
  empty: {
    color: "#64748b",
    textAlign: "center",
    fontSize: 14,
    paddingTop: 48,
  },
});
