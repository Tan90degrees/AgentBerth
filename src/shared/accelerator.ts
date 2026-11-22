export const MAX_MONITORED_NODES = 3;
export const ACCELERATOR_API_VERSION = 66;
export const HOST_METRICS_API_VERSION = 67;
export const ACCELERATOR_REFRESH_SECONDS = { min: 1, default: 20, max: 300 } as const;
export const MONITOR_FONT_SIZE = { min: 9, default: 10, max: 16 } as const;

export interface AcceleratorDevice {
  id: string;
  kind: 'gpu' | 'npu';
  model: string;
  utilization: number | null;
  memory: { used: number; total: number; kind: 'VRAM' | 'HBM' | 'DDR' } | null;
  temperature: number | null;
  health?: string;
}

export interface AcceleratorSample {
  devices: AcceleratorDevice[];
  sampledAt: number;
  warning?: string;
  host?: { cpu: number | null; memory: { usedKiB: number; totalKiB: number } | null };
}

export interface AcceleratorNode {
  id: string;
  alias: string;
}

export interface AcceleratorReading {
  id: string;
  sample?: AcceleratorSample;
  error?: string;
}
