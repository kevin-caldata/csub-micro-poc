# Demo Spec 02 — The Six Static Fake Tools

Date: 2026-07-19 · Project: CSUB-RIO self-serve demo · Status: Draft for review
Depends on: base Spec 07 (`buildMcpServer()` FR-5 extension point, `registerTool` raw-shape pattern, `runTool` never-throws contract — `docs/specs/07-mcp-server-and-tool-loop.md`), base Spec 08 (`logEvent` — `src/logger.ts:63-66`) · Enables: Demo Spec for `ask_campus_knowledge` (shares the same `buildMcpServer()` body and the `// FR-5:` insertion point), Demo persona/instructions spec (consumes the exact tool names + description texts below), Demo announcement-email spec (consumes the `get_current_time` campus-time behavior for the rewritten "what time is it" showcase item).
Findings referenced: findings/16 (§C1 extension point, §C13 static/delegated taxonomy, §C14 self-serve pivot), findings/13 (claims 1–11 directory, 16–19 MyID/Duo vocabulary, 20–22 crisis numbers), findings/17 (§4.2 description style, §4.4 three-lane routing, §4.5 crisis never touches the knowledge tier, §5.4 behavior-contract tool separation), findings/12 (§3.6 return-as-script), findings/11 (§C3 existing tool surface); `docs/demo/RIO-INTELLIGENT-TOOLS-CONCEPT.md` (§2 taxonomy, §6 tool surface).

---

## Objective

When this spec is done, `buildMcpServer()` in `src/mcp-server.ts` registers exactly six **static fake tools** — `escalate_to_human`, `route_call`, `verify_identity`, `reset_password`, `send_sms`, `get_current_time` — each a single `registerTool` block at the FR-5 extension point (`src/mcp-server.ts:37`), each **deterministic and LLM-free**: no model call, no network I/O, no timers, pure synchronous computation plus one `logEvent` line [findings/16 §C13]. The hello-world `hello` tool is retired from the live surface and its test coverage migrated. The stateless-server constraint (fresh `McpServer` per request — `src/mcp-server.ts:7-9`) is honored by carrying the only piece of cross-tool state — the identity-verification token — **inside tool arguments and results**, never in server memory (R9). The realtime model reads only the tool descriptions and JSON returns; both are therefore written as tool-selection guidance ("Use when / Do NOT use when" blocks per findings/17 §4.2) and as speakable script material (return-as-script, findings/12 §3.6).

The crisis path is LLM-free and **simulated-only**: `escalate_to_human` speaks real resource numbers verbatim but never transfers — no bridge/TwiML changes, no `<Connect>` modifications [findings/17 §4.5; findings/16 §C14].

## Deliverables

- Modify `src/mcp-server.ts` — remove the `hello` registration (`src/mcp-server.ts:27-36`), rename the server, add five new `registerTool` blocks, restate `get_current_time` per R8, add the module-level constants of R2/R4/R5. Keep the `// FR-5:` comment as the last line of `buildMcpServer()`'s tool block (it is the documented insertion point the `ask_campus_knowledge` spec uses).
- New `test/static-tools.test.ts` — per-tool vitest coverage via the existing harness pattern of `test/mcp-server.test.ts:8-30` (Fastify on port 0 + raw JSON-RPC `fetch`).
- Modify `test/mcp-server.test.ts`, `test/tools.test.ts`, `test/harness.test.ts`, `test/fakes/fake-gateway.ts` — hello-retirement migrations per R10. **No other test file changes** (`test/tool-mapping.test.ts` runs against the frozen findings/05 fixture, not the live server — `test/tool-mapping.test.ts:1-9`; `test/tool-loop.test.ts:136` and `test/session-turns.test.ts:274` use stubbed executors where the tool name is arbitrary).
- No `package.json` changes (uses only the pinned `zod@3.25.76`, `node:crypto`, and existing imports). No `src/config.ts` changes — **this spec introduces zero env keys**; `MCP_MODEL_ID` / `MCP_MODEL_MAX_TOKENS` / `MCP_TOOL_TIMEOUT_MS` belong exclusively to the `ask_campus_knowledge` spec.

## Requirements

### Surface and conventions

