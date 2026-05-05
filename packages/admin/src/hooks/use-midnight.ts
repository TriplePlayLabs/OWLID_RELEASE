import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getAdminApi, type MidnightStatus } from '@owlid/admin-client'

const STATUS_KEY = ['admin', 'midnight', 'status'] as const

export function useMidnightStatus() {
  return useQuery<MidnightStatus>({
    queryKey: STATUS_KEY,
    queryFn: () => getAdminApi().getMidnightStatus(),
    // Sidecar can flap independently of the verification service; poll
    // on a cadence so the dashboard surfaces transient outages without
    // needing a manual refresh. 10s is fast enough for a control panel
    // and slow enough not to drown the sidecar in health probes.
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
  })
}

export function useToggleMidnight() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, boolean>({
    mutationFn: async (enable) => {
      if (enable) {
        await getAdminApi().enableMidnight()
      } else {
        await getAdminApi().disableMidnight()
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: STATUS_KEY })
    },
  })
}
