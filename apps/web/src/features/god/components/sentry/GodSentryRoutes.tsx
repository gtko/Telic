import { useTranslations } from 'next-intl';
import ListSkeleton from '@/components/common/skeleton/ListSkeleton';
import SettingsSection from '@/components/common/page/SettingsSection';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useSentryRoutesQuery } from '../../services/sentry.service';
import GodSentryRouteForm from './GodSentryRouteForm';
import GodSentryRouteRow from './GodSentryRouteRow';

export default function GodSentryRoutes() {
  const t = useTranslations('god.sentry');
  const query = useSentryRoutesQuery();
  const routes = query.data ?? [];

  return (
    <SettingsSection title={t('routing')} description={t('routingHint')}>
      {query.isLoading ? (
        <ListSkeleton rows={3} />
      ) : (
        <>
          {routes.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('sentryProject')}</TableHead>
                  <TableHead>{t('telicProject')}</TableHead>
                  <TableHead className="w-12">
                    <span className="sr-only">{t('actions')}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {routes.map((route) => (
                  <GodSentryRouteRow key={route.id} route={route} />
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">{t('noRoutes')}</p>
          )}
          <GodSentryRouteForm />
        </>
      )}
    </SettingsSection>
  );
}
