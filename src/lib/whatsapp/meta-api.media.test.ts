import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadMedia, sendMediaMessage } from "./meta-api";

// Capture the JSON body each helper POSTs to Meta so we can assert the
// exact payload shape per media kind without hitting the network.
interface CapturedBody {
  type?: string;
  image?: Record<string, unknown>;
  video?: Record<string, unknown>;
  document?: Record<string, unknown>;
  audio?: Record<string, unknown>;
}
let captured: CapturedBody | null = null;

function okFetch() {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    captured = init?.body ? (JSON.parse(init.body as string) as CapturedBody) : null;
    return {
      ok: true,
      json: async () => ({ messages: [{ id: "wamid.TEST" }] }),
    } as Response;
  });
}

const BASE = {
  phoneNumberId: "test-phone",
  accessToken: "test-token",
  to: "1234567890",
  link: "https://cdn.example.com/file",
} as const;

describe("sendMediaMessage — payload shape", () => {
  beforeEach(() => {
    captured = null;
    vi.stubGlobal("fetch", okFetch());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends image with a caption and no filename", async () => {
    await sendMediaMessage({ ...BASE, kind: "image", caption: "hello", filename: "x.png" });
    expect(captured?.type).toBe("image");
    expect(captured?.image).toEqual({ link: BASE.link, caption: "hello" });
    expect(captured?.image?.filename).toBeUndefined();
  });

  it("sends document with both caption and filename", async () => {
    await sendMediaMessage({
      ...BASE,
      kind: "document",
      caption: "invoice",
      filename: "invoice.pdf",
    });
    expect(captured?.type).toBe("document");
    expect(captured?.document).toEqual({
      link: BASE.link,
      caption: "invoice",
      filename: "invoice.pdf",
    });
  });

  it("sends audio with NO caption and NO filename (Meta rejects both)", async () => {
    await sendMediaMessage({
      ...BASE,
      kind: "audio",
      caption: "should be dropped",
      filename: "voice.ogg",
    });
    expect(captured?.type).toBe("audio");
    expect(captured?.audio).toEqual({ link: BASE.link });
  });

  it("throws when no link is provided", async () => {
    await expect(
      sendMediaMessage({ ...BASE, link: "", kind: "image" }),
    ).rejects.toThrow(/requires a link/);
  });
});

// `downloadMedia` decides the type of every inbound attachment, and the
// whole receipt pipeline keys off it: the vision extractor drops
// anything that is not an image or a PDF, and the media proxy hands the
// same value to the browser as `Content-Type`. Meta's CDN mislabels
// bill PDFs as `application/octet-stream` often enough that trusting
// the header meant those receipts were never read at all.
describe("downloadMedia — content type", () => {
  function cdnFetch(header: string | null, bytes: Uint8Array) {
    return vi.fn(async () => ({
      ok: true,
      headers: { get: () => header },
      arrayBuffer: async () => bytes.buffer.slice(0) as ArrayBuffer,
    }) as unknown as Response);
  }

  const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // "%PDF-1.7"
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const ARGS = { downloadUrl: "https://cdn.example.com/media", accessToken: "t" };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports a PDF the CDN mislabelled as octet-stream", async () => {
    vi.stubGlobal("fetch", cdnFetch("application/octet-stream", PDF));
    const { contentType } = await downloadMedia(ARGS);
    expect(contentType).toBe("application/pdf");
  });

  it("reports a JPEG the CDN sent with no content-type at all", async () => {
    vi.stubGlobal("fetch", cdnFetch(null, JPEG));
    const { contentType } = await downloadMedia(ARGS);
    expect(contentType).toBe("image/jpeg");
  });

  it("keeps the CDN header when the bytes are not a type we know", async () => {
    const docx = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
    vi.stubGlobal("fetch", cdnFetch("application/msword", docx));
    const { contentType } = await downloadMedia(ARGS);
    expect(contentType).toBe("application/msword");
  });

  it("falls back to octet-stream when bytes and header are both unusable", async () => {
    vi.stubGlobal("fetch", cdnFetch(null, new Uint8Array([0x00, 0x01, 0x02])));
    const { contentType } = await downloadMedia(ARGS);
    expect(contentType).toBe("application/octet-stream");
  });
});
