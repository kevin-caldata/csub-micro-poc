// Verbatim `listTools()` response fixture from findings/05 C8 (spike-observed shape
// from @modelcontextprotocol/sdk@1.29.0's tools/list handler — zod-shape path, target
// JSON Schema draft-07). Spec 10 R4 requires this exact shape, including the
// `execution: { taskSupport: 'forbidden' }` field and the `$schema` key on the
// zod-shaped tool's `inputSchema` — both of which `fetchToolDefs` (src/tools.ts) must
// strip/never leak (R4.1/R4.2). Do NOT "clean up" this fixture — its noise is the point.
export const LIST_TOOLS_RESPONSE_FIXTURE = {
  tools: [
    {
      name: 'get_current_time',
      description: 'Returns the current time in ISO format with timezone.',
      inputSchema: { type: 'object', properties: {} },
      execution: { taskSupport: 'forbidden' },
    },
    {
      name: 'hello',
      description: 'Say hello to someone.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Name to greet' } },
        additionalProperties: false,
        $schema: 'http://json-schema.org/draft-07/schema#',
      },
      execution: { taskSupport: 'forbidden' },
    },
  ],
};
