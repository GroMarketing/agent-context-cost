#!/usr/bin/env node
// Minimal stdio MCP server for tests: answers initialize and a paginated
// tools/list. No network, no files.
import readline from 'node:readline';

const tools = [
  { name: 'search_notes', description: 'Search notes by keyword.', inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Words to search for' }, limit: { type: 'integer' } }, required: ['query'] } },
  { name: 'read_note', description: 'Read one note by id.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'list_tags', description: 'List all tags.', inputSchema: { type: 'object', properties: {} } },
];
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' }, instructions: 'Use search_notes before read_note.' } });
  } else if (msg.method === 'tools/list') {
    const page = msg.params?.cursor === 'p2' ? tools.slice(2) : tools.slice(0, 2);
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: page, ...(msg.params?.cursor === 'p2' ? {} : { nextCursor: 'p2' }) } });
  }
});
