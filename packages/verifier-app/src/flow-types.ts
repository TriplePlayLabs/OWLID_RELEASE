export type Step =
  | 'idle'
  | 'scanning'
  | 'connecting'
  | 'selecting'
  | 'waiting'
  | 'verifying'
  | 'result'
  | 'error'
  // Manual steps (challenge-based, no live session)
  | 'manual-challenge'
  | 'manual-scan'
  | 'manual-paste'

export type Tab = 'verify' | 'issuers' | 'revocations' | 'history'
