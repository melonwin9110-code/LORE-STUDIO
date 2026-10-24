import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { MAX_PORTRAIT_BYTES, preparePortrait } from "../../src/server/portraits";

function source(width = 8, height = 4) {
  return sharp({ create: { width, height, channels: 4, background: { r: 98, g: 62, b: 170, alpha: 1 } } });
}

describe("portrait content validation and safe image conversion", () => {
  it("decodes a real PNG and stores static WebP with known dimensions", async () => {
    const output = await preparePortrait(await source().png().toBuffer(), "image/png");
    expect(output.contentType).toBe("image/webp");
    const metadata = await sharp(output.bytes).metadata();
    expect(metadata.format).toBe("webp");
    expect([metadata.width, metadata.height]).toEqual([8, 4]);
    expect(metadata.exif).toBeUndefined();
  });
  it("resizes a large valid image and strips original metadata", async () => {
    const bytes = await source(1600, 800).jpeg().withMetadata({ orientation: 1 }).toBuffer();
    const output = await preparePortrait(bytes, "image/jpeg");
    expect([output.width, output.height]).toEqual([1200, 600]);
    expect((await sharp(output.bytes).metadata()).exif).toBeUndefined();
  });
  it("rejects HTML and SVG rather than treating uploads as executable documents", async () => {
    await expect(preparePortrait(Buffer.from("<script>alert(1)</script>"), "text/html")).rejects.toMatchObject({ status: 415 });
    await expect(preparePortrait(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), "image/svg+xml")).rejects.toMatchObject({ status: 415 });
  });
  it("rejects corrupt bytes and mismatched declared image formats", async () => {
    await expect(preparePortrait(Buffer.from("not a PNG"), "image/png")).rejects.toMatchObject({ status: 400 });
    await expect(preparePortrait(await source().png().toBuffer(), "image/jpeg")).rejects.toMatchObject({ status: 400 });
  });
  it("rejects empty files and the actual byte limit before decoding", async () => {
    await expect(preparePortrait(Buffer.alloc(0), "image/png")).rejects.toMatchObject({ status: 400 });
    await expect(preparePortrait(Buffer.alloc(MAX_PORTRAIT_BYTES + 1), "image/png")).rejects.toMatchObject({ status: 413 });
  });
  it("rejects excessively wide image input", async () => {
    await expect(preparePortrait(await source(8193, 1).png().toBuffer(), "image/png")).rejects.toMatchObject({ status: 400 });
  });
});
