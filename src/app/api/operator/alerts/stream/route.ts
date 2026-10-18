import { NextResponse } from "next/server";

import { getDb } from "@/lib/db";
import {
  authorizeIlertAlertStream,
  formatIlertAlertSseEvent,
  getIlertAlertEvent,
  ilertAlertPendingNotificationLimit,
  ILERT_ALERT_REPLAY_MAX_BYTES,
  ILERT_ALERT_STREAM_KEEPALIVE_MS,
  openIlertAlertListener,
  parseIlertLastEventId,
  replayIlertAlertEvents,
  type IlertAlertListener,
  type StoredIlertAlertEvent,
} from "@/lib/ilert-alerts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();
const STREAM_HIGH_WATER_MARK = 16;
const STREAM_BACKPRESSURE_LIMIT = -16;

export async function GET(request: Request): Promise<Response> {
  let db: ReturnType<typeof getDb>;
  let authorization;
  try {
    db = getDb();
    authorization = await authorizeIlertAlertStream(
      db,
      request.headers.get("authorization"),
    );
  } catch {
    return unavailableResponse();
  }
  if (authorization.status === "unauthorized") {
    return NextResponse.json(
      { error: "postil login required" },
      {
        status: 401,
        headers: { "www-authenticate": 'Bearer realm="postil-operator"' },
      },
    );
  }
  if (authorization.status === "not_found") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const afterSequence = parseIlertLastEventId(
    request.headers.get("last-event-id"),
  );
  if (afterSequence === null) {
    return NextResponse.json(
      { error: "invalid Last-Event-ID" },
      { status: 400 },
    );
  }

  const pendingSequences: bigint[] = [];
  let listenerUnavailable = false;
  let terminateStream: (() => void) | undefined;
  let receiveSequence = (sequence: bigint) => {
    if (
      pendingSequences.length >= ilertAlertPendingNotificationLimit()
    ) {
      listenerUnavailable = true;
      terminateStream?.();
      return;
    }
    pendingSequences.push(sequence);
  };
  let listener: IlertAlertListener;
  try {
    listener = await openIlertAlertListener(
      (sequence) => receiveSequence(sequence),
      () => {
        listenerUnavailable = true;
        terminateStream?.();
      },
    );
  } catch {
    return unavailableResponse();
  }

  let replay: Awaited<ReturnType<typeof replayIlertAlertEvents>>;
  try {
    replay = await replayIlertAlertEvents(db, afterSequence);
  } catch {
    await listener.close();
    return unavailableResponse();
  }
  if (listenerUnavailable || authorization.expiresAt.getTime() <= Date.now()) {
    await listener.close();
    return unavailableResponse();
  }

  const preparedReplay = prepareReplay(replay.events);
  const replayTruncated = replay.overflow || preparedReplay.truncated;
  if (replayTruncated) {
    await listener.close();
    return replayOnlyResponse(preparedReplay.events);
  }

  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        let stopped = false;
        let highestSequence = afterSequence;
        let dispatch = Promise.resolve();
        let keepalive: ReturnType<typeof setInterval> | undefined;
        let expiry: ReturnType<typeof setTimeout> | undefined;

        const cleanup = () => {
          if (stopped) return false;
          stopped = true;
          if (keepalive) clearInterval(keepalive);
          if (expiry) clearTimeout(expiry);
          request.signal.removeEventListener("abort", stop);
          void listener.close();
          return true;
        };
        const stop = () => {
          if (!cleanup()) return;
          try {
            controller.close();
          } catch {
            // The consumer may already have cancelled the stream.
          }
        };
        const rotate = () => {
          if (stopped) return;
          try {
            controller.enqueue(encoder.encode(": rotate\n\n"));
          } catch {
            // The client can reconnect from its durable cursor without the hint.
          }
          stop();
        };
        terminateStream = stop;

        controller.enqueue(encoder.encode("retry: 3000\n: connected\n\n"));
        for (const event of preparedReplay.events) {
          controller.enqueue(encoder.encode(formatIlertAlertSseEvent(event)));
          highestSequence = event.sequence;
        }

        receiveSequence = (sequence) => {
          dispatch = dispatch
            .then(async () => {
              if (stopped || sequence <= highestSequence) return;
              const event = await getIlertAlertEvent(db, sequence);
              if (!event || event.sequence <= highestSequence || stopped) return;
              if (
                controller.desiredSize !== null &&
                controller.desiredSize <= STREAM_BACKPRESSURE_LIMIT
              ) {
                stop();
                return;
              }
              controller.enqueue(encoder.encode(formatIlertAlertSseEvent(event)));
              highestSequence = event.sequence;
            })
            .catch(stop);
        };
        for (const sequence of [...new Set(pendingSequences)].sort(compareBigInt)) {
          receiveSequence(sequence);
        }
        pendingSequences.length = 0;

        keepalive = setInterval(() => {
          if (
            controller.desiredSize !== null &&
            controller.desiredSize <= STREAM_BACKPRESSURE_LIMIT
          ) {
            stop();
            return;
          }
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        }, ILERT_ALERT_STREAM_KEEPALIVE_MS);
        const expiresIn = Math.max(
          1,
          authorization.expiresAt.getTime() - Date.now(),
        );
        expiry = setTimeout(rotate, expiresIn);
        request.signal.addEventListener("abort", stop, { once: true });
        if (request.signal.aborted || listenerUnavailable) stop();
      },
      cancel() {
        terminateStream?.();
      },
    },
    { highWaterMark: STREAM_HIGH_WATER_MARK },
  );

  return sseResponse(body);
}

function prepareReplay(events: StoredIlertAlertEvent[]): {
  events: StoredIlertAlertEvent[];
  truncated: boolean;
} {
  const prepared: StoredIlertAlertEvent[] = [];
  let bytes = 0;
  for (const event of events) {
    const encodedBytes = Buffer.byteLength(formatIlertAlertSseEvent(event), "utf8");
    if (bytes + encodedBytes > ILERT_ALERT_REPLAY_MAX_BYTES) {
      return { events: prepared, truncated: true };
    }
    prepared.push(event);
    bytes += encodedBytes;
  }
  return { events: prepared, truncated: false };
}

function replayOnlyResponse(events: StoredIlertAlertEvent[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("retry: 100\n: replay batch\n\n"));
      for (const event of events) {
        controller.enqueue(encoder.encode(formatIlertAlertSseEvent(event)));
      }
      controller.close();
    },
  });
  return sseResponse(body);
}

function sseResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

function unavailableResponse(): NextResponse {
  return NextResponse.json(
    { error: "alert stream unavailable" },
    { status: 503, headers: { "retry-after": "5" } },
  );
}

function compareBigInt(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
