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
  UserCog,
  ChevronsUpDown,
} from 'lucide-react'
import { useAuth } from '~/hooks/use-auth'

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
} from '@owlid/ui/components/ui/sidebar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@owlid/ui/components/ui/dropdown-menu'
import { Avatar, AvatarFallback } from '@owlid/ui/components/ui/avatar'

const NAV_GROUPS = [
  {
    label: 'Verification',
    items: [
      { title: 'Dashboard', to: '/', icon: LayoutDashboard },
      { title: 'Trusted Issuers', to: '/issuers', icon: ShieldCheck },
      { title: 'Revocations', to: '/revocations', icon: Ban },
      { title: 'Verify Token', to: '/verify', icon: ScanSearch },
    ],
  },
  {
    label: 'Issuer',
    items: [
      { title: 'Providers', to: '/providers', icon: Plug },
      { title: 'Sessions', to: '/sessions', icon: Users },
    ],
  },
  {
    label: 'System',
    items: [
      { title: 'API Keys', to: '/api-keys', icon: Key },
      { title: 'Admin Users', to: '/users', icon: UserCog },
      { title: 'Activity', to: '/logs', icon: ScrollText },
      { title: 'Settings', to: '/settings', icon: Settings },
    ],
  },
] as const

export function AppSidebar() {
  const currentPath = useRouterState({ select: (s) => s.location.pathname })
  const { username, logoutMutation } = useAuth()
  const initials = (username ?? 'admin').slice(0, 2).toUpperCase()

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
                  <span className="truncate font-semibold">Owl ID Admin</span>
                  <span className="truncate text-xs text-muted-foreground">Control Panel</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {NAV_GROUPS.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => (
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
        ))}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  size="lg"
                  tooltip={`Signed in as ${username ?? 'admin'}`}
                  className="data-[state=open]:bg-sidebar-accent"
                >
                  <Avatar className="size-8 rounded-lg">
                    <AvatarFallback className="rounded-lg text-xs">{initials}</AvatarFallback>
                  </Avatar>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">{username ?? 'admin'}</span>
                    <span className="truncate text-xs text-muted-foreground">Operator</span>
                  </div>
                  <ChevronsUpDown className="ml-auto size-4" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="top"
                align="end"
                className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
              >
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  Signed in as {username ?? 'admin'}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={logoutMutation.isPending}
                  onClick={() => logoutMutation.mutate()}
                >
                  <LogOut className="size-4" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  )
}
