import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getAdminAuthApi,
  ResponseError,
  type ChangePasswordRequest,
  type ChangePasswordResponse,
  type LoginRequest,
  type LoginResponse,
  type MeResponse,
} from '@owlid/admin-client'

const ME_QUERY_KEY = ['admin', 'me'] as const

/**
 * Cache key for the must-rotate flag. We keep it in the React Query
 * cache (rather than component state) so every `useAuth()` consumer
 * sees the same value when one of them flips it. The value is also
 * mirrored to sessionStorage so a page reload preserves the rotation
 * gate (the cookie alone doesn't carry it — only the login response
 * does, and `/admin/me` is intentionally minimal).
 */
const MUST_ROTATE_QUERY_KEY = ['admin', 'must-rotate'] as const
const MUST_ROTATE_STORAGE_KEY = 'owlid_admin_must_rotate'

function readMustRotateStorage(): boolean {
  if (typeof sessionStorage === 'undefined') return false
  return sessionStorage.getItem(MUST_ROTATE_STORAGE_KEY) === '1'
}

function writeMustRotateStorage(v: boolean): void {
  if (typeof sessionStorage === 'undefined') return
  if (v) sessionStorage.setItem(MUST_ROTATE_STORAGE_KEY, '1')
  else sessionStorage.removeItem(MUST_ROTATE_STORAGE_KEY)
}

function isUnauthenticated(err: unknown): boolean {
  return err instanceof ResponseError && err.response.status === 401
}

/**
 * Hard cap on bootstrap retries. Default TanStack retry is 3 with exponential
 * backoff — fine for transient flakiness but produces a long spinner when the
 * verification service is plain unreachable. Two retries (~3s total wait at
 * 1s+2s) is enough to ride through a single hiccup; past that the user is
 * better served by an actionable error than another spinner.
 */
const ME_MAX_RETRIES = 2

export function useAuth() {
  const queryClient = useQueryClient()

  // Subscribe to the must-rotate flag via React Query so any useAuth
  // consumer in the tree re-renders when login / change-password /
  // logout flips it.
  const mustRotateQuery = useQuery<boolean>({
    queryKey: MUST_ROTATE_QUERY_KEY,
    queryFn: () => readMustRotateStorage(),
    initialData: () => readMustRotateStorage(),
    staleTime: Infinity,
    gcTime: Infinity,
  })
  const mustRotate = mustRotateQuery.data ?? false

  function applyMustRotate(v: boolean) {
    writeMustRotateStorage(v)
    queryClient.setQueryData<boolean>(MUST_ROTATE_QUERY_KEY, v)
  }

  const meQuery = useQuery<MeResponse | null>({
    queryKey: ME_QUERY_KEY,
    queryFn: async () => {
      try {
        return await getAdminAuthApi().me()
      } catch (err) {
        if (isUnauthenticated(err)) return null
        throw err
      }
    },
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: (failureCount, err) => !isUnauthenticated(err) && failureCount < ME_MAX_RETRIES,
    // Cap the per-attempt wait so an offline backend doesn't push the
    // overall spinner above ~3s.
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 3000),
  })

  const loginMutation = useMutation<LoginResponse, Error, LoginRequest>({
    mutationFn: (loginRequest) => getAdminAuthApi().login({ loginRequest }),
    onSuccess: (data) => {
      applyMustRotate(data.mustChangeDefaultPassword)
      queryClient.setQueryData<MeResponse>(ME_QUERY_KEY, { username: data.username })
    },
  })

  const logoutMutation = useMutation<void, Error, void>({
    mutationFn: () => getAdminAuthApi().logout(),
    onSettled: () => {
      // Set the auth-related cache entries directly — every consumer of
      // `useAuth()` is observing these specific keys, so writes here
      // propagate synchronously into the AuthGate's render branch and
      // the user sees LoginPage on the next paint.
      //
      // Order matters: write me=null *first* so AuthGate's
      // `isAuthenticated` flips false immediately. Calling removeQueries
      // here used to take the must-rotate observer with it before the
      // re-render landed, which left the page stuck on the dashboard
      // until a manual refresh.
      queryClient.setQueryData<MeResponse | null>(ME_QUERY_KEY, null)
      queryClient.setQueryData<boolean>(MUST_ROTATE_QUERY_KEY, false)
      applyMustRotate(false)
      // Invalidate (don't remove) every other cached admin response so
      // a subsequent login refetches fresh data. invalidate keeps any
      // in-flight observers attached and just marks them stale.
      queryClient.invalidateQueries({ queryKey: ['admin'], exact: false })
    },
  })

  const changePasswordMutation = useMutation<ChangePasswordResponse, Error, ChangePasswordRequest>({
    mutationFn: (changePasswordRequest) =>
      getAdminAuthApi().changePassword({ changePasswordRequest }),
    onSuccess: () => {
      // Rotation done — drop the gate. The session cookie keeps the
      // operator logged in; subsequent requests carry the same JWT.
      applyMustRotate(false)
    },
  })

  return {
    isAuthenticated: meQuery.data != null,
    isBootstrapping: meQuery.isPending,
    /** When true, the operator must change their password before being
     *  allowed to use the dashboard. AuthGate renders the change-password
     *  screen instead of the routed content. */
    mustChangeDefaultPassword: meQuery.data != null && mustRotate,
    /**
     * `true` when the bootstrap query exhausted its retries on a non-401
     * error (typically the verification service is unreachable). The
     * AuthGate should render an actionable error instead of falling
     * through to the login form.
     */
    isBootstrapError: meQuery.isError,
    bootstrapError: meQuery.error,
    refetchMe: () => meQuery.refetch(),
    username: meQuery.data?.username ?? null,
    loginMutation,
    logoutMutation,
    changePasswordMutation,
  }
}
