import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import type { SentryRoute } from '@/lib/api/endpoints/sentry';
import { Button } from '@/components/ui/button';
import { TableCell, TableRow } from '@/components/ui/table';
import { useDeleteSentryRoute } from '../../services/sentry.service';

export default function GodSentryRouteRow({ route }: { route: SentryRoute }) {
  const t = useTranslations('god.sentry');
  const remove = useDeleteSentryRoute();

  return (
    <TableRow>
      <TableCell className="font-mono text-xs">{route.sentryProjectSlug}</TableCell>
      <TableCell>
        {route.projectName} <span className="text-muted-foreground">({route.projectKey})</span>
      </TableCell>
      <TableCell>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('deleteRoute', { slug: route.sentryProjectSlug })}
          disabled={remove.isPending}
          onClick={() =>
            remove.mutate(route.id, { onSuccess: () => toast.success(t('routeDeleted')) })
          }
        >
          <Trash2 className="size-4" />
        </Button>
      </TableCell>
    </TableRow>
  );
}
