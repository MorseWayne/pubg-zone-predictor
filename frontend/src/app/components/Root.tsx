import { Link, Outlet, useLocation } from "react-router";
import { AppShell } from "@astryxdesign/core/AppShell";
import { SideNav, SideNavItem } from "@astryxdesign/core/SideNav";
import { Database, RadioTower, Route, Swords, TrendingUp, Users } from "lucide-react";

const pages = [
  { href: "/analysis", label: "对局回放", icon: Route },
  { href: "/collection", label: "数据采集", icon: Database },
  { href: "/opponents", label: "交手对手", icon: Swords },
  { href: "/personal-trend", label: "个人历史", icon: TrendingUp },
  { href: "/team-dashboard", label: "团队看板", icon: Users },
];

export function Root() {
  const { pathname } = useLocation();
  const navigation = (
    <SideNav
      aria-label="主导航"
      className="w-52 shrink-0 lg:w-64"
      header={
        <h1 className="flex items-center gap-3 px-3 py-4 text-lg font-bold">
          <RadioTower aria-hidden="true" />
          PUBG 回放中心
        </h1>
      }
      footer={
        <div className="flex items-center gap-2 px-3 py-2 text-xs text-secondary">
          <span className="size-2 rounded-full bg-success" />
          遥测服务：在线
        </div>
      }
    >
      {pages.map(({ href, label, icon }) => (
        <SideNavItem
          key={href}
          as={Link}
          href={href}
          label={label}
          icon={icon}
          isSelected={pathname === href}
          aria-current={pathname === href ? "page" : undefined}
        />
      ))}
    </SideNav>
  );
  return (
    <AppShell variant="section" height="fill" contentPadding={0} sideNav={navigation}>
      <div className="relative flex h-full min-h-0 min-w-0 flex-col">
        <Outlet />
      </div>
    </AppShell>
  );
}
