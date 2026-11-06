import { loadChainConfigs } from '../config.js';
import { SimulatedChain } from './simulated.js';
import { EvmChain } from './evm.js';

const TYPES = { simulated: SimulatedChain, evm: EvmChain };

export function buildRegistry(configs = loadChainConfigs()) {
  const reg = new Map();
  for (const c of configs) {
    const Adapter = TYPES[c.type];
    if (!Adapter) throw new Error(`Unknown chain type "${c.type}" for chain ${c.id}`);
    reg.set(c.id, new Adapter(c));
  }
  return reg;
}
