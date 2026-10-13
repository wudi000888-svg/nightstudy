import { Route, Routes, Link } from 'react-router-dom';
import { Shell } from './components/Shell';
import { Empty } from './components/UI';
import { HomePage, BooksPage } from './pages/Home';
import { StudyPage } from './pages/Study';
import { LookupPage } from './pages/Lookup';
import { KnownPage } from './pages/Known';
import { AssessmentPage } from './pages/Assessment';
import { MemoryPage } from './pages/Memory';
import { AuthPage, ProfilePage, SetupPage } from './pages/Account';
import { AdminPage } from './pages/Admin';

export function App() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<HomePage />} />
        <Route path="books" element={<BooksPage />} />
        <Route path="learn" element={<StudyPage key="learn" mode="learn" />} />
        <Route path="review" element={<StudyPage key="review" mode="review" />} />
        <Route path="lookup" element={<LookupPage />} />
        <Route path="wordbook" element={<LookupPage />} />
        <Route path="known" element={<KnownPage />} />
        <Route path="assessment" element={<AssessmentPage />} />
        <Route path="memory" element={<MemoryPage />} />
        <Route path="stats" element={<MemoryPage />} />
        <Route path="auth" element={<AuthPage />} />
        <Route path="auth/login" element={<AuthPage />} />
        <Route path="me" element={<ProfilePage />} />
        <Route path="setup" element={<SetupPage />} />
        <Route path="admin/*" element={<AdminPage />} />
        <Route
          path="*"
          element={
            <div className="page">
              <Empty
                title="这页还没有打开。"
                description="回到自习室，从已有的页面继续。"
                action={
                  <Link className="button primary" to="/">
                    回自习室
                  </Link>
                }
              />
            </div>
          }
        />
      </Route>
    </Routes>
  );
}
