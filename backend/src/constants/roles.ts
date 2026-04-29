export const Role = {
  MASTER: 'MASTER',
  USER: 'USER',
  READER: 'READER',
  CKH_MANAGER: 'CKH_MANAGER',
  RELEASE_MANAGER: 'RELEASE_MANAGER',
} as const;

export type Role = typeof Role[keyof typeof Role];

export const ALL_ROLES: Role[] = [Role.MASTER, Role.USER, Role.READER, Role.CKH_MANAGER, Role.RELEASE_MANAGER];
