'use client';

import GodSectionPage from './components/GodSectionPage';
import GodSettingsGate from './components/GodSettingsGate';
import GodSentryConnection from './components/sentry/GodSentryConnection';
import GodSentryRoutes from './components/sentry/GodSentryRoutes';
import { useSentrySettingsQuery } from './services/sentry.service';

export default function GodSentryPage() {
  const query = useSentrySettingsQuery();

  return (
    <GodSettingsGate slug="sentry" data={query.data}>
      {(settings) => (
        <GodSectionPage slug="sentry">
          <div className="space-y-10">
            <GodSentryConnection settings={settings} />
            <GodSentryRoutes />
          </div>
        </GodSectionPage>
      )}
    </GodSettingsGate>
  );
}
