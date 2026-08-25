import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { ApiError, readToken } from './lib/api.ts';
import { Layout } from './components/Layout.tsx';
import { LoginPage } from './pages/Login.tsx';
import { CampaignsPage } from './pages/Campaigns.tsx';
import { CampaignEditor } from './pages/CampaignEditor.tsx';
import { OverviewTab } from './pages/campaign/Overview.tsx';
import { AudienceTab } from './pages/campaign/Audience.tsx';
import { MessagesTab } from './pages/campaign/Messages.tsx';
import { JourneyTab } from './pages/campaign/Journey.tsx';
import { ScheduleTab } from './pages/campaign/Schedule.tsx';
import { AnalyticsTab } from './pages/campaign/Analytics.tsx';
import { QueuePage } from './pages/Queue.tsx';
import { InspectPage } from './pages/Inspect.tsx';
import { ContactPage } from './pages/Contact.tsx';
import { MockOutboxPage } from './pages/MockOutbox.tsx';
import { InvariantsPage } from './pages/Invariants.tsx';

/**
 * Retry policy, stated once.
 *
 * A 4xx is the server saying "this request is wrong" — repeating it three times
 * produces the same answer three times and delays the operator seeing it. Only
 * 5xx and transport failures are worth another go.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status < 500) return false;
        return failureCount < 2;
      },
      staleTime: 10_000,
      refetchOnWindowFocus: false,
    },
  },
});

function RequireSession({ children }: { children: React.ReactNode }) {
  if (readToken() === null) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            element={
              <RequireSession>
                <Layout />
              </RequireSession>
            }
          >
            <Route index element={<Navigate to="/campaigns" replace />} />
            <Route path="/campaigns" element={<CampaignsPage />} />
            <Route path="/campaigns/:id" element={<CampaignEditor />}>
              <Route index element={<Navigate to="overview" replace />} />
              <Route path="overview" element={<OverviewTab />} />
              <Route path="audience" element={<AudienceTab />} />
              <Route path="messages" element={<MessagesTab />} />
              <Route path="journey" element={<JourneyTab />} />
              <Route path="schedule" element={<ScheduleTab />} />
              <Route path="analytics" element={<AnalyticsTab />} />
            </Route>
            <Route path="/queue" element={<QueuePage />} />
            <Route path="/inspect" element={<InspectPage />} />
            <Route path="/contacts/:id" element={<ContactPage />} />
            <Route path="/mock-outbox" element={<MockOutboxPage />} />
            <Route path="/invariants" element={<InvariantsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/campaigns" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
