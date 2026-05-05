import { Link, useRouterState } from '@tanstack/react-router'
import {
  LayoutDashboard,
  ShieldCheck,
  Ban,
  ScanSearch,
  Users,
  Plug,
  Settings,
  ScrollText,
  Bird,
  Key,
  LogOut,
} from 'lucide-react'
import { useAuth } from '~/contexts/auth-context'

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarFooter,
  SidebarRail,
} from '~/components/ui/sidebar'

const navMain = [
  { title: 'Dashboard', to: '/', icon: LayoutDashboard },
  { title: 'Trusted Issuers', to: '/issuers', icon: ShieldCheck },
  { title: 'Revocations', to: '/revocations', icon: Ban },
  { title: 'Verify Token', to: '/verify', icon: ScanSearch },
]

const navIssuer = [
  { title: 'Providers', to: '/providers', icon: Plug },
  { title: 'Sessions', to: '/sessions', icon: Users },
]

const navSystem = [
  { title: 'API Keys', to: '/api-keys', icon: Key },
  { title: 'Logs', to: '/logs', icon: ScrollText },
  { title: 'Settings', to: '/settings', icon: Settings },
]

export function AppSidebar() {
  const routerState = useRouterState()
  const currentPath = routerState.location.pathname
  const { username, logout } = useAuth()

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link to="/">
                <div className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
                  <Bird className="size-4" />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">OwlID Admin</span>
                  <span className="truncate text-xs text-muted-foreground">Control Panel</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Verification</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navMain.map((item) => (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton
                    asChild
                    isActive={currentPath === item.to}
                    tooltip={item.title}
                  >
                    <Link to={item.to}>
                      <item.icon />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Issuer</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navIssuer.map((item) => (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton
                    asChild
                    isActive={currentPath === item.to}
                    tooltip={item.title}
                  >
                    <Link to={item.to}>
                      <item.icon />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>System</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navSystem.map((item) => (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton
                    asChild
                    isActive={currentPath === item.to}
                    tooltip={item.title}
                  >
                    <Link to={item.to}>
                      <item.icon />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              className="text-xs text-muted-foreground"
              tooltip={`Signed in as ${username}`}
            >
              <span>{username || 'admin'}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              className="text-xs text-muted-foreground"
              tooltip="Sign out"
              onClick={logout}
            >
              <LogOut className="size-4" />
              <span>Sign out</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  )
}
