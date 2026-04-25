import type { ISerialInput } from "typed-binary";

export type FLPParseErrorContext = {
  schemaName: string;
  byteOffsetAbsolute: number;
  opcode?: number;
  eventIndex?: number;
  nestingPath: string[];
  precedingHex?: string;
};

export class FLPParseError extends Error {
  readonly ctx: FLPParseErrorContext;

  constructor(ctx: FLPParseErrorContext, cause?: unknown) {
    super(formatMessage(ctx, cause));
    this.name = "FLPParseError";
    this.ctx = ctx;
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }

  extend(extra: Partial<FLPParseErrorContext>): FLPParseError {
    const merged: FLPParseErrorContext = {
      ...this.ctx,
      ...extra,
      nestingPath: mergePaths(this.ctx.nestingPath, extra.nestingPath),
    };
    return new FLPParseError(merged, (this as Error & { cause?: unknown }).cause);
  }
}

function mergePaths(base: string[], extra?: string[]): string[] {
  if (!extra || extra.length === 0) return base;
  return [...extra, ...base];
}

function formatMessage(ctx: FLPParseErrorContext, cause: unknown): string {
  const parts: string[] = [];
  parts.push(`at byte ${ctx.byteOffsetAbsolute}`);
  if (ctx.eventIndex !== undefined) parts.push(`event #${ctx.eventIndex}`);
  if (ctx.opcode !== undefined) parts.push(`opcode 0x${ctx.opcode.toString(16).toUpperCase().padStart(2, "0")}`);
  const head = `FLPParseError ${parts.join(", ")}`;
  const path = ctx.nestingPath.length > 0 ? `\n  path: ${ctx.nestingPath.join(" › ")}` : "";
  const causeMsg = cause instanceof Error ? `\n  cause: ${cause.message}` : cause !== undefined ? `\n  cause: ${String(cause)}` : "";
  const hex = ctx.precedingHex ? `\n  previous bytes (hex): ${ctx.precedingHex}` : "";
  return `${head}${path}${causeMsg}${hex}`;
}

export function capturePrecedingHex(input: ISerialInput, startOffset: number, window = 16): string {
  const from = Math.max(0, startOffset - window);
  const saved = input.currentByteOffset;
  try {
    input.seekTo(from);
    const bytes: string[] = [];
    for (let i = from; i < startOffset; i++) {
      const b = input.readUint8();
      bytes.push(b.toString(16).padStart(2, "0"));
    }
    return bytes.join(" ");
  } catch {
    return "<unavailable>";
  } finally {
    input.seekTo(saved);
  }
}

/**
 * Wrap a schema's read body so every thrown error carries byte-offset and
 * nesting context. Nested calls extend the path rather than clobbering it —
 * a deep failure inside a 0xC0 payload reports the full chain from project
 * root down to the failing leaf.
 */
export function annotateRead<T>(
  schemaName: string,
  input: ISerialInput,
  extra: Partial<Omit<FLPParseErrorContext, "schemaName" | "byteOffsetAbsolute" | "nestingPath">> & { pathFragment?: string },
  inner: () => T,
): T {
  const start = input.currentByteOffset;
  const fragment = extra.pathFragment ?? schemaName;
  try {
    return inner();
  } catch (e) {
    if (e instanceof FLPParseError) {
      throw e.extend({ nestingPath: [fragment], ...stripPathFragment(extra) });
    }
    throw new FLPParseError(
      {
        schemaName,
        byteOffsetAbsolute: start,
        nestingPath: [fragment],
        precedingHex: capturePrecedingHex(input, start),
        ...stripPathFragment(extra),
      },
      e,
    );
  }
}

function stripPathFragment<T extends { pathFragment?: string }>(x: T): Omit<T, "pathFragment"> {
  const { pathFragment: _p, ...rest } = x;
  return rest;
}
