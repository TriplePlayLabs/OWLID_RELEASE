/* tslint:disable */
/* eslint-disable */
import type { RecoveryBackupResponse } from './RecoveryBackupResponse.js'
import {
  RecoveryBackupResponseFromJSON,
  RecoveryBackupResponseToJSON,
} from './RecoveryBackupResponse.js'

export interface RecoveryBackupsResponse {
  backups: Array<RecoveryBackupResponse>
}

export function RecoveryBackupsResponseFromJSON(json: any): RecoveryBackupsResponse {
  return RecoveryBackupsResponseFromJSONTyped(json, false)
}

export function RecoveryBackupsResponseFromJSONTyped(
  json: any,
  ignoreDiscriminator: boolean,
): RecoveryBackupsResponse {
  if (json == null) return json
  return {
    backups: (json['backups'] as Array<any>).map(RecoveryBackupResponseFromJSON),
  }
}

export function RecoveryBackupsResponseToJSON(json: any): RecoveryBackupsResponse {
  return RecoveryBackupsResponseToJSONTyped(json, false)
}

export function RecoveryBackupsResponseToJSONTyped(
  value?: RecoveryBackupsResponse | null,
  ignoreDiscriminator: boolean = false,
): any {
  if (value == null) return value
  return {
    backups: (value['backups'] as Array<any>).map(RecoveryBackupResponseToJSON),
  }
}
