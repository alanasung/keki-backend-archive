import type { NavItem, Surface } from '@keki/ui';

export const navConfig: Readonly<Record<Surface, readonly NavItem[]>> = {
  customer: [
    { label: 'Book', href: '/book' },
    { label: 'Account', href: '/account' },
  ],
  kiosk: [
    { label: 'Book', href: '/kiosk/book' },
    { label: 'Waiver', href: '/kiosk/waiver' },
  ],
  staff: [
    { label: 'Today', href: '/staff/today' },
    { label: 'Check-in', href: '/staff/check-in' },
    { label: 'Occupancy', href: '/staff/occupancy' },
  ],
  admin: [
    { label: 'Offerings', href: '/admin/offerings' },
    { label: 'Schedules', href: '/admin/schedules' },
    { label: 'Reservations', href: '/admin/reservations' },
    { label: 'Customers', href: '/admin/customers' },
  ],
};
