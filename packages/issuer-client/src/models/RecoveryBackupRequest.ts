/* tslint:disable */
/* eslint-disable */

export interface RecoveryBackupRequest {
  credentialId: string
  ciphertext: string
  encryptionVersion: string
  keyLabel: string
  metadata?: any
}

export function RecoveryBackupRequestFromJSON(json: any): RecoveryBackupRequest {
  return RecoveryBackupRequestFromJSONTyped(json, false)
}

export function RecoveryBackupRequestFromJSONTyped(
  json: any,
  ignoreDiscriminator: boolean,
): RecoveryBackupRequest {
  if (json == null) return json
  return {
    credentialId: json['credentialId'],
    ciphertext: json['ciphertext'],
    encryptionVersion: json['encryptionVersion'],
    keyLabel: json['keyLabel'],
    metadata: json['metadata'] == null ? undefined : json['metadata'],
  }
}

export function RecoveryBackupRequestToJSON(json: any): RecoveryBackupRequest {
  return RecoveryBackupRequestToJSONTyped(json, false)
}

export function RecoveryBackupRequestToJSONTyped(
  value?: RecoveryBackupRequest | null,
  ignoreDiscriminator: boolean = false,
): any {
  if (value == null) return value
  return {
    credentialId: value['credentialId'],
    ciphertext: value['ciphertext'],
    encryptionVersion: value['encryptionVersion'],
    keyLabel: value['keyLabel'],
    metadata: value['metadata'],
  }
}
