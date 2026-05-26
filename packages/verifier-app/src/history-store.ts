/**
 * Verification history — persisted in IndexedDB so it survives reloads
 * and grows beyond the in-memory cap. One record per verification, read
 * back newest-first with offset/limit paging.
 */

export interface HistoryRecord {
  id: string
  /** Unix epoch milliseconds. */
  timestamp: number
  valid: boolean
  /** Plain-language labels of the checks the holder passed. */
  checks: string[]
  /** Campaign name when this was a unique-personhood verification. */
  campaign?: string
  /** Failure reason when `valid` is false. */
  error?: string
}

export interface HistoryPage {
  records: HistoryRecord[]
  total: number
}

const DB_NAME = 'owlid-verifier-history'
const STORE = 'history'
const DB_VERSION = 1

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' })
        store.createIndex('timestamp', 'timestamp')
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** Append one verification record. */
export async function addHistory(rec: HistoryRecord): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(rec)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

/** Read one page of history, newest first. */
export async function listHistory(offset: number, limit: number): Promise<HistoryPage> {
  const db = await openDb()
  try {
    return await new Promise<HistoryPage>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const store = tx.objectStore(STORE)
      const countReq = store.count()
      const records: HistoryRecord[] = []
      let skipped = 0
      // Walk the timestamp index in descending order (newest first).
      const cursorReq = store.index('timestamp').openCursor(null, 'prev')
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result
        if (!cursor || records.length >= limit) {
          resolve({ records, total: countReq.result })
          return
        }
        if (skipped < offset) {
          skipped++
        } else {
          records.push(cursor.value as HistoryRecord)
        }
        cursor.continue()
      }
      cursorReq.onerror = () => reject(cursorReq.error)
    })
  } finally {
    db.close()
  }
}

/** Wipe every history record. */
export async function clearHistory(): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}
