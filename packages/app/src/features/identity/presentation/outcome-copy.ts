/**
 * Holder-side terminal copy for a sent presentation (GH #12).
 *
 * The holder can only confirm that the proof was SENT — the verifier runs
 * the actual check and shows accept/reject on their own screen. Claiming
 * "Verified" here made the two screens disagree ("my mobile says verified,
 * the verifier says something else"). The copy must stay outcome-neutral.
 */
export const PRESENTATION_SHARED_TITLE = 'Shared'
export const PRESENTATION_SHARED_DESCRIPTION =
  'Your proof was sent. The verifier will confirm the result on their end.'
