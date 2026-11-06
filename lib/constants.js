export const EXIT = {
  OK: 0,
  FAIL: 1,
  ENV: 2,
  PRECONDITION: 3,
};

export const PHASES = {
  backup: [
    'discovering',
    'dumping',
    'packing-addons',
    'packing-pydeps',
    'packing-conf',
    'compressing',
    'transferring',
    'encrypting',
    'verifying',
    'cleaning',
    'done',
  ],
  restore: [
    'uploading',
    'verifying-package',
    'precheck',
    'safety-backup',
    'restoring-temp',
    'verifying-temp',
    'switching',
    'starting',
    'verifying',
    'smoke',
    'done',
  ],
};

export const STATE = {
  IDLE: 'IDLE',
  SAFETY_BACKED_UP: 'SAFETY_BACKED_UP',
  TEMP_RESTORED: 'TEMP_RESTORED',
  TEMP_VERIFIED: 'TEMP_VERIFIED',
  SWITCHING: 'SWITCHING',
  SWITCHED: 'SWITCHED',
  VERIFIED: 'VERIFIED',
  COMMITTED: 'COMMITTED',
  ROLLED_BACK: 'ROLLED_BACK',
  FAILED: 'FAILED',
};

export const DEFAULT_TIMEOUT_MS = 30000;
export const TRANSFER_TIMEOUT_MS = 3600000;
