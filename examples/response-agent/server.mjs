import { createServer } from "node:http";

const baseUrl = new URL(process.env.CHATBOT_BASE_URL ?? "http://127.0.0.1:8000");
const expectedToken = process.env.CHATBOT_API_KEY ?? "demo-local-key";
const policyMode = process.env.AW_FAQ_POLICY ?? "current";
const maximumBodyBytes = 64 * 1024;
if (policyMode !== "current" && policyMode !== "stale") {
  console.error("AW_FAQ_POLICY must be current or stale.");
  process.exit(2);
}

function unusedReturnWindow() {
  if (policyMode === "stale") {
    return "Orders placed in the synthetic catalog may be returned within 14 days when the item is unused.";
  }
  return "Orders placed in the synthetic catalog may be returned within 30 days when the item is unused.";
}
const colors = ["red", "blue", "green", "yellow", "purple", "orange", "teal"];
const sessions = new Map();

function sendJson(response, status, body) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(encoded),
    "cache-control": "no-store"
  });
  response.end(encoded);
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBodyBytes) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? {} : JSON.parse(text);
}

function colorFrom(text) {
  const match = new RegExp(`\\b(${colors.join("|")})\\b`, "i").exec(text);
  return match?.[1]?.toLowerCase();
}

function faqAnswer(message) {
  if (/\[aw-connection-probe\].*probe-ack/i.test(message) || /^\[aw-connection-probe\] Reply with the token probe-ack/i.test(message)) {
    return "probe-ack";
  }
  if (/warranty/i.test(message)) {
    return "Warranty replacement is a separate process from a standard unused-item return.";
  }
  if (/restocking/i.test(message)) {
    return "Unused synthetic returns incur a 10% restocking fee.";
  }
  if (/reset.*password|password.*reset/i.test(message)) {
    return "Password resets are available from the synthetic account page.";
  }
  if (/shipping/i.test(message)) {
    return "Synthetic shipments use ground service.";
  }
  if (/14\s*days/i.test(message) && /return/i.test(message)) {
    if (policyMode === "stale") return unusedReturnWindow();
    return "The 14-day unused-return page is stale. The current unused-item return window is 30 days.";
  }
  if (/return window|how long.*return|unused-item return|returned within/i.test(message)) {
    return unusedReturnWindow();
  }
  return undefined;
}

function sessionAnswer(session, message) {
  const faq = faqAnswer(message);
  if (faq !== undefined) return faq;
  if (/what color/i.test(message)) {
    for (let index = session.userMessages.length - 1; index >= 0; index -= 1) {
      const color = colorFrom(session.userMessages[index] ?? "");
      if (color !== undefined) return `You said the color was ${color}.`;
    }
    return "I don't remember a previous color.";
  }
  return `Noted: ${message}`;
}

function replayKey(conversationId, turnId, idempotencyKey) {
  return `${conversationId}\0${turnId}\0${idempotencyKey}`;
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }

    if (request.headers.authorization !== `Bearer ${expectedToken}`) {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }

    if (request.method !== "POST" || request.url !== "/chat") {
      sendJson(response, 404, { error: "not_found" });
      return;
    }

    const body = await readJson(request);
    if (typeof body.message !== "string" || body.message === "") {
      sendJson(response, 400, { error: "message_required" });
      return;
    }

    const conversationId = body.conversation_id;
    const turnId = typeof body.turn_id === "string" ? body.turn_id : "turn";
    const idempotencyKey = request.headers["aw-idempotency-key"];

    if (typeof conversationId === "string" && conversationId !== "") {
      let session = sessions.get(conversationId);
      if (session === undefined) {
        session = { userMessages: [], accepted: new Map() };
        sessions.set(conversationId, session);
      }
      if (typeof idempotencyKey === "string") {
        const key = replayKey(conversationId, turnId, idempotencyKey);
        const cached = session.accepted.get(key);
        if (cached !== undefined) {
          sendJson(response, 200, cached);
          return;
        }
        session.userMessages.push(body.message);
        const payload = {
          answer: sessionAnswer(session, body.message),
          finished: true,
          user_turn_count: session.userMessages.length
        };
        session.accepted.set(key, payload);
        sendJson(response, 200, payload);
        return;
      }
      session.userMessages.push(body.message);
      sendJson(response, 200, {
        answer: sessionAnswer(session, body.message),
        finished: true,
        user_turn_count: session.userMessages.length
      });
      return;
    }

    sendJson(response, 200, {
      answer: faqAnswer(body.message) ?? "This synthetic FAQ does not contain that fact.",
      finished: true
    });
  } catch (error) {
    const status = error instanceof Error && error.message === "request_too_large" ? 413 : 400;
    sendJson(response, status, { error: status === 413 ? "request_too_large" : "invalid_json" });
  }
});

server.listen(Number(baseUrl.port || 8000), baseUrl.hostname, () => {
  console.log(`Response-only mock listening on ${baseUrl.origin}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
