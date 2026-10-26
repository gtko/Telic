import { useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import type { SentrySettings } from '@/lib/api/endpoints/sentry';
import CopyableValue from '@/components/common/page/CopyableValue';
import SecretInput from '@/components/common/inputs/SecretInput';
import SettingsCard from '@/components/common/page/SettingsCard';
import SettingsSection from '@/components/common/page/SettingsSection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useUpdateSentrySettings } from '../../services/sentry.service';

export default function GodSentryConnection({ settings }: { settings: SentrySettings }) {
  const t = useTranslations('god.sentry');
  const tCommon = useTranslations('common');
  const update = useUpdateSentrySettings();
  const [orgSlug, setOrgSlug] = useState(settings.orgSlug);
  const [authToken, setAuthToken] = useState('');
  const [clientSecret, setClientSecret] = useState('');

  const dirty = orgSlug !== settings.orgSlug || authToken !== '' || clientSecret !== '';

  async function save() {
    try {
      await update.mutateAsync({
        orgSlug,
        ...(authToken ? { authToken } : {}),
        ...(clientSecret ? { clientSecret } : {}),
      });
      toast.success(t('saved'));
    } catch {
      // The failure is already toasted by the global mutation error handler.
    }
  }

  return (
    <SettingsSection
      title={t('connection')}
      description={t(
        settings.hasAuthToken && settings.hasClientSecret ? 'configured' : 'notConfigured',
      )}
      action={
        <Button size="sm" onClick={() => void save()} disabled={!dirty || update.isPending}>
          {update.isPending ? tCommon('saving') : tCommon('save')}
        </Button>
      }
    >
      <SettingsCard className="space-y-6 p-4">
        <div className="space-y-1.5 sm:max-w-md">
          <Label htmlFor="sentry-org">{t('orgSlug')}</Label>
          <Input id="sentry-org" value={orgSlug} onChange={(e) => setOrgSlug(e.target.value)} />
        </div>
        <div className="space-y-1.5 sm:max-w-md">
          <Label htmlFor="sentry-token">{t('authToken')}</Label>
          <SecretInput
            id="sentry-token"
            value={authToken}
            onChange={setAuthToken}
            hasStored={settings.hasAuthToken}
          />
          {settings.hasAuthToken && (
            <p className="text-xs text-muted-foreground">{t('secretSaved')}</p>
          )}
        </div>
        <div className="space-y-1.5 sm:max-w-md">
          <Label htmlFor="sentry-secret">{t('clientSecret')}</Label>
          <SecretInput
            id="sentry-secret"
            value={clientSecret}
            onChange={setClientSecret}
            hasStored={settings.hasClientSecret}
          />
          {settings.hasClientSecret && (
            <p className="text-xs text-muted-foreground">{t('secretSaved')}</p>
          )}
        </div>
        <CopyableValue
          title={t('webhookUrl')}
          value={settings.webhookUrl}
          hint={t('webhookHint')}
          copyLabel={t('copyWebhookUrl')}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
