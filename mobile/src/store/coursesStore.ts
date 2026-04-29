import { create } from "zustand";
import { api } from "@/lib/api";
import { Course, CourseVideo } from "@/lib/types";
import { cache } from "@/lib/storage";

interface CoursesState {
  courses: Course[];
  videosByCourse: Record<string, CourseVideo[]>;
  loading: boolean;
  error: string | null;
  loadCourses: () => Promise<void>;
  loadCourseVideos: (courseId: string) => Promise<void>;
}

const CACHE_KEY = "courses_v1";

export const useCoursesStore = create<CoursesState>((set, get) => ({
  courses: [],
  videosByCourse: {},
  loading: false,
  error: null,

  loadCourses: async () => {
    set({ loading: true, error: null });
    // Show cached data immediately while we revalidate.
    const cached = cache.getString(CACHE_KEY);
    if (cached) {
      try {
        set({ courses: JSON.parse(cached) as Course[] });
      } catch {
        // ignore parse errors
      }
    }
    try {
      const courses = await api.listMyCourses();
      cache.set(CACHE_KEY, JSON.stringify(courses));
      set({ courses, loading: false });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : "Failed to load courses",
        loading: false,
      });
    }
  },

  loadCourseVideos: async (courseId) => {
    if (get().videosByCourse[courseId]?.length) return; // cached for this session
    try {
      const videos = await api.listCourseVideos(courseId);
      set((s) => ({
        videosByCourse: { ...s.videosByCourse, [courseId]: videos },
      }));
    } catch (err) {
      set({
        error:
          err instanceof Error ? err.message : "Failed to load course videos",
      });
    }
  },
}));
