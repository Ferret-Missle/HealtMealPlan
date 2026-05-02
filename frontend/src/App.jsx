import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './hooks/useAuth';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import TermsPage from './pages/TermsPage';
import PrivacyPage from './pages/PrivacyPage';
import DashboardPage from './pages/DashboardPage';
import MealPlanPage from './pages/MealPlanPage';
import ShoppingListPage from './pages/ShoppingListPage';
import MyPage from './pages/MyPage';
import MealLogPage from './pages/MealLogPage';   // 旧食事ページ（直リンク用に残す）
import InvitePage, { INVITE_TOKEN_KEY } from './pages/InvitePage';
import ChatWidget from './components/ChatWidget';
import './App.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 60_000, retry: 1 } },
});

function PrivateRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="loading-screen"><div className="spinner" /></div>;
  return user ? children : <Navigate to="/login" replace />;
}

function PublicRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="loading-screen"><div className="spinner" /></div>;
  if (user) {
    // ログイン後に保留中の招待があればそちらへ
    const pendingInvite = sessionStorage.getItem(INVITE_TOKEN_KEY);
    if (pendingInvite) return <Navigate to={`/invite/${pendingInvite}`} replace />;
    return <Navigate to="/" replace />;
  }
  return children;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login"    element={<PublicRoute><LoginPage /></PublicRoute>} />
            <Route path="/register" element={<PublicRoute><RegisterPage /></PublicRoute>} />
            {/* 招待リンク — ログイン不要（未ログインなら認証を促す） */}
            <Route path="/invite/:token" element={<InvitePage />} />
            {/* 利用規約・プライバシーポリシーはログイン不要で常にアクセス可能 */}
            <Route path="/terms"    element={<TermsPage />} />
            <Route path="/privacy"  element={<PrivacyPage />} />
            <Route path="/" element={<PrivateRoute><Layout><ChatWidget /></Layout></PrivateRoute>}>
              {/* ── 3 main modes ── */}
              <Route index         element={<DashboardPage />} />
              <Route path="plan"   element={<MealPlanPage />} />
              <Route path="list"   element={<ShoppingListPage />} />
              <Route path="me"     element={<MyPage />} />
              {/* ── Legacy / utility routes ── */}
              <Route path="meals"     element={<MealLogPage />} />
              <Route path="body"      element={<Navigate to="/me" replace />} />
              <Route path="group"     element={<Navigate to="/me" replace />} />
              <Route path="settings"  element={<Navigate to="/me" replace />} />
              <Route path="meal-plan" element={<Navigate to="/plan" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}
