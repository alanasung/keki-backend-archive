import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { SurfaceNav } from '@keki/ui';
import { requireRole } from '../auth/guards';
import { navConfig } from '../nav-config';

export default async function AdminLayout({ children }: { readonly children: ReactNode }) {
  await requireRole('MANAGER');
  const headerList = await headers();
  const currentPath = headerList.get('x-pathname') ?? undefined;

  return (
    <div className="flex min-h-screen flex-col">
      <SurfaceNav
        surface="admin"
        items={navConfig.admin}
        {...(currentPath !== undefined ? { currentPath } : {})}
      />
      <div className="flex-1 p-6">{children}</div>
    </div>
  );
}