**R1.** After this spec, `buildMcpServer()` registers **exactly six** tools: `escalate_to_human`, `route_call`, `verify_identity`, `reset_password`, `send_sms`, `get_current_time` (the `ask_campus_knowledge` spec later adds the seventh at the `// FR-5:` comment). The `hello` tool (`src/mcp-server.ts:27-36`) is **deleted** — it is not in the approved demo surface, and its description ("Say a friendly hello.") is a live wrong-tool-selection hazard for a greeting-heavy persona [findings/17 §5.1]. Rename the server identity to `new McpServer({ name: 'rio-demo', version: '1.0.0' })` (metadata only; nothing asserts the old `'hello-world'` name). Tool defs propagate to the realtime session with zero further wiring via the per-call `listTools()` → `fetchToolDefs` path (`src/tools.ts:30-36`) [findings/16 §C1].

**R2.** Shared conventions, all six tools:

1. **LLM-free and deterministic**: handlers contain no network calls, no `await` of anything asynchronous (they may still be declared `async` to match the existing pattern), no timers, no reads of `Date`-dependent state except `get_current_time`, and no randomness except the two opaque IDs defined in R5/R7.
2. **Return shape**: one MCP text content item whose `text` is **minified JSON** — `{ content: [{ type: 'text' as const, text: JSON.stringify(payload) }] }`. Exception: none; even `get_current_time` moves to a JSON payload (R8). `runTool` then wraps this in its own envelope (`src/tools.ts:50`), which is fine — the model reads nested JSON without issue, and the discipline of small payloads keeps the realtime-context cost negligible [findings/16 §C16].
3. **Simulation flag**: every payload's **first key** is `"simulated"` — `true` for the five fake tools, `false` for `get_current_time` (its data is real; that contrast is the demo beat the announcement email showcases). This is the in-band honesty marker replacing the retired presenter disclosures [findings/16 §C14].
4. **Input schemas**: zod **raw shape** (plain object of zod schemas, never `z.object(...)`) exactly as base Spec 07 R5 mandates; `zod@3.25.76` pinned. Every field carries `.describe(...)` with the exact strings given below — the realtime model reads them.
5. **Logging**: each handler emits exactly one `logEvent` line (`src/logger.ts:63-66`; `LogFields` requires `level`, `message`, `event`). The stateless MCP server has **no call context**, so no `callSid`/`streamSid` fields — correlation happens via the session-level `event:"tool-call"` line the ToolLoop already emits per round trip (base Spec 07 R13). Keep every logged value scalar (`src/logger.ts:13`); truncate free-text args to 200 chars before logging (`value.slice(0, 200)`).
6. **Validation failures the model can recover from** (missing verification token, no identity detail) return a **normal payload with a `status` explaining what to do next** — never a thrown error. Throwing is reserved for genuine bugs; zod schema violations still produce the SDK's `-32602 isError` result, which `runTool` converts to `{"error": ...}` and the model apologizes (base Spec 07 R9) — both paths are non-fatal by construction [findings/16 §C11].
7. **New module-level imports** in `src/mcp-server.ts`: `import { randomBytes, randomInt } from 'node:crypto';` (used only by R5/R7). Module-level **constants** are allowed (they are immutable); module-level **mutable state is forbidden** (R9).

### Tool 1 — `escalate_to_human` (the crisis path: deterministic, instant, LLM-free)

**R3.** Register `escalate_to_human`:

- **Description** (exact string):
  `Log an escalation and get the exact phone numbers to read aloud to the caller. Use when: the caller mentions self-harm, a crisis, or danger, or is distressed, angry, or asks for a human. Do NOT use for: routine department transfers (use route_call). For crisis calls, call this immediately — do not ask clarifying questions first.`
- **Input schema** (both fields required):
  ```ts
  {
    reason: z.string().describe('One short sentence on why the caller needs a human.'),
    urgency: z.enum(['routine', 'urgent', 'crisis']).describe(
      "'crisis' for any mention of self-harm or danger; 'urgent' for time-sensitive or highly distressed; 'routine' otherwise.",
    ),
  }
  ```
