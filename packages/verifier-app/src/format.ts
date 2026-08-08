/** Unambiguous timestamp for history/revocation lists: a worded month
 *  ("10 Jun 2026, 12:03") cannot be misread as month/day vs day/month. */
export function formatTimestamp(input: number | string | Date): string {
  const date = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(date.getTime())) return String(input)
  return date.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
