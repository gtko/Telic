// A schedule timestamp as the database hands it back: epoch milliseconds from D1, or the text
// form older rows and exports carry.
export function parseScheduleTimestamp(value: string | number): Date {
  return new Date(value);
}