- **Return payload** — deterministic; the `speak_this` string is selected by `urgency` and is the script the model reads near-verbatim [findings/12 §3.6]. The four real numbers are **verbatim, safety-critical, and never paraphrased by any model** — which is exactly why this tool is static [findings/17 §4.5; findings/13 claims 20–22]:

  ```json
  {
    "simulated": true,
    "status": "escalation_logged",
    "live_transfer": false,
    "speak_this": "<one of the three strings below>",
    "resources": [
      { "name": "CSUB Counseling Center", "phone": "(661) 654-3366", "note": "after hours, press 2 to reach a crisis counselor" },
      { "name": "988 Suicide & Crisis Lifeline", "phone": "988", "note": "call or text, free, 24/7" },
      { "name": "University Police (emergency)", "phone": "(661) 654-2111", "note": "or call 911" },
      { "name": "Campus Operator", "phone": "(661) 654-2782", "note": "business hours" }
    ]
  }
  ```

  `speak_this` exact strings:
  - `urgency === 'crisis'`: `Please know these are real resources that can help right now: the CSUB Counseling Center at (661) 654-3366 — after hours, press 2 to reach a crisis counselor. You can also call or text 988, the Suicide and Crisis Lifeline, free and available any time. If you are in immediate danger, call 911 or University Police at (661) 654-2111. This demo line cannot transfer your call, so please dial one of those numbers directly.`
  - `urgency === 'urgent'`: `The campus operator at (661) 654-2782 can connect you with a person during business hours. If this is a safety concern, University Police are at (661) 654-2111, or call 911. This demo line cannot transfer your call, so please dial directly.`
  - `urgency === 'routine'`: `The campus operator at (661) 654-2782 can connect you with any campus office during business hours. This demo line cannot transfer your call, so please dial that number directly.`
- **Log event** (the crisis-escalation record):
  ```ts
  logEvent({
    level: urgency === 'crisis' ? 'warn' : 'info',
    message: 'escalation requested',
    event: 'crisis-escalation',
    tool: 'escalate_to_human',
    urgency,
    reason: reason.slice(0, 200),
  });
  ```
- **No transfer occurs.** No TwiML, no bridge change, no `<Connect>` modification — the verbs-after-`</Connect>` hazard stays designed out. `live_transfer: false` plus the closing sentence of every `speak_this` string makes the simulation honest in-band.

### Tool 2 — `route_call` (fake context-payload handoff)

**R4.** Register `route_call`:

- **Description** (exact string):
  `Prepare a simulated transfer to a campus department. Returns the department's number, location, estimated wait, and a handoff script to read to the caller, and passes along a context note so the caller never repeats themselves. Use when: the caller asks to be transferred or needs something only that office can do. Do NOT use for: crisis or distress (use escalate_to_human) or answering factual questions (use ask_campus_knowledge).`
  (The `ask_campus_knowledge` cross-reference is valid: the tool is part of the approved surface and the prompt/tool pairing discipline of findings/17 §4.2 requires mentions to match registrations; if the knowledge-tool spec is implemented after this one, the reference is briefly dangling on live calls — acceptable, the model simply has no such tool to pick.)
- **Input schema**:
  ```ts
  {
    department: z.string().describe(
      "Department or office to reach, e.g. 'financial aid', 'admissions', 'IT help desk', 'registrar'.",
    ),
    context: z.string().optional().describe(
      "One-sentence summary of the caller's need, passed to the department so the caller does not repeat themselves.",
    ),
  }
  ```
- **Directory** — export from `src/mcp-server.ts` as a module-level constant so tests can assert against it:

  ```ts
  export interface RouteEntry {
    keywords: string[]; department: string; phone: string; extension: string;
    location: string; estimatedWaitMinutes: number;
  }
  export const ROUTE_DIRECTORY: RouteEntry[] = [ /* rows below, in this order */ ];
  ```

  | keywords (lowercase substrings) | department | phone | extension | location | wait (min) |
  |---|---|---|---|---|---|
  | `admission` | Admissions | (661) 654-3036 | 3036 | Student Services Building, 47 SA | 4 |
  | `registrar`, `records`, `transcript`, `enrollment` | Office of the Registrar | (661) 654-3036 | 3036 | Student Services Building, 47 SA | 6 |
  | `billing`, `refund`, `cashier`, `student financial` | Student Financial Services | (661) 654-3225 | 3225 | Student Services Building | 5 |
  | `financial aid`, `fafsa`, `scholarship`, `aid` | Financial Aid & Scholarships | (661) 654-3016 | 3016 | Student Services Building | 8 |
  | `it`, `help desk`, `password`, `tech`, `duo`, `netid` | ITS Service Center | (661) 654-4357 | 4357 | Walter W. Stiern Library, Room 13 | 3 |
  | `health` | Student Health Services | (661) 654-2394 | 2394 | Building 28 HC | 7 |
  | `parking`, `permit` | Parking Services | (661) 654-2677 | 2677 | University Police Department, 6 PS | 5 |
  | `police`, `upd`, `safety` | University Police (non-emergency) | (661) 654-2677 | 2677 | Building 6 PS | 2 |
  | `counseling` | Counseling Center | (661) 654-3366 | 3366 | Rivendell building, near Parking Lot E | 4 |
  | `athletic`, `ticket`, `box office` | Icardo Center Box Office | (661) 654-3988 | 3988 | Icardo Center | 3 |
  | `advis` | Academic Advising (AARC) | (661) 654-2782 | 2782 | ask the caller's major, then direct via operator | 6 |

  Phone numbers, room codes, and office names are the real CSUB directory [findings/13 claims 1–10]; wait times are fabricated-deterministic. **Matching rule**: lowercase the `department` arg; scan rows top-to-bottom; the first row where **any** keyword is a substring of the arg wins (row order is authoritative — `billing` precedes `financial aid` so "student financial services" never mis-hits, and the generic `aid` keyword sits in the financial-aid row scanned after it). No match → the fallback entry (not a table row): department `Campus Operator`, phone `(661) 654-2782`, extension `2782`, location `9001 Stockdale Highway`, wait 1 [findings/13 claim 1].
