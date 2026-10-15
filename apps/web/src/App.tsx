import { Component, lazy, Suspense, type ReactNode } from 'react';
import { Route, Routes, Link, type Location } from 'react-router-dom';
import { Shell } from './components/Shell';
import { useApp } from './AppContext';
import {
  AppNavigationProvider,
  useAppNavigation,
  type AppScreen,
} from './components/AppNavigation';
import { AppViewportProvider } from './components/AppViewport';
import { ScreenActiveProvider } from './lib/screen-lifecycle';
import { AppScreenSurface } from './components/AppScreenSurface';
import { Empty, Loading } from './components/UI';
import { HomePage, BooksPage } from './pages/Home';

const H5LearningPage = lazy(() =>
  import('./pages/H5Learning').then((page) => ({ default: page.H5LearningPage })),
);
const StudyPage = lazy(() => import('./pages/Study').then((page) => ({ default: page.StudyPage })));
const LookupPage = lazy(() =>
  import('./pages/Lookup').then((page) => ({ default: page.LookupPage })),
);
const KnownPage = lazy(() => import('./pages/Known').then((page) => ({ default: page.KnownPage })));
const AssessmentPage = lazy(() =>
  import('./pages/Assessment').then((page) => ({ default: page.AssessmentPage })),
);
const MemoryPage = lazy(() =>
  import('./pages/Memory').then((page) => ({ default: page.MemoryPage })),
);
const AuthPage = lazy(() => import('./pages/Account').then((page) => ({ default: page.AuthPage })));
const ProfilePage = lazy(() =>
  import('./pages/Account').then((page) => ({ default: page.ProfilePage })),
);
const SetupPage = lazy(() =>
  import('./pages/Account').then((page) => ({ default: page.SetupPage })),
);
const AdminPage = lazy(() => import('./pages/Admin').then((page) => ({ default: page.AdminPage })));
const TranslationPage = lazy(() =>
  import('./components/Translation').then((page) => ({ default: page.TranslationPage })),
);
const CustomBookImportPage = lazy(() =>
  import('./pages/CustomBooks').then((page) => ({ default: page.CustomBookImportPage })),
);
const MyBooksPage = lazy(() =>
  import('./pages/CustomBooks').then((page) => ({ default: page.MyBooksPage })),
);
const DictionaryPage = lazy(() =>
  import('./pages/Dictionary').then((page) => ({ default: page.DictionaryPage })),
);
const ContentPage = lazy(() =>
  import('./pages/Content').then((page) => ({ default: page.ContentPage })),
);
const LearningLibraryPage = lazy(() =>
  import('./pages/LearningLibrary').then((page) => ({ default: page.LearningLibraryPage })),
);
const SentencesPage = lazy(() =>
  import('./pages/LearningLibrary').then((page) => ({ default: page.SentencesPage })),
);
const NotesPage = lazy(() =>
  import('./pages/LearningLibrary').then((page) => ({ default: page.NotesPage })),
);
const AcademyPage = lazy(() =>
  import('./pages/Academy').then((page) => ({ default: page.AcademyPage })),
);

class PageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="page">
        <Empty
          title="页面暂时没有打开。"
          description="重新载入当前页后继续。"
          action={
            <button className="button primary" onClick={() => window.location.reload()}>
              重新载入当前页
            </button>
          }
        />
      </div>
    );
  }
}

export function ScreenRoutes({ location }: { location: Location }) {
  return (
    <Suspense
      fallback={
        <div className="page">
          <Loading text="正在打开页面…" />
        </div>
      }
    >
      <Routes location={location}>
        <Route path="/" element={<HomePage />} />
        <Route path="learning" element={<H5LearningPage />} />
        <Route path="books" element={<BooksPage />} />
        <Route path="books/import" element={<CustomBookImportPage />} />
        <Route path="books/mine" element={<MyBooksPage />} />
        <Route path="content" element={<ContentPage />} />
        <Route path="library" element={<LearningLibraryPage />} />
        <Route path="sentences" element={<SentencesPage />} />
        <Route path="notes" element={<NotesPage />} />
        <Route path="academy" element={<AcademyPage />} />
        <Route path="learn" element={<StudyPage key="learn" mode="learn" />} />
        <Route path="review" element={<StudyPage key="review" mode="review" />} />
        <Route path="lookup" element={<LookupPage key="lookup" />} />
        <Route path="dictionary" element={<DictionaryPage />} />
        <Route path="wordbook" element={<LookupPage key="wordbook" initialTab="wordbook" />} />
        <Route path="translate" element={<TranslationPage />} />
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
      </Routes>
    </Suspense>
  );
}

export function renderAppScreen(screen: AppScreen) {
  return (
    <ScreenActiveProvider key={screen.id} value={screen.active}>
      <AppScreenSurface screen={screen}>
        <PageBoundary>
          <ScreenRoutes location={screen.location} />
        </PageBoundary>
      </AppScreenSurface>
    </ScreenActiveProvider>
  );
}

function ApplicationScreens() {
  const { screens, transitioning } = useAppNavigation();
  return (
    <div className="h5-screen-stack" inert={transitioning} data-transitioning={transitioning}>
      {screens.map(renderAppScreen)}
      {transitioning && <div className="h5-transition-shield" aria-hidden="true" />}
    </div>
  );
}

export function App() {
  const { scope } = useApp();
  return (
    <AppViewportProvider>
      <AppNavigationProvider key={scope}>
        <Shell>
          <ApplicationScreens />
        </Shell>
      </AppNavigationProvider>
    </AppViewportProvider>
  );
}
