// Issue-type presets offered when creating a project. Mirrors ISSUE_TYPE_PRESETS in
// the API (apps/api/src/modules/projects/service.ts), which is what actually seeds
// the types; the copy here exists so the dialog can preview the result before the
// request.
export type PresetKey =
  | 'general'
  | 'software'
  | 'product'
  | 'content'
  | 'marketing'
  | 'design'
  | 'sales'
  | 'operations'
  | 'support'
  | 'recruiting';

// The name of a preset is a message under `newProject.presets`; the type names are
// what the project is seeded with, so they are values, not display text.
export const PRESETS: {
  key: PresetKey;
  types: { name: string; color: string }[];
}[] = [
  { key: 'general', types: [{ name: 'Task', color: '#4CC2FF' }] },
  {
    key: 'software',
    types: [
      { name: 'Feature', color: '#8A96FF' },
      { name: 'Bug', color: '#FF5C6C' },
      { name: 'Task', color: '#4CC2FF' },
      { name: 'Tech debt', color: '#FF7A59' },
      { name: 'Research', color: '#34D3C0' },
    ],
  },
  {
    key: 'product',
    types: [
      { name: 'Epic', color: '#8A96FF' },
      { name: 'Feature', color: '#4CC2FF' },
      { name: 'Feedback', color: '#FFB347' },
      { name: 'Research', color: '#34D3C0' },
    ],
  },
  {
    key: 'content',
    types: [
      { name: 'Article', color: '#4CC2FF' },
      { name: 'Video', color: '#FF5C6C' },
      { name: 'Social post', color: '#8A96FF' },
      { name: 'Idea', color: '#FFB347' },
      { name: 'Review', color: '#3DDC97' },
    ],
  },
  {
    key: 'marketing',
    types: [
      { name: 'Campaign', color: '#8A96FF' },
      { name: 'Landing', color: '#4CC2FF' },
      { name: 'Asset', color: '#34D3C0' },
      { name: 'Email', color: '#FF7A59' },
      { name: 'Research', color: '#3DDC97' },
    ],
  },
  {
    key: 'design',
    types: [
      { name: 'Screen', color: '#4CC2FF' },
      { name: 'Component', color: '#8A96FF' },
      { name: 'Asset', color: '#34D3C0' },
      { name: 'Research', color: '#3DDC97' },
    ],
  },
  {
    key: 'sales',
    types: [
      { name: 'Lead', color: '#4CC2FF' },
      { name: 'Deal', color: '#3DDC97' },
      { name: 'Follow-up', color: '#FFB347' },
      { name: 'Account', color: '#8A96FF' },
    ],
  },
  {
    key: 'operations',
    types: [
      { name: 'Request', color: '#4CC2FF' },
      { name: 'Process', color: '#8A96FF' },
      { name: 'Purchase', color: '#3DDC97' },
      { name: 'Maintenance', color: '#FF7A59' },
    ],
  },
  {
    key: 'support',
    types: [
      { name: 'Incident', color: '#FF5C6C' },
      { name: 'Request', color: '#4CC2FF' },
      { name: 'Question', color: '#FFB347' },
      { name: 'Change', color: '#8A96FF' },
    ],
  },
  {
    key: 'recruiting',
    types: [
      { name: 'Candidate', color: '#4CC2FF' },
      { name: 'Onboarding', color: '#3DDC97' },
      { name: 'Request', color: '#8A96FF' },
      { name: 'Policy', color: '#A0A4AD' },
    ],
  },
];