- **Return payload** (field order as shown):
  ```json
  {
    "simulated": true,
    "status": "transfer_ready",
    "live_transfer": false,
    "department": "Financial Aid & Scholarships",
    "phone": "(661) 654-3016",
    "extension": "3016",
    "location": "Student Services Building",
    "estimated_wait_minutes": 8,
    "context_note": "<the context arg, or 'General inquiry.' when omitted>",
    "handoff_blurb": "I'm connecting you to Financial Aid & Scholarships at (661) 654-3016. I've passed along a note so you won't have to repeat yourself: <context_note> Estimated wait is about 8 minutes."
  }
  ```
  `handoff_blurb` is built exactly from that template (`I'm connecting you to {department} at {phone}. I've passed along a note so you won't have to repeat yourself: {context_note} Estimated wait is about {estimated_wait_minutes} minutes.`) — it IS the fake warm-transfer script the model reads [findings/12 §3.6]. The context payload (`context_note` riding inside the return) is the "no caller repeats themselves" demo beat.
- **Log event**: `logEvent({ level: 'info', message: 'static tool served', event: 'static-tool', tool: 'route_call', department: <resolved department name>, matched: <boolean, false for the operator fallback> })`.

### Tool 3 — `verify_identity` (pure theater, mints the token)

**R5.** Register `verify_identity`:

- **Description** (exact string):
  `Simulated identity check required before account actions like a password reset. Provide the caller's name or date of birth — either one is enough. Always succeeds on this demo line and returns a clearly simulated student record plus a verification_token that reset_password requires. Use when: the caller wants a password reset or account-specific help. Do NOT use for: general campus questions.`
- **Input schema** (both optional — the "one detail" rule is handler logic, not schema):
  ```ts
  {
    name: z.string().optional().describe("The caller's full name as spoken."),
    dob: z.string().optional().describe("The caller's date of birth, any spoken format."),
  }
  ```
- **Handler logic**:
  - Neither `name` nor `dob` provided (or both empty/whitespace after `.trim()`) → return
    ```json
    { "simulated": true, "verified": false, "status": "need_detail",
      "message": "Ask the caller for their name or date of birth, then call verify_identity again with it." }
    ```
  - Otherwise → **always succeed** (pure theater on fake data [findings/16 §C13]) and mint the token:
    ```json
    {
      "simulated": true,
      "verified": true,
      "status": "verified",
      "student": {
        "name": "<the name arg, or 'CSUB Student' when only dob was given>",
        "netid": "rrunner900",
        "student_id": "900123456",
        "record_flag": "SIMULATED RECORD — not a real student"
      },
      "verification_token": "SIM-V-<6 uppercase hex chars>",
      "note": "Keep the verification_token; reset_password requires it."
    }
    ```
  - **Token generation**: `` `SIM-V-${randomBytes(3).toString('hex').toUpperCase()}` `` — matches `VERIFICATION_TOKEN_REGEX` (R6). Randomness here is opaque-ID minting, not behavior nondeterminism (R2.1's carve-out); the shape is what tests assert. Never echo `dob` back in the payload (don't reflect PII-shaped input into the conversation).
- **Log event**: `logEvent({ level: 'info', message: 'static tool served', event: 'static-tool', tool: 'verify_identity', verified: <boolean>, verifiedWith: <'name' | 'dob' | 'name+dob' | 'none'> })`.

### Tool 4 — `reset_password` (consumes the token; real MyID vocabulary)

**R6.** Register `reset_password`:

- **Description** (exact string):
  `Simulated NetID password reset through CSUB's MyID system. Requires the verification_token returned by verify_identity earlier in this call — if you do not have one, call verify_identity first. Never invent or guess a token. Returns the reset steps to read to the caller.`
