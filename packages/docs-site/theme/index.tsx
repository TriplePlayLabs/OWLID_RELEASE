import { Layout as DefaultLayout } from '@rspress/core/theme-original'
import { Owl } from './Owl'

export function Layout(props: Record<string, unknown>) {
  return (
    <DefaultLayout
      {...(props as Parameters<typeof DefaultLayout>[0])}
      beforeNavTitle={<Owl size={36} className="owl-mark" />}
    />
  )
}

export * from '@rspress/core/theme-original'
