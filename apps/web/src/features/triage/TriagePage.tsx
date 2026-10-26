'use client';

import { useShell } from '@/context/shellContext';
import TriageView from './components/TriageView';

// The Triage page (/:team/:projectKey/triage): the Sentry errors waiting in the
// project's triage column, each accepted, merged into an issue or rejected.
export default function TriagePage() {
  const { project } = useShell();
  if (!project) return null;
  return <TriageView key={project.project.ref} project={project} />;
}
