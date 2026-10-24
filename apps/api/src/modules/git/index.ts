import { Elysia, t } from 'elysia';
import { guards } from '#shared/guards';
import { authContext } from '#shared/auth-context';
import { dbContext } from '#shared/db-context';
import { noContent } from '#shared/http';
import { accessErrors, commonErrors, errors } from '#shared/responses';
import {
  AvailableGitRepositoryPageResponse,
  GitProviderConnectionListResponse,
  GitProviderConnectionResponse,
  GitSettingsResponse,
  availableRepositoriesQuery,
  connectRepositoriesBody,
  createGitProviderConnectionBody,
  gitManagedRepositoryParams,
  gitProviderConnectionParams,
  teamGitProviderConnectionParams,
  updateGitSettingsBody,
} from './model';
import { getOrCreateGitSettings, regenerateGitSecret, updateGitSettings } from './service';
import {
  connectGitProvider,
  connectRepositories,
  disconnectGitProvider,
  disconnectRepository,
  listAvailableRepositories,
  listGitProviderConnections,
  listTeamGitProviderConnections,
  reconcileManagedWebhooks,
} from './connections-service';

export const gitSettingsRoutes = new Elysia({
  name: 'git-settings',
  detail: { tags: ['Git'] },
})
  .use(authContext)
  .use(dbContext)
  .use(guards)
  .get(
    '/teams/:teamId/settings/git/connections',
    ({ db, membership }) => listTeamGitProviderConnections(db, membership.teamId),
    {
      teamManager: true,
      response: { 200: GitProviderConnectionListResponse, ...accessErrors },
      detail: { summary: 'List team Git provider accounts' },
    },
  )
  .post(
    '/teams/:teamId/settings/git/connections',
    async ({ db, membership, body, set }) => {
      const connection = await connectGitProvider(db, membership.teamId, body);
      set.status = 201;
      return connection;
    },
    {
      teamManager: true,
      body: createGitProviderConnectionBody,
      response: { 201: GitProviderConnectionResponse, ...commonErrors, ...errors(502) },
      detail: { summary: 'Connect or rotate a team Git provider account' },
    },
  )
  .delete(
    '/teams/:teamId/settings/git/connections/:connectionId',
    async ({ db, membership, params }) => {
      await disconnectGitProvider(db, membership.teamId, params.connectionId);
      return noContent();
    },
    {
      teamManager: true,
      params: teamGitProviderConnectionParams,
      response: { 204: t.Void(), ...commonErrors, ...errors(502) },
      detail: { summary: 'Disconnect a team Git provider account and its managed webhooks' },
    },
  )
  .get(
    '/projects/:projectKey/settings/git',
    ({ db, project }) => getOrCreateGitSettings(db, project.id),
    {
      permission: ['repositories', 'edit'],
      response: { 200: GitSettingsResponse, ...accessErrors },
      detail: {
        summary: "Get a project's repository integration settings",
        description:
          'Return the webhook endpoint, enabled events, merge automation, and the secret only when the caller may edit integrations.',
      },
    },
  )
  .patch(
    '/projects/:projectKey/settings/git',
    ({ db, project, body }) => updateGitSettings(db, project.id, body),
    {
      permission: ['repositories', 'edit'],
      body: updateGitSettingsBody,
      response: { 200: GitSettingsResponse, ...commonErrors },
      detail: {
        summary: "Update a project's repository integration settings",
        description:
          'Enable repository events and configure the issue state change applied after a merge.',
      },
    },
  )
  .post(
    '/projects/:projectKey/settings/git/secret',
    async ({ db, project }) => {
      const settings = await regenerateGitSecret(db, project.id);
      await reconcileManagedWebhooks(db, project.id, settings);
      return settings;
    },
    {
      permission: ['repositories', 'edit'],
      response: { 200: GitSettingsResponse, ...accessErrors },
      detail: {
        summary: "Regenerate a project's repository webhook secret",
        description:
          'Replace the shared webhook secret and update every webhook managed through a provider connection.',
      },
    },
  )
  .get(
    '/projects/:projectKey/settings/git/connections',
    ({ db, project }) => listGitProviderConnections(db, project.id),
    {
      permission: ['repositories', 'edit'],
      response: { 200: GitProviderConnectionListResponse, ...accessErrors },
      detail: {
        summary: 'List team Git provider accounts available to a project',
        description:
          'List accounts shared by this project’s team and repositories assigned to this project.',
      },
    },
  )
  .get(
    '/projects/:projectKey/settings/git/connections/:connectionId/repositories',
    ({ db, project, params, query }) =>
      listAvailableRepositories(
        db,
        project.id,
        params.connectionId,
        query.page ?? 1,
        query.search ?? '',
      ),
    {
      permission: ['repositories', 'edit'],
      params: gitProviderConnectionParams,
      query: availableRepositoriesQuery,
      response: { 200: AvailableGitRepositoryPageResponse, ...commonErrors, ...errors(502) },
      detail: {
        summary: 'List repositories available through a Git provider connection',
        description:
          'Search repositories visible to the connected provider account and report which ones are already connected.',
      },
    },
  )
  .post(
    '/projects/:projectKey/settings/git/connections/:connectionId/repositories',
    ({ db, project, params, body }) =>
      connectRepositories(db, project.id, params.connectionId, body.externalIds),
    {
      permission: ['repositories', 'edit'],
      params: gitProviderConnectionParams,
      body: connectRepositoriesBody,
      response: { 200: GitProviderConnectionResponse, ...commonErrors, ...errors(502) },
      detail: {
        summary: 'Connect repositories and install their webhooks',
        description:
          'Add the selected repositories to the project and create or reconcile provider webhooks for pull request and CI events.',
      },
    },
  )
  .delete(
    '/projects/:projectKey/settings/git/connections/:connectionId/repositories/:repositoryId',
    async ({ db, project, params }) => {
      await disconnectRepository(db, project.id, params.connectionId, params.repositoryId);
      return noContent();
    },
    {
      permission: ['repositories', 'edit'],
      params: gitManagedRepositoryParams,
      response: { 204: t.Void(), ...commonErrors, ...errors(502) },
      detail: {
        summary: 'Disconnect a repository and remove its managed webhook',
        description:
          'Delete the repository connection and remove the webhook that Plan installed at the provider.',
      },
    },
  );
