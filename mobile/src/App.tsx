import { useEffect } from "react";
import { StatusBar, View, ActivityIndicator, StyleSheet } from "react-native";
import { NavigationContainer, DefaultTheme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { useAuthStore } from "@/store/authStore";
import LoginScreen from "@/screens/LoginScreen";
import LibraryScreen from "@/screens/LibraryScreen";
import CourseDetailScreen from "@/screens/CourseDetailScreen";
import PlayerScreen from "@/screens/PlayerScreen";
import DownloadsScreen from "@/screens/DownloadsScreen";
import SettingsScreen from "@/screens/SettingsScreen";
import { RootStackParamList } from "./navigation";

const Stack = createNativeStackNavigator<RootStackParamList>();

const navTheme = {
  ...DefaultTheme,
  dark: true,
  colors: {
    ...DefaultTheme.colors,
    background: "#020617",
    card: "#0f172a",
    text: "#f1f5f9",
    border: "#1e293b",
    primary: "#6366f1",
    notification: "#f43f5e",
  },
};

export default function App() {
  const { ready, authenticated, initialize } = useAuthStore();

  useEffect(() => {
    initialize();
  }, [initialize]);

  if (!ready) {
    return (
      <View style={styles.splash}>
        <StatusBar barStyle="light-content" />
        <ActivityIndicator color="#6366f1" />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor="#020617" />
      <NavigationContainer theme={navTheme}>
        <Stack.Navigator
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: "#020617" },
          }}
        >
          {authenticated ? (
            <>
              <Stack.Screen name="Library" component={LibraryScreen} />
              <Stack.Screen
                name="CourseDetail"
                component={CourseDetailScreen}
              />
              <Stack.Screen name="Player" component={PlayerScreen} />
              <Stack.Screen name="Downloads" component={DownloadsScreen} />
              <Stack.Screen name="Settings" component={SettingsScreen} />
            </>
          ) : (
            <Stack.Screen name="Login" component={LoginScreen} />
          )}
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#020617",
  },
});
