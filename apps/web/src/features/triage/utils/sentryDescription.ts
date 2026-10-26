export interface SentryDetails {
  level: string | null;
  sentryUrl: string | null;
}

// The Sentry webhook writes the facts it receives as "Key: value" lines in the issue
// description. The level and the link are read back from there.
export function parseSentryDescription(description: string): SentryDetails {
  const line = (key: string) =>
    new RegExp(`^${key}: (.+)$`, 'm').exec(description)?.[1]?.trim() ?? null;
  const url = line('Sentry');
  return { level: line('Level'), sentryUrl: url && /^https?:\/\/\S+$/.test(url) ? url : null };
}
