import { useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useInstanceProjectsQuery } from '../../services/god.service';
import { useUpsertSentryRoute } from '../../services/sentry.service';

export default function GodSentryRouteForm() {
  const t = useTranslations('god.sentry');
  const projects = useInstanceProjectsQuery({ page: 1, pageSize: 100, search: '' });
  const upsert = useUpsertSentryRoute();
  const [slug, setSlug] = useState('');
  const [projectId, setProjectId] = useState('');

  const canAdd = slug.trim() !== '' && projectId !== '';

  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        upsert.mutate(
          { sentryProjectSlug: slug.trim(), projectId: Number(projectId) },
          {
            onSuccess: () => {
              toast.success(t('routeSaved'));
              setSlug('');
            },
          },
        );
      }}
    >
      <div className="min-w-48 flex-1 space-y-1.5">
        <Label htmlFor="sentry-route-slug">{t('sentryProject')}</Label>
        <Input
          id="sentry-route-slug"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder={t('sentryProjectPlaceholder')}
        />
      </div>
      <div className="min-w-48 flex-1 space-y-1.5">
        <Label htmlFor="sentry-route-project">{t('telicProject')}</Label>
        <Select value={projectId} onValueChange={setProjectId}>
          <SelectTrigger id="sentry-route-project" className="w-full">
            <SelectValue placeholder={t('selectProject')} />
          </SelectTrigger>
          <SelectContent>
            {projects.data?.items.map((p) => (
              <SelectItem key={p.id} value={String(p.id)}>
                {p.name} ({p.key})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button type="submit" disabled={!canAdd || upsert.isPending}>
        {t('addRoute')}
      </Button>
    </form>
  );
}
