export const MAX_MONITORED_NODES = 3;
export const ACCELERATOR_API_VERSION = 66;
export const ACCELERATOR_SAMPLE_INTERVAL_MS = 20_000;

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
