'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type SentrySettingsPatch,
  deleteSentryRoute,
  getSentrySettings,
  listSentryRoutes,
  updateSentrySettings,
  upsertSentryRoute,
} from '@/lib/api/endpoints/sentry';
import { qk } from '@/services/queryKeys';

export function useSentrySettingsQuery() {
  return useQuery({
    queryKey: qk.instanceSentrySettings,
    queryFn: () => getSentrySettings(),
  });
}

export function useUpdateSentrySettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: SentrySettingsPatch) => updateSentrySettings(patch),
    onSuccess: (data) => qc.setQueryData(qk.instanceSentrySettings, data),
  });
}

export function useSentryRoutesQuery() {
  return useQuery({
    queryKey: qk.instanceSentryRoutes,
    queryFn: () => listSentryRoutes(),
  });
}

export function useUpsertSentryRoute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { sentryProjectSlug: string; projectId: number }) => upsertSentryRoute(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.instanceSentryRoutes }),
  });
}

export function useDeleteSentryRoute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => deleteSentryRoute(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.instanceSentryRoutes }),
  });
}
