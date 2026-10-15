import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { AppProvider } from './AppContext';
import { App } from './App';
import { WordCardProvider } from './components/WordCards';
import { LearningPreferencesProvider } from './LearningPreferences';
import { basePath } from './lib/api';
import { installAudioLifecycle } from './lib/audio-manager';
import { PwaProvider } from './components/Pwa';
import { installAppBackBridge } from './lib/screen-lifecycle';
import './styles.css';
import './mobile.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15000, refetchOnWindowFocus: true, retry: false } },
});
installAppBackBridge();
installAudioLifecycle();
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename={basePath || '/'}>
        <AppProvider>
          <LearningPreferencesProvider>
            <PwaProvider>
              <WordCardProvider>
                <App />
              </WordCardProvider>
            </PwaProvider>
          </LearningPreferencesProvider>
        </AppProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
