/* tslint:disable */
/* eslint-disable */

export interface RecoveryBackupResponse {
  id: string
  credentialId: string
  ciphertext: string
  encryptionVersion: string
  keyLabel: string
  updatedAt: string
}

export function RecoveryBackupResponseFromJSON(json: any): RecoveryBackupResponse {
  return RecoveryBackupResponseFromJSONTyped(json, false)
}

export function RecoveryBackupResponseFromJSONTyped(
  json: any,
  ignoreDiscriminator: boolean,
): RecoveryBackupResponse {
  if (json == null) return json
  return {
    id: json['id'],
    credentialId: json['credentialId'],
    ciphertext: json['ciphertext'],
    encryptionVersion: json['encryptionVersion'],
    keyLabel: json['keyLabel'],
    updatedAt: json['updatedAt'],
  }
}

export function RecoveryBackupResponseToJSON(json: any): RecoveryBackupResponse {
  return RecoveryBackupResponseToJSONTyped(json, false)
}

export function RecoveryBackupResponseToJSONTyped(
  value?: RecoveryBackupResponse | null,
  ignoreDiscriminator: boolean = false,
): any {
  if (value == null) return value
  return {
    id: value['id'],
    credentialId: value['credentialId'],
    ciphertext: value['ciphertext'],
    encryptionVersion: value['encryptionVersion'],
    keyLabel: value['keyLabel'],
    updatedAt: value['updatedAt'],
  }
}
