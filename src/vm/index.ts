import type { CageConfig } from '../config.ts';
import { FirecrackerBackend } from './firecracker.ts';
import { LimaBackend } from './lima.ts';
import { LocalUnsafeBackend } from './local.ts';
import type { VmBackend } from './types.ts';

export function createBackend(config: CageConfig): VmBackend {
  switch (config.backend) {
    case 'lima':
      return new LimaBackend(config.lima.limactl);
    case 'firecracker':
      return new FirecrackerBackend(config.firecracker);
    case 'local-unsafe':
      return new LocalUnsafeBackend();
  }
}

export * from './types.ts';
