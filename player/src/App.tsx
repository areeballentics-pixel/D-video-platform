import UpdateBanner from "./components/UpdateBanner";
import { useEffect } from "react";
import { Routes, Route, Navigate, useNavigate, useLocation } from "react-router-dom";
import LoginPage from "./pages/LoginPage";
import LibraryPage from "./pages/LibraryPage";
import PlayerPage from "./pages/PlayerPage";
import SettingsPage from "./pages/SettingsPage";
import { useAuthStore } from "./store/authStore";

/** Route guard — redirects to /login if not authenticated */
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { authenticated, loading } = useAuthStore();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--color-primary)] border-t-transparent" />
      </div>
    );
  }

  if (!authenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <>{children}</>;
}

function App() {
  const { initialize, authenticated } = useAuthStore();
  const navigate = useNavigate();
  const location = useLocation();

  // Check auth status on app load
  useEffect(() => {
    initialize();
  }, [initialize]);

  // If user is authenticated and on login page, redirect to library
  useEffect(() => {
    if (authenticated && location.pathname === "/login") {
      navigate("/library", { replace: true });
    }
  }, [authenticated, location.pathname, navigate]);

  return (
    <div className="h-screen w-screen bg-[var(--color-bg)] text-[var(--color-text)]">
      <UpdateBanner />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/library" element={<ProtectedRoute><LibraryPage /></ProtectedRoute>} />
        <Route path="/player" element={<ProtectedRoute><PlayerPage /></ProtectedRoute>} />
        <Route path="/settings" element={<ProtectedRoute><SettingsPage /></ProtectedRoute>} />
        <Route path="*" element={<Navigate to="/library" replace />} />
      </Routes>
    </div>
  );
}

export default App;