- **Input schema**:
  ```ts
  {
    verification_token: z.string().describe(
      'The verification_token string returned by verify_identity earlier in this call.',
    ),
  }
  ```
- **Token validation**: export `export const VERIFICATION_TOKEN_REGEX = /^SIM-V-[0-9A-F]{6}$/;` from `src/mcp-server.ts` and test the arg against it. Fail → recoverable envelope (R2.6), **not** an error:
  ```json
  { "simulated": true, "status": "not_verified",
    "message": "That token is not valid. Call verify_identity with the caller's name or date of birth, then retry reset_password with the token it returns." }
  ```
- **Success payload** — the narrative uses the **real MyID flow vocabulary verbatim** [findings/13 claims 16–18]:
  ```json
  {
    "simulated": true,
    "status": "reset_initiated",
    "system": "MyID (myid.csub.edu)",
    "narrative": "I've started a password reset through MyID. An authorization code has been sent to the personal email on file. Go to myid.csub.edu, enter your NetID, and choose 'Forgot Password / Activate Account', then enter the code. Your new password must be 11 to 255 characters and meet 3 of the 4 complexity requirements.",
    "duo_reminder": "Never share your Duo code with anyone — not even with me. If you've lost your Duo device, call the ITS Service Center at (661) 654-4357."
  }
  ```
  (The `duo_reminder` sets up the scripted beat where RIO refuses a read-aloud Duo code [findings/13 claim 18].)
- **Log event**: `logEvent({ level: 'info', message: 'static tool served', event: 'static-tool', tool: 'reset_password', tokenValid: <boolean> })`.

### Tool 5 — `send_sms` (fake send, confirmation id)

**R7.** Register `send_sms`:

- **Description** (exact string):
  `Simulated follow-up text message to the number the caller is calling from. Use when: the caller wants links, hours, or steps sent by text so they don't have to write them down. Pass a one-sentence summary of what the message should contain. No real SMS is ever sent.`
- **Input schema**:
  ```ts
  {
    to_summary: z.string().describe(
      "One sentence describing what the text should contain, e.g. 'the MyID reset link and ITS Service Center summer hours'.",
    ),
  }
  ```
- **Return payload**:
  ```json
  {
    "simulated": true,
    "status": "sent",
    "message_id": "SMS-SIM-<6 digits>",
    "to": "the number the caller is calling from",
    "body_summary": "<the to_summary arg>",
    "note": "Simulated — no real text message was sent. Tell the caller this if they ask."
  }
  ```
  **Confirmation id**: `` `SMS-SIM-${String(randomInt(0, 1000000)).padStart(6, '0')}` `` — matches `/^SMS-SIM-\d{6}$/`. No real Twilio SMS API call, no phone-number argument (the tool never collects a number — the fiction is "the number you're calling from", which avoids harvesting real caller digits into the conversation).
- **Log event**: `logEvent({ level: 'info', message: 'static tool served', event: 'static-tool', tool: 'send_sms', messageId: <the id> })`.

### Tool 6 — `get_current_time` (restated: campus time, real data)

