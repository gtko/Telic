import { Elysia, t } from 'elysia';
import { authContext } from '#shared/auth-context';
import { dbContext } from '#shared/db-context';
import { guards, entityGuard, assertMcpAllowed, requiresPermission } from '#shared/guards';
import { assertPermission, requireUser } from '#shared/access';
import { HttpError } from '#shared/lib';
import { accessErrors, commonErrors, errors } from '#shared/responses';
import {
  ImportJobResponse,
  TestConnectionResponse,
  PlanePreviewResponse,
  LinearTestConnectionResponse,
  LinearPreviewResponse,
  ProjectExportResponse,
  createImportJobBody,
  importJobParams,
  testConnectionBody,
  planePreviewBody,
  linearConnectionBody,
  linearPreviewBody,
} from './model';
import {
  cancelImportJob,
  createImportJob,
  getImportJobDto,
  getImportJobProjectId,
  listImportJobs,
  pauseImportJob,
  resumeImportJob,
  testPlaneConnection,
  testPlaneStatesPreview,
} from './service';
import { exportProject } from './export';
import { previewLinearStates, testLinearConnection } from './linear';

// Import jobs bring issues from an external tracker into a project. Creating one
// stores an encrypted credential and leaves it 'pending' for the worker
// (apps/worker/src/import-worker.ts) to drive through its phases; this module never
// touches the worker's queue directly, only the import_job/import_record rows it reads
// and writes too.

export const importExportRoutes = new Elysia({
  name: 'import-export',
  detail: { tags: ['Import/Export'] },
})
  .use(authContext)
  .use(dbContext)
  .use(guards)
  .macro({
    importJobEntity: entityGuard('import_export', 'Import job not found', (p, { db }) =>
      getImportJobProjectId(db, Number(p.id)),
    ),
  })

  .post(
    '/projects/:projectKey/import-jobs/test-connection',
    ({ body }) => testPlaneConnection(body.baseUrl, body.workspaceSlug, body.apiToken),
    {
      permission: ['import_export', 'create'],
      body: testConnectionBody,
      response: { 200: TestConnectionResponse, ...commonErrors, ...errors(502) },
      detail: {
        summary: 'Test a Plane connection',
        description:
          'Validate a base URL, workspace slug, and API token against the source live, without ' +
          'storing anything. Returns the projects of the workspace to pick a source project from.',
      },
    },
  )

  .post(
    '/projects/:projectKey/import-jobs/plane-preview',
    ({ body }) =>
      testPlaneStatesPreview(body.baseUrl, body.workspaceSlug, body.apiToken, body.planeProjectId),
    {
      permission: ['import_export', 'create'],
      body: planePreviewBody,
      response: { 200: PlanePreviewResponse, ...commonErrors, ...errors(502) },
      detail: {
        summary: 'Preview a Plane project before importing it',
        description:
          "Fetch the source project's states, each with the category Telic would " +
          'automatically map it to, for review before a job is created.',
      },
    },
  )

  .post(
    '/projects/:projectKey/import-jobs/linear-test-connection',
    ({ body }) => testLinearConnection(body.apiToken),
    {
      permission: ['import_export', 'create'],
      body: linearConnectionBody,
      response: { 200: LinearTestConnectionResponse, ...commonErrors, ...errors(502) },
      detail: {
        summary: 'Test a Linear API key',
        description:
          'Validate a Linear personal API key live, without storing anything. Returns the ' +
          'teams it can see, each with its projects, to pick what to import from.',
      },
    },
  )

  .post(
    '/projects/:projectKey/import-jobs/linear-preview',
    ({ body }) => previewLinearStates(body.apiToken, body.teamId),
    {
      permission: ['import_export', 'create'],
      body: linearPreviewBody,
      response: { 200: LinearPreviewResponse, ...commonErrors, ...errors(502) },
      detail: {
        summary: 'Preview a Linear team before importing from it',
        description:
          "Fetch the team's workflow states, each with the category Telic would " +
          'automatically map it to, for review before a job is created.',
      },
    },
  )

  .get(
    '/projects/:projectKey/import-jobs/export',
    ({ db, project }) => exportProject(db, project.id),
    {
      permission: ['import_export', 'create'],
      response: { 200: ProjectExportResponse, ...accessErrors },
      detail: {
        summary: "Export a project's data",
        description:
          "A self-contained snapshot of the project's states, labels, cycles, and issues " +
          '(with their comments and relations), as portable JSON. Not a live sync to any ' +
          'target — a download.',
      },
    },
  )

  .post(
    '/projects/:projectKey/import-jobs',
    ({ db, project, body, user, set }) => {
      set.status = 201;
      return createImportJob(db, project.id, requireUser(user).id, body);
    },
    {
      permission: ['import_export', 'create'],
      body: createImportJobBody,
      response: { 201: ImportJobResponse, ...commonErrors },
      detail: {
        summary: 'Create an import job',
        description:
          "Create a Plane job, or a Linear one with source 'linear'. Encrypt and store the " +
          "submitted credential and leave the job 'pending' for the worker.",
      },
    },
  )

  .get('/projects/:projectKey/import-jobs', ({ db, project }) => listImportJobs(db, project.id), {
    permission: ['import_export', 'read'],
    response: { 200: t.Array(ImportJobResponse), ...accessErrors },
    detail: { summary: "List a project's import jobs" },
  })

  // Fetches the row itself and asserts on it, like GET /issues/:issueId — the entity
  // guard would resolve the project id with a second query this handler doesn't need.
  .get(
    '/import-jobs/:id',
    async ({ db, params, user, request }) => {
      const job = await getImportJobDto(db, params.id);
      if (!job) throw new HttpError(404, 'Import job not found');
      await assertPermission(db, job.projectId, user, 'import_export', 'read');
      await assertMcpAllowed(db, job.projectId, request.headers);
      return job;
    },
    {
      params: importJobParams,
      response: { 200: ImportJobResponse, ...commonErrors },
      detail: {
        summary: 'Get an import job',
        description: 'Get the status and per-entity progress counts of an import job.',
        ...requiresPermission(['import_export', 'read']),
      },
    },
  )

  .post('/import-jobs/:id/pause', ({ db, params }) => pauseImportJob(db, params.id), {
    params: importJobParams,
    importJobEntity: 'edit',
    response: { 200: ImportJobResponse, ...accessErrors, ...errors(409) },
    detail: { summary: 'Pause an import job' },
  })

  .post('/import-jobs/:id/resume', ({ db, params }) => resumeImportJob(db, params.id), {
    params: importJobParams,
    importJobEntity: 'edit',
    response: { 200: ImportJobResponse, ...accessErrors, ...errors(409) },
    detail: { summary: 'Resume a paused import job' },
  })

  .post('/import-jobs/:id/cancel', ({ db, params }) => cancelImportJob(db, params.id), {
    params: importJobParams,
    importJobEntity: 'edit',
    response: { 200: ImportJobResponse, ...accessErrors, ...errors(409) },
    detail: { summary: 'Cancel an import job' },
  });
