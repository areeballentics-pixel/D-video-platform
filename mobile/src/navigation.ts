// Centralised navigation type so every screen gets type-safe params.
// react-navigation v7's pattern.

export type RootStackParamList = {
  Login: undefined;
  Library: undefined;
  CourseDetail: { courseId: string };
  Player: { videoId: string; title: string; courseId?: string };
  Downloads: undefined;
  Settings: undefined;
};
