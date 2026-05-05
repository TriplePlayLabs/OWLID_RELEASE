/**
 * IndexedDB Storage for Generated Proofs
 *
 * Proofs can be large (several KB) so we use IndexedDB instead of localStorage.
 * This provides persistent storage across sessions with no size limits.
 */

const DB_NAME = 'owl_proofs'
const DB_VERSION = 1
const STORE_NAME = 'proofs'

/**
 * Stored proof structure
 */
export interface StoredProof {
  /** Unique proof ID (e.g., 'isOver18', 'isEuCitizen') */
  id: string
  /** Display name */
  name: string
  /** The claim being proven */
  claim: string
  /** Whether the proof result is true/false */
  result: boolean
  /** Full proof token as JSON string */
  tokenJson: string
  /** When the proof was generated */
  createdAt: string
  /** When the proof expires (from token TTL) */
  expiresAt?: string
}

/**
 * Open IndexedDB connection
 */
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB not available'))
      return
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result

      // Create proofs store with id as key
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex('createdAt', 'createdAt', { unique: false })
      }
    }
  })
}

/**
 * Proof storage manager using IndexedDB
 */
export class ProofStorageManager {
  private dbPromise: Promise<IDBDatabase> | null = null

  private getDB(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = openDB()
    }
    return this.dbPromise
  }

  /**
   * Save a generated proof
   */
  async saveProof(proof: StoredProof): Promise<void> {
    const db = await this.getDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const request = store.put(proof)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve()
    })
  }

  /**
   * Save multiple proofs
   */
  async saveProofs(proofs: StoredProof[]): Promise<void> {
    const db = await this.getDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)

      tx.onerror = () => reject(tx.error)
      tx.oncomplete = () => resolve()

      for (const proof of proofs) {
        store.put(proof)
      }
    })
  }

  /**
   * Get a proof by ID
   */
  async getProof(id: string): Promise<StoredProof | null> {
    const db = await this.getDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const request = store.get(id)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result || null)
    })
  }

  /**
   * Get all stored proofs
   */
  async getAllProofs(): Promise<StoredProof[]> {
    const db = await this.getDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const request = store.getAll()
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result || [])
    })
  }

  /**
   * Delete a proof by ID
   */
  async deleteProof(id: string): Promise<void> {
    const db = await this.getDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const request = store.delete(id)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve()
    })
  }

  /**
   * Clear all stored proofs
   */
  async clearAllProofs(): Promise<void> {
    const db = await this.getDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const request = store.clear()
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve()
    })
  }

  /**
   * Check if a proof exists
   */
  async hasProof(id: string): Promise<boolean> {
    const proof = await this.getProof(id)
    return proof !== null
  }

  /**
   * Get count of stored proofs
   */
  async getProofCount(): Promise<number> {
    const db = await this.getDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const request = store.count()
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
    })
  }
}

/** Default proof storage instance */
export const proofStorage = new ProofStorageManager()
