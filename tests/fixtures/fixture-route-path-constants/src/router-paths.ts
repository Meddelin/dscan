export const ROOT_PATH = '/';

export const ROUTER_PATHS = {
  root: '/',
  dashboard: '/dashboard',
  checkout: {
    payment: '/checkout/payment',
    confirm: '/checkout/confirm',
  },
} as const;
