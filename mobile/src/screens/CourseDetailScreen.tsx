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
import { CourseVideo } from "@/lib/types";
import { RootStackParamList } from "../navigation";

type Props = NativeStackScreenProps<RootStackParamList, "CourseDetail">;

function formatDuration(ms: number): string {
  if (!ms) return "—";
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function CourseDetailScreen({ route, navigation }: Props) {
  const { courseId } = route.params;
  const { courses, videosByCourse, loadCourseVideos } = useCoursesStore();
  const course = courses.find((c) => c.id === courseId);
  const videos = videosByCourse[courseId];

  useEffect(() => {
    loadCourseVideos(courseId);
  }, [courseId, loadCourseVideos]);

  const renderVideo = ({ item }: { item: CourseVideo }) => (
    <TouchableOpacity
      style={styles.video}
      onPress={() =>
        navigation.navigate("Player", {
          videoId: item.video_id,
          title: item.title,
          courseId,
        })
      }
    >
      <View style={styles.videoText}>
        <Text style={styles.videoTitle}>{item.title}</Text>
        <Text style={styles.videoMeta}>
          {item.qualities.join(" / ") || "—"} · {formatDuration(item.duration_ms)}
          {item.is_free_preview ? " · Free preview" : ""}
        </Text>
      </View>
      <Text style={styles.statusBadge}>
        {item.status === "live"
          ? "▶"
          : item.status === "pending_urls"
          ? "⏳"
          : "—"}
      </Text>
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>{course?.name ?? "Course"}</Text>
        {course?.description ? (
          <Text style={styles.description}>{course.description}</Text>
        ) : null}
      </View>

      {!videos ? (
        <ActivityIndicator color="#6366f1" style={{ marginTop: 32 }} />
      ) : (
        <FlatList
          data={videos.sort((a, b) => a.display_order - b.display_order)}
          keyExtractor={(v) => v.video_id}
          renderItem={renderVideo}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <Text style={styles.empty}>
              No videos in this course yet.
            </Text>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#020617" },
  header: { padding: 20 },
  title: { color: "#f1f5f9", fontSize: 22, fontWeight: "700" },
  description: { color: "#94a3b8", marginTop: 8, fontSize: 14 },
  list: { padding: 16 },
  video: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#0f172a",
    borderColor: "#1e293b",
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    marginBottom: 10,
  },
  videoText: { flex: 1 },
  videoTitle: { color: "#f1f5f9", fontSize: 15, fontWeight: "600" },
  videoMeta: { color: "#94a3b8", fontSize: 12, marginTop: 4 },
  statusBadge: { color: "#94a3b8", fontSize: 18, marginLeft: 12 },
  empty: { color: "#64748b", textAlign: "center", paddingTop: 32 },
});
