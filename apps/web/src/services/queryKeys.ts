import type { FeedFilter, FeedOrder } from '@/lib/api/endpoints/activity';

const scimKey = (workspaceId: number | null) =>
  workspaceId === null ? (['god', 'scim'] as const) : (['workspace', workspaceId, 'scim'] as const);

// Query keys shared by every service. Each is a stable tuple; a project/issue id
// or key scopes its entry. Kept in one registry so a mutation in one service can
// invalidate another service's queries by the same key.
export const qk = {
  receivedInvites: ['receivedInvites'] as const,
  receivedInvitesPage: (userId: string, email: string, params: unknown) =>
    ['receivedInvites', userId, email, params] as const,
  projects: ['projects'] as const,
  // Under projects, so what refreshes the project list refreshes every search with it.
  projectSearch: (filters: unknown) => ['projects', 'search', filters] as const,
  teams: ['teams'] as const,
  // One team: its counters and what the caller may do with what it holds.
  team: (teamId: number) => ['team', teamId] as const,
  workspaces: ['workspaces'] as const,
  // One workspace a caller manages. Its managers, candidates and settings sit under it, so
  // invalidating the workspace refreshes all of them.
  workspace: (workspaceId: number) => ['workspace', workspaceId] as const,
  workspaceManagers: (workspaceId: number) => ['workspace', workspaceId, 'managers'] as const,
  workspaceManagerCandidates: (workspaceId: number, search: string) =>
    ['workspace', workspaceId, 'managers', 'candidates', search] as const,
  scim: scimKey,
  scimGroups: (workspaceId: number | null) => [...scimKey(workspaceId), 'groups'] as const,
  scimProjects: (workspaceId: number | null) => [...scimKey(workspaceId), 'projects'] as const,
  // The members of a team and the projects it owns, each read by its own section. A
  // page is scoped by the search term and the window it was read with.
  teamMembers: (teamId: number, params: unknown) => ['team', teamId, 'members', params] as const,
  teamProjects: (teamId: number, params: unknown) => ['team', teamId, 'projects', params] as const,
  // Every project of the team, for the pickers and the MCP switches that act on all
  // of them.
  teamProjectOptions: (teamId: number) => ['team', teamId, 'projects', 'options'] as const,
  // Every page of a team's projects and its options list, for a write that changes
  // what they show.
  anyTeamProjects: (teamId: number) => ['team', teamId, 'projects'] as const,
  // One project the team owns, loaded when its row is opened, and one page of its
  // members (the search term and the window scope the entry).
  teamProject: (teamId: number, projectId: number) =>
    ['team', teamId, 'project', projectId] as const,
  teamProjectMembers: (teamId: number, projectId: number, params: unknown) =>
    ['team', teamId, 'project', projectId, 'members', params] as const,
  // Every team detail and every project of one, for a write that changes what any
  // of them shows (a project gained or lost a member).
  anyTeam: ['team'] as const,
  // A team's notification provider credentials.
  notificationSettings: (teamId: number) => ['notificationSettings', teamId] as const,
  // The board scaffold (columns/types/labels/fields/viewer) for a project.
  project: (projectKey: string) => ['workItems', projectKey] as const,
  // Every project scaffold, for a write outside the project that changes what one
  // of them shows (a team setting the project inherits).
  anyProject: ['workItems'] as const,
  // The board's issues, their relations and the change marker for a project.
  // Split from the scaffold so issue writes and live-refresh touch only the
  // issues, not the scaffold.
  boardIssues: (projectKey: string) => ['boardIssues', projectKey] as const,
  // A project's archived issues.
  archivedIssues: (projectKey: string) => ['archivedIssues', projectKey] as const,
  // Command-palette issue search, scoped to a project and the search term.
  issueSearch: (projectKey: string, q: string) => ['issueSearch', projectKey, q] as const,
  // The project's auto-archive thresholds and subtask automations (the
  // Configuration settings section).
  autoArchive: (projectKey: string) => ['autoArchive', projectKey] as const,
  subtaskAutomation: (projectKey: string) => ['subtaskAutomation', projectKey] as const,
  // The project's repository integration settings (the Repositories settings section).
  gitSettings: (projectKey: string) => ['gitSettings', projectKey] as const,
  gitConnections: (projectKey: string) => ['gitConnections', projectKey] as const,
  gitAvailableRepositories: (projectKey: string, connectionId: number, search: string) =>
    ['gitConnections', projectKey, connectionId, 'repositories', search] as const,
  // The member's own notification preferences for a project.
  notificationPreferences: (projectKey: string) => ['notificationPreferences', projectKey] as const,
  views: (projectKey: string) => ['views', projectKey] as const,
  actions: (projectKey: string) => ['actions', projectKey] as const,
  webhooks: (projectKey: string) => ['webhooks', projectKey] as const,
  webhookDeliveries: (webhookId: number) => ['webhookDeliveries', webhookId] as const,
  // The project's import jobs (the Import/Export settings section).
  importJobs: (projectKey: string) => ['importJobs', projectKey] as const,
  // The mapping review preview for one candidate Plane project, before a job exists.
  planePreview: (projectKey: string, planeProjectId: string) =>
    ['planePreview', projectKey, planeProjectId] as const,
  // The same preview for one Linear team's workflow states.
  linearPreview: (projectKey: string, teamId: string) =>
    ['linearPreview', projectKey, teamId] as const,
  // Saved dashboards (the analytics tabs) and the read-only metrics behind their
  // widgets. `kind` names the metric (stats/pulse/throughput/breakdown/...) and
  // `params` scopes it to the widget's query (window, filters).
  dashboards: (projectKey: string) => ['dashboards', projectKey] as const,
  documents: (projectKey: string, q = '', archived = false) =>
    ['documents', projectKey, 'list', archived ? 'archived' : 'active', q] as const,
  documentListsForProject: (projectKey: string) => ['documents', projectKey, 'list'] as const,
  document: (projectKey: string, documentId: number) =>
    ['documents', projectKey, 'document', documentId] as const,
  documentRevisions: (projectKey: string, documentId: number) =>
    ['documents', projectKey, 'document', documentId, 'revisions'] as const,
  documentComments: (projectKey: string, documentId: number) =>
    ['documents', projectKey, 'document', documentId, 'comments'] as const,
  documentAssets: (projectKey: string, documentId: number) =>
    ['documents', projectKey, 'document', documentId, 'assets'] as const,
  documentIssueLinks: (projectKey: string, documentId: number) =>
    ['documents', projectKey, 'document', documentId, 'issues'] as const,
  issueDocumentLinks: (projectKey: string, issueId: number) =>
    ['documents', projectKey, 'issue', issueId] as const,
  initiativeDocumentLinks: (projectKey: string, initiativeId: number) =>
    ['documents', projectKey, 'initiative', initiativeId] as const,
  // Note boards (the notes canvases). `noteBoardsForProject` is the invalidation
  // base for every list/search variant; `noteBoardsSearch` is one paged switcher
  // query (scoped by search text); `noteBoard` is a single board with its canvas.
  noteBoardsForProject: (projectKey: string) => ['noteBoards', projectKey] as const,
  noteBoardsSearch: (projectKey: string, q: string) =>
    ['noteBoards', projectKey, 'search', q] as const,
  noteBoard: (projectKey: string, boardId: number) =>
    ['noteBoards', projectKey, 'board', boardId] as const,
  noteBoardAccessCandidates: (projectKey: string) =>
    ['noteBoards', projectKey, 'accessCandidates'] as const,
  analytics: (projectKey: string, kind: string, params?: unknown) =>
    ['analytics', projectKey, kind, params ?? {}] as const,
  analyticsForProject: (projectKey: string) => ['analytics', projectKey] as const,
  // Project membership and invite links (the Members section).
  members: (projectKey: string) => ['members', projectKey] as const,
  // One page of them. Under the key above, so a membership write invalidates every
  // page with the one call.
  memberPage: (projectKey: string, params: unknown) =>
    ['members', projectKey, 'page', params] as const,
  // Every project's member list, for a write that changes what any of them resolves
  // to (a role edited on the team they belong to).
  anyMembers: ['members'] as const,
  invites: (projectKey: string) => ['invites', projectKey] as const,
  anyInvites: ['invites'] as const,
  // Who a project can be filled from: the members of its team who are not in it yet.
  memberCandidates: (projectKey: string) => ['members', projectKey, 'candidates'] as const,
  // The invites of a team, including the ones into its projects.
  teamInvites: (teamId: number) => ['teamInvites', teamId] as const,
  anyTeamInvites: ['teamInvites'] as const,
  // The roles a team offers, which is what every project of it assigns from. The
  // permission catalog is app-static, so it is scoped to no team.
  teamRoles: (teamId: number, params: unknown) => ['teamRoles', teamId, params] as const,
  teamRoleOptions: (teamId: number) => ['teamRoles', teamId, 'options'] as const,
  anyTeamRoles: (teamId: number) => ['teamRoles', teamId] as const,
  roleUsage: (teamId: number, roleId: number) => ['roleUsage', teamId, roleId] as const,
  anyRoleUsage: ['roleUsage'] as const,
  permissionCatalog: ['permissionCatalog'] as const,
  issue: (id: number) => ['issue', id] as const,
  issueDevelopmentRepositories: (id: number) =>
    ['issue', id, 'development', 'repositories'] as const,
  issueDevelopmentPullRequests: (id: number, repositoryId: number, state: 'open' | 'all') =>
    ['issue', id, 'development', 'repositories', repositoryId, 'pullRequests', state] as const,
  issueDevelopmentBranches: (id: number, repositoryId: number) =>
    ['issue', id, 'development', 'repositories', repositoryId, 'branches'] as const,
  // Under the issue prefix, so every issue mutation refreshes the cycles with it.
  issueCycles: (id: number) => ['issue', id, 'cycles'] as const,
  anyIssue: ['issue'] as const,
  // Resolving an issue by its project-scoped number (the identifier-based URL).
  issueBySeq: (projectKey: string, seq: number) => ['issueBySeq', projectKey, seq] as const,
  // Every read of one issue's feed sits under this key, so invalidating it refreshes
  // them all.
  feed: (id: number) => ['feed', id] as const,
  flatFeed: (id: number, filter: FeedFilter | null, order: FeedOrder) =>
    ['feed', id, 'flat', filter, order] as const,
  // The same feed split by status, paged on its own.
  groupedFeed: (id: number, filter: FeedFilter | null, order: FeedOrder) =>
    ['feed', id, 'grouped', filter, order] as const,
  feedCounts: (id: number) => ['feed', id, 'counts'] as const,
  // The status stretches of the timeline view, and the entries of one stretch read
  // when it is opened. Both keyed under the feed, so every existing feed
  // invalidation refreshes them too.
  timeline: (id: number) => ['feed', id, 'timeline'] as const,
  timelineItems: (id: number, from: string, to: string | null) =>
    ['feed', id, 'timelineItems', from, to] as const,
  // Initiatives: a project's list (params narrow, sort and page it), the per-status
  // tab counts, one initiative, and one initiative's activity feed.
  initiatives: (projectKey: string, params: unknown) =>
    ['initiatives', projectKey, params] as const,
  initiativesForProject: (projectKey: string) => ['initiatives', projectKey] as const,
  // The linkable initiatives behind the issue picker, narrowed by the typed search.
  initiativeOptions: (projectKey: string, params: Record<string, unknown>) =>
    ['initiatives', projectKey, 'options', params] as const,
  initiativeCounts: (projectKey: string) => ['initiativeCounts', projectKey] as const,
  initiative: (id: number) => ['initiative', id] as const,
  initiativeFeed: (id: number) => ['initiativeFeed', id] as const,
  // Prefix keys: issue mutations invalidate every initiative query without
  // knowing the id (see invalidateInitiatives in issues.service).
  anyInitiative: ['initiative'] as const,
  anyInitiativeFeed: ['initiativeFeed'] as const,
  anyInitiatives: ['initiatives'] as const,
  // Cycles: a project's list and one cycle. Issue mutations invalidate the whole
  // 'cycles' subtree, since planning an issue moves a cycle's progress. The list the
  // page reads is split in two — what is still planned, and the paged archive —
  // under the same prefix, so one invalidation covers all three.
  cycles: (projectKey: string) => ['cycles', projectKey] as const,
  plannedCycles: (projectKey: string) => ['cycles', projectKey, 'planned'] as const,
  cycleOptions: (projectKey: string) => ['cycles', projectKey, 'options'] as const,
  completedCycles: (projectKey: string) => ['cycles', projectKey, 'completed'] as const,
  cycle: (id: number) => ['cycle', id] as const,
  anyCycles: ['cycles'] as const,
  anyCycle: ['cycle'] as const,
  attachments: (id: number) => ['attachments', id] as const,
  initiativeAttachments: (id: number) => ['initiativeAttachments', id] as const,
  // The time entries of one issue. Their sum comes with the issue, so a write
  // refreshes that read too.
  worklogs: (id: number) => ['worklogs', id] as const,
  // A project's inbox notifications (the list, scoped by the active filters) and the
  // project's unread count (the sidebar badge + live-refresh target).
  notifications: (projectKey: string, filters?: unknown) =>
    ['notifications', projectKey, filters ?? {}] as const,
  notificationsUnread: (projectKey: string) => ['notificationsUnread', projectKey] as const,
  // The issues of a project waiting in its triage column.
  triage: (projectKey: string) => ['triage', projectKey] as const,
  // The unread count across every project (the app icon badge).
  notificationsUnreadTotal: ['notificationsUnreadTotal'] as const,
  // The signed-in user's WebAuthn passkeys (account security page).
  passkeys: ['passkeys'] as const,
  // The OAuth applications the signed-in user authorized (account security page).
  connectedApps: ['connectedApps'] as const,
  // The signed-in user's connected external accounts (accounts page): the linked
  // Telegram account, and the auth providers better-auth reports.
  telegramAccount: ['telegramAccount'] as const,
  linkedAccounts: ['linkedAccounts'] as const,
  // The instance sign-in policy, including which social providers are configured.
  authConfig: ['authConfig'] as const,
  // The name an MCP client registered with, shown on the OAuth consent page.
  oauthClientName: (clientId: string) => ['oauthClientName', clientId] as const,
  // The signed-in user's personal API keys (API keys page).
  apiKeys: ['apiKeys'] as const,
  // The signed-in user's interface preferences (timezone, theme, issue open mode,
  // start page). Read app-wide, not just on the preferences page.
  accountPreferences: ['accountPreferences'] as const,
  // Instance administration (god mode): the sign-in policy, the mail provider, the
  // sign-in providers (Google and OIDC) and the Telegram bot. Not scoped to a project.
  instanceAuthSettings: ['instanceAuthSettings'] as const,
  instanceEmailSettings: ['instanceEmailSettings'] as const,
  instanceGoogleSettings: ['instanceGoogleSettings'] as const,
  instanceOidcSettings: ['instanceOidcSettings'] as const,
  instanceTelegramSettings: ['instanceTelegramSettings'] as const,
  instanceSentrySettings: ['instanceSentrySettings'] as const,
  instanceSentryRoutes: ['instanceSentryRoutes'] as const,
  instanceProjectDefaults: ['instanceProjectDefaults'] as const,
  instanceStorageSettings: ['instanceStorageSettings'] as const,
  // The upload limits as read by the upload UI (open to any signed-in user).
  storageSettings: ['storageSettings'] as const,
  // The running version (any signed-in user) and the upstream release check (god).
  appVersion: ['appVersion'] as const,
  // The post-upgrade screen: the running release's notes, the backup and the
  // migration report.
  whatsNew: ['whatsNew'] as const,
  updateStatus: ['updateStatus'] as const,
  // The bindings every client resolves from, and the god-mode editor's copy.
  hotkeySettings: ['hotkeySettings'] as const,
  instanceHotkeySettings: ['hotkeySettings', 'god'] as const,
  // The instance user directory: the list (scoped by the active filters) and one
  // account with its project access.
  instanceUsers: (filters: unknown) => ['instanceUsers', filters] as const,
  instanceUser: (userId: string) => ['instanceUser', userId] as const,
  anyInstanceUsers: ['instanceUsers'] as const,
  // The instance project directory: the list (scoped by the active filters) and one
  // project with its members.
  instanceProjects: (filters: unknown) => ['instanceProjects', filters] as const,
  instanceProject: (projectId: number) => ['instanceProject', projectId] as const,
  // The instance team directory: the list (scoped by the active filters) and one team
  // with its projects and members.
  instanceTeams: (filters: unknown) => ['instanceTeams', filters] as const,
  instanceTeam: (teamId: number) => ['instanceTeam', teamId] as const,
  instanceTeamProjects: (teamId: number, filters: unknown) =>
    ['instanceTeamProjects', teamId, filters] as const,
  instanceTeamMembers: (teamId: number, filters: unknown) =>
    ['instanceTeamMembers', teamId, filters] as const,
};
