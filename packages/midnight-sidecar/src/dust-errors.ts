/**
 * A dust shortfall ("could not balance dust" / "Insufficient Funds") is the one
 * balance failure worth retrying: it is usually transient — pending UTXOs from a
 * just-submitted tx held in memory for a beat, or `dust.balance(now)` reading
 * `0n` while the dust observable settles. Every other failure (node reject,
 * malformed tx, contract assert) is terminal and must NOT be retried, since the
 * retry would either repeat a doomed submit or risk a double-submit.
 */
export function isDustShortfallError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  // Match both the spaced message ("Insufficient Funds: …") and the SDK's
  // typed error name ("Wallet.InsufficientFunds").
  return /insufficient\s*funds|could not balance dust/i.test(msg)
}
