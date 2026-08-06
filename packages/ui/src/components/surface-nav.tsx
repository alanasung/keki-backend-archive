import { cn } from '../cn';

export type Surface = 'customer' | 'kiosk' | 'staff' | 'admin';

export interface NavItem {
  readonly label: string;
  readonly href: string;
}

export interface SurfaceNavProps {
  readonly surface: Surface;
  readonly items: readonly NavItem[];
  readonly currentPath?: string;
  readonly className?: string;
}

export function SurfaceNav({ surface, items, currentPath, className }: SurfaceNavProps) {
  return (
    <nav aria-label={`${surface} navigation`} className={cn('flex items-center gap-4', className)}>
      <ul className="flex items-center gap-4">
        {items.map((item) => {
          const isActive = item.href === currentPath;
          return (
            <li key={item.href}>
              <a
                href={item.href}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'text-sm font-medium text-surface-700 hover:text-surface-900',
                  isActive && 'text-brand-600',
                )}
              >
                {item.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