**R8.** `get_current_time` **stays** (approved decision — the announcement email's "what time is it" item becomes a tool-call showcase) but is restated: the container clock on Railway `us-east4` is UTC, and a demo whose callers are in Bakersfield must speak **Pacific** time, so the payload carries both:

- **No `inputSchema` key** in the config (SDK advertises `{"type":"object","properties":{}}`; handler signature `(extra) => ...` — unchanged from base Spec 07 R5).
- **Description** (exact string):
  `Returns the real current date and time on the CSUB campus (Pacific Time), plus UTC. Use when: the caller asks the time, the date, or the day of the week. This is real data, not simulated.`
- **Return payload**:
  ```json
  {
    "simulated": false,
    "utc": "<new Date().toISOString()>",
    "campus_time": "<Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'full', timeStyle: 'short' }).format(new Date())>",
    "timezone": "America/Los_Angeles"
  }
  ```
  Example `campus_time`: `Saturday, July 18, 2026 at 2:07 PM`. The hardcoded `America/Los_Angeles` (not the container's resolved zone) is deliberate — it makes the answer correct regardless of deploy region.
- **Log event**: `logEvent({ level: 'info', message: 'static tool served', event: 'static-tool', tool: 'get_current_time' })`.

### Statelessness — the verify→reset token flow

**R9.** `buildMcpServer()` constructs a **fresh server per POST** (`src/mcp-server.ts:7-9, 44-49`; runtime-enforced, base Spec 07 R2), so **no handler may read or write module-level mutable state** — there is nowhere to remember that a caller verified. The only cross-tool state in this spec is the verification token, and it rides **entirely in the conversation**:

1. `verify_identity` mints `verification_token` inside its JSON return (R5).
2. The token reaches the realtime model as ordinary `function-call-output` text (`src/tools.ts:135-138` path).
3. The model passes it back as `reset_password`'s `verification_token` argument — prompted to do so by both tools' description texts and `verify_identity`'s in-payload `note` (R5/R6).
4. `reset_password` validates **shape only** (`VERIFICATION_TOKEN_REGEX`) — with no server memory there is nothing else to check against, and shape-checking is exactly enough theater: a model that never called `verify_identity` has no `SIM-V-XXXXXX`-shaped string in context to supply, while a hallucinated token either matches the regex (harmless — the whole flow is simulated) or hits the recoverable `not_verified` envelope that routes it back to `verify_identity`.

This constraint is normative for future static tools: **any cross-tool state must ride in tool args/results.** Module-level *constants* (`ROUTE_DIRECTORY`, `VERIFICATION_TOKEN_REGEX`, and the corpus load owned by the knowledge-tool spec) are fine; module-level mutable state is a defect.

### Test migrations (hello retirement)

**R10.** The `hello` tool is asserted across the suite; migrate as follows (and only as follows):

1. **`test/mcp-server.test.ts`** — the A1 exact-list assertion (`test/mcp-server.test.ts:33-41`) becomes containment + exclusion, so this file survives the knowledge-tool spec adding its seventh tool without another edit:
   ```ts
   for (const name of ['escalate_to_human', 'get_current_time', 'reset_password', 'route_call', 'send_sms', 'verify_identity']) {
     expect(names).toContain(name);
   }
   expect(names).not.toContain('hello');
   ```
   Replace the `hello` call test (`:43-53`) with a `verify_identity` call test (args `{ name: 'Ada' }` → parse `content[0].text`, expect `verified === true` and `student.name === 'Ada'`). Update the `get_current_time` call test (`:55-65`) to parse `content[0].text` as JSON and assert `utc` matches `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/` and `timezone === 'America/Los_Angeles'`.
2. **`test/tools.test.ts`** — `fetchToolDefs` count assertion (`:33-39`) becomes `defs.length >= 6`; the `hello` schema-mapping test (`:56-63`) migrates to `verify_identity` (same optional-string shape: `parameters.properties.name` equals `{ type: 'string', description: "The caller's full name as spoken." }`, `parameters.required` is `undefined` since both fields are optional). `runTool` bad-args (`:68`), valid-args (`:101-106`), and transport-failure (`:119`) tests swap `'hello'` for `'verify_identity'`; the valid-args assertion becomes: parse `content[0].text`, expect `verified === true`, `verification_token` matches `VERIFICATION_TOKEN_REGEX`. The three `get_current_time` guard tests (`:80-99`) keep their empty/whitespace/`"{}"` args but assert the new JSON shape per item 1.
3. **`test/fakes/fake-gateway.ts`** — `runToolCallScript` (`test/fakes/fake-gateway.ts:364-381`) changes `name: 'hello'` → `name: 'verify_identity'` (keep `arguments: '{"name":"Kevin"}'`; the doc comment at `:359` updates to match).
4. **`test/harness.test.ts`** — the real-MCP-round-trip assertions (`test/harness.test.ts:360-375`) become: `itemCreate.item.name === 'verify_identity'`; parse `output.content[0].text` as JSON and expect `verified === true`, `student.name === 'Kevin'`, and `verification_token` matching `VERIFICATION_TOKEN_REGEX` (structural match replaces the old exact `'Hello, Kevin!'` — the token suffix is random). The exactly-one-gated-`response-create` assertion is untouched.
5. **Do not touch**: `test/tool-mapping.test.ts` and `test/fixtures/list-tools-response.ts` (frozen findings/05 fixture; tests pure mapping logic, tool names are historical data), `test/tool-loop.test.ts`, `test/session-turns.test.ts` (stubbed executors; names arbitrary).

**R11.** The test-asserted tool-preamble sentence in the `INSTRUCTIONS` const must survive untouched: `src/gateway.ts:241-244` contains — and `test/gateway.session-config.test.ts:101-102` and `:124-127` assert the exact substring — `Before calling any tool, briefly say you're checking (e.g., 'One moment, let me look that up').` This spec changes nothing in `src/gateway.ts`; the constraint is recorded because the description texts above must not contradict it (they don't — none of them instruct the model to skip preambles; reconciling preamble behavior for the crisis tool is the persona spec's job, and until then a one-line preamble before `escalate_to_human` costs nothing since the tool resolves in microseconds).

## Interfaces

**Consumed from the existing codebase:**
- `buildMcpServer()` / `mcpRoutes(app)` exports and the per-request stateless pattern — `src/mcp-server.ts:8, 41` (signatures unchanged).
- `logEvent(fields: LogFields)` — `src/logger.ts:63-66` (requires `level`, `message`, `event`; scalar values).
- `runTool`'s 5000 ms transport cap and never-throws envelope — `src/tools.ts:42, 51-54` (unchanged; static tools resolve in microseconds and never approach it).
- `zod@3.25.76` raw-shape `inputSchema` convention — base Spec 07 R5.

**Produced for other specs:**
- Tool names (exact, the demo static surface): `escalate_to_human`, `route_call`, `verify_identity`, `reset_password`, `send_sms`, `get_current_time` — the persona/instructions spec must mention exactly these (plus `ask_campus_knowledge`) and no others [findings/17 §4.2].
- New exports from `src/mcp-server.ts`: `ROUTE_DIRECTORY: RouteEntry[]`, `VERIFICATION_TOKEN_REGEX: RegExp` (`/^SIM-V-[0-9A-F]{6}$/`).
- Log event names: `crisis-escalation` (escalate only; `level: 'warn'` when `urgency === 'crisis'`, else `'info'`) and `static-tool` (the other five; `level: 'info'`, `message: 'static tool served'`, `tool: <name>`).
- Magic strings/formats: `verification_token` format `SIM-V-` + 6 uppercase hex; `send_sms` `message_id` format `SMS-SIM-` + 6 digits; payload key `simulated` as first key everywhere; `speak_this` / `handoff_blurb` / `narrative` as the speakable-script keys.
- `get_current_time` payload keys `utc` / `campus_time` / `timezone` with `timezone: 'America/Los_Angeles'` — the announcement-email spec's rewritten "what time is it" showcase item must describe the tool as returning real campus (Pacific) time.
- The `// FR-5:` comment remains the last line of the tool block in `buildMcpServer()` — the `ask_campus_knowledge` spec inserts there.
- **Zero env keys** introduced or consumed by this spec.

## Acceptance criteria

All via the `test/mcp-server.test.ts:8-30` harness pattern (Fastify port 0, raw JSON-RPC `fetch` with `content-type: application/json` + `accept: application/json, text/event-stream`) in the new `test/static-tools.test.ts`, except A9/A10 which live in the migrated files. Run: `npx vitest run` — full suite green.

- **A1** (surface): `tools/list` contains all six R1 names and does **not** contain `hello`. Every tool with args advertises a `$schema`-bearing zod-derived `inputSchema`; `get_current_time` advertises `{"type":"object","properties":{}}`.
- **A2** (escalate, crisis): `tools/call escalate_to_human {reason:'caller mentioned self-harm', urgency:'crisis'}` → 200; payload parses with `simulated === true`, `status === 'escalation_logged'`, `live_transfer === false`; `speak_this` equals the exact R3 crisis string; `resources` contains exactly the four R3 entries; the strings `(661) 654-3366`, `988`, `(661) 654-2111`, `(661) 654-2782` all appear in `JSON.stringify(payload)`. Using the `withCapturedOutput` pattern from `test/logger.test.ts:6-29` around a direct in-process call (or spying on `process.stdout.write`), exactly one log line has `event: 'crisis-escalation'` and `level: 'warn'`. With `urgency:'routine'` the line is `level: 'info'` and `speak_this` equals the exact routine string.
- **A3** (route, hit): `route_call {department:'financial aid', context:'asking about fall disbursement'}` → `department === 'Financial Aid & Scholarships'`, `phone === '(661) 654-3016'`, `extension === '3016'`, `estimated_wait_minutes === 8`, `context_note === 'asking about fall disbursement'`, and `handoff_blurb` equals the R4 template rendered with those values.
- **A4** (route, fallback + ordering): `route_call {department:'basket weaving club'}` → `department === 'Campus Operator'`, `phone === '(661) 654-2782'`, `context_note === 'General inquiry.'`; `route_call {department:'student financial services'}` → `Student Financial Services` (proves the billing row wins before the `financial aid` row); `route_call {department:'IT help desk'}` → `ITS Service Center`.
- **A5** (verify): `verify_identity {}` → `verified === false`, `status === 'need_detail'`. `verify_identity {name:'Ada Lovelace'}` → `verified === true`, `student.name === 'Ada Lovelace'`, `student.record_flag === 'SIMULATED RECORD — not a real student'`, `verification_token` matches `VERIFICATION_TOKEN_REGEX`. `verify_identity {dob:'March 5 2004'}` → `verified === true`, `student.name === 'CSUB Student'`, and the payload JSON contains no occurrence of `'March 5 2004'` (dob never echoed).
- **A6** (verify→reset flow, stateless): in one test, call `verify_identity {name:'Ada'}` on the shared app, extract `verification_token`, then call `reset_password {verification_token}` — `status === 'reset_initiated'` and `narrative` contains the exact substrings `myid.csub.edu`, `'Forgot Password / Activate Account'`, `authorization code`, `personal email on file`, and `11 to 255 characters`. (The two calls hit two fresh `McpServer` instances — passing proves the token flow needs no server memory.)
- **A7** (reset, bad token): `reset_password {verification_token:'nope'}` → 200 (not an `isError` result), `status === 'not_verified'`; `reset_password {}` → the SDK `-32602` validation `isError` path (missing required field), which `runTool` would surface as `{"error": ...}` — assert `result.isError === true` at the JSON-RPC level.
- **A8** (sms + time): `send_sms {to_summary:'MyID reset link'}` → `status === 'sent'`, `message_id` matches `/^SMS-SIM-\d{6}$/`, `body_summary === 'MyID reset link'`. `get_current_time {}` → `simulated === false`, `utc` matches `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/`, `timezone === 'America/Los_Angeles'`, `campus_time` is a non-empty string containing a comma (Intl `dateStyle:'full'` output).
- **A9** (migrations): the R10 edits are applied; `npx vitest run test/mcp-server.test.ts test/tools.test.ts test/harness.test.ts` passes; `grep -r "'hello'" test/tools.test.ts test/mcp-server.test.ts test/harness.test.ts test/fakes/fake-gateway.ts` finds no live-server references to the retired tool (fixture files exempt per R10.5).
- **A10** (no regression): the full suite passes (`npx vitest run`); `test/tool-mapping.test.ts`, `test/tool-loop.test.ts`, and `test/session-turns.test.ts` pass **without modification**; `test/gateway.session-config.test.ts` passes unmodified (R11 — the preamble sentence untouched).
- **A11** (determinism/no-LLM): `src/mcp-server.ts` contains no import from `'ai'` and no reference to `generateText`/`generateObject`/`fetch` inside the six static handlers; calling each static tool twice with identical args yields byte-identical payloads except the `verification_token` / `message_id` / time fields.
- **A12** (statelessness): no `let`/mutable module-level binding is added to `src/mcp-server.ts` (review check: every new module-scope declaration is `const` and deep-frozen by convention or trivially immutable).

## Non-goals / out of scope

- **No LLM calls** — `ask_campus_knowledge`, the `ai@7.x` dependency, `MCP_MODEL_ID` / `MCP_MODEL_MAX_TOKENS` / `MCP_TOOL_TIMEOUT_MS`, corpus loading, and the `{status, response_text}` / `NOT_FOUND` envelope belong to the knowledge-tool spec. The static tools never touch that envelope shape — their payloads are the shapes defined here.
- **No real side effects**: no real SMS (no Twilio Messages API call anywhere), no real call transfer (no TwiML/`<Connect>`/bridge changes), no real password reset, no real student data. Real content is limited to phone numbers, office names, room codes, and MyID vocabulary from findings/13.
- **No `INSTRUCTIONS`/persona changes** (`src/gateway.ts:241-248` untouched — R11); the three-lane answering policy and escalation prompt section are the persona spec's deliverable [findings/17 §4.4].
- **No `create_ticket` tool** — the approved surface is exactly six static tools; the concept doc's optional `create_ticket` is dropped (its ServiceNow "INC0012345" beat survives inside `reset_password`'s MyID narrative territory only if the persona spec wants it — not here).
- **No announcement-email edits** — reconciling the "what time is it" item with R8's campus-time behavior is the email spec's job (this spec only fixes the tool's behavior it will describe).
- **No `runTool`/`ToolLoop`/`fetchToolDefs` changes** (`src/tools.ts` untouched) and no `/mcp` route-handler changes (`src/mcp-server.ts:41-77` untouched) — everything in this spec lives inside `buildMcpServer()`'s tool block plus module-level constants.
- **No auth/`allowedHosts` hardening** for `/mcp` (base Spec 07 R6 decision stands; the tools remain fake-data-only, so public reachability stays risk-accepted).
