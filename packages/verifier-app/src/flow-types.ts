export type Step =
  | 'idle'
  | 'scanning'
  | 'connecting'
  | 'selecting'
  | 'waiting'
  | 'verifying'
  | 'result'
  | 'error'

export type Tab = 'verify' | 'issuers' | 'revocations' | 'history'
