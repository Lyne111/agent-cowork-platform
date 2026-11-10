import { StdioJsonRpcTransport } from './transport.js';

export interface CodexHandshake {
  platformFamily: string;
  platformOs: string;
  /** This is protocol initialization only, never an authentication/readiness claim. */
  protocolInitialized: true;
}

/** Shape checked against generated codex-cli 0.167.0-alpha.4 schema.
 * Does not create a thread, start a turn, or override permission policy.
 */
export async function initializeCodex(transport: StdioJsonRpcTransport): Promise<CodexHandshake> {
  const response = await transport.request<Record<string, unknown>>('initialize', {
    clientInfo: { name: 'agent-cowork-platform', title: 'Agent Cowork', version: '0.1.0' },
    capabilities: { experimentalApi: false, requestAttestation: false },
  });
  if (!response || typeof response.platformFamily !== 'string' || typeof response.platformOs !== 'string') {
    throw new Error('Unexpected Codex initialize response; current protocol version is unverified.');
  }
  await transport.notify('initialized');
  return { protocolInitialized: true, platformFamily: response.platformFamily, platformOs: response.platformOs };
}
