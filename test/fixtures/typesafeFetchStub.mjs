// Preloaded into the engine's child process with `node --import`, in place of the network. The
// engine has no test hook of its own: this replaces `globalThis.fetch` before the engine loads, so
// production code runs unchanged and no request can leave the machine.
//
// QVAL_STUB_PLAN names a JSON file: `{ "default"?: Reply, "tickets"?: { "<id>": Reply } }`, where a
// Reply is `"answer"` (a well-formed answer to every question asked, the default) or
// `{ "status": n, "body": string | object, "echoAuth"?: true }`. `echoAuth` appends the request's
// Authorization header to the body, standing in for an API that echoes it back in an error.
// QVAL_STUB_LOG names a file that gets one JSON line per request.

import { appendFileSync, readFileSync } from 'node:fs'

const plan = process.env.QVAL_STUB_PLAN ? JSON.parse(readFileSync(process.env.QVAL_STUB_PLAN, 'utf8')) : {}

function answerAll(request) {
  const answers = {}
  for (const [id, q] of Object.entries(request.questions ?? {})) {
    if (q.type === 'noul') answers[id] = { type: 'noul', noul: 0.8 }
    else if (q.type === 'choice') answers[id] = { type: 'choice', choice: Object.keys(q.criteria)[0], confidence: 0.9 }
    else answers[id] = { type: 'score', score: 1.4, confidence: 0.7 }
  }
  return { model: 'jev-1.13', answers, usage: { input_tokens: 10, output_tokens: 1 } }
}

globalThis.fetch = async (url, init) => {
  const request = JSON.parse(init.body)
  const auth = init.headers.authorization
  const ticketId = /<<<TICKET (\d+)>>>/.exec(request.state?.support_ticket ?? '')?.[1] ?? '?'
  if (process.env.QVAL_STUB_LOG) {
    appendFileSync(process.env.QVAL_STUB_LOG, `${JSON.stringify({ url, auth, ticketId, request })}\n`)
  }
  const reply = plan.tickets?.[ticketId] ?? plan.default ?? 'answer'
  if (reply === 'answer') return new Response(JSON.stringify(answerAll(request)), { status: 200 })
  let body = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {})
  if (reply.echoAuth) body += ` (sent: ${auth})`
  return new Response(body, { status: reply.status ?? 200 })
}
