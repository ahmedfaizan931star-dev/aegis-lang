// Entry point "aegis-lang/node": the real host (disk, network, process.env) for Node 20+.
// It is a separate file so the main entry stays free of Node-only code (the playground uses it in a browser).
export { nodeHost } from './node-host.js';
