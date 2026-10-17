// Pictures in a page: VideoFrame values through WebCodecs, Image values through the image decoder
// or a pixel converter.

interface FrameValue {
  codec?: string;
  width?: number;
  height?: number;
  keyframe?: boolean;
  pts?: bigint;
  data?: Uint8Array;
}

export interface ImageValue {
  width: number;
  height: number;
  stride: number;
  format: string;
  data: Uint8Array;
}

/** The WebCodecs codec string, H264's read from its SPS so the decoder gets the real profile. */
function codecString(codec: string, data: Uint8Array): string {
  if (codec === "H264") {
    for (let i = 0; i + 4 < data.length; i++) {
      if (data[i] === 0 && data[i + 1] === 0 && (data[i + 2] === 1 || (data[i + 2] === 0 && data[i + 3] === 1))) {
        const h = i + (data[i + 2] === 1 ? 3 : 4);
        if (h + 3 < data.length && (data[h]! & 0x1f) === 7)
          return "avc1." + [data[h + 1]!, data[h + 2]!, data[h + 3]!].map((b) => b.toString(16).padStart(2, "0")).join("");
      }
    }
    return "avc1.42e01e";
  }
  if (codec === "H265") return "hev1.1.6.L120.B0";
  return "av01.0.08M.08";
}

/**
 * Decodes one stream of VideoFrame values, fed every frame in order, since a frame that only holds
 * changes needs the frames before it. Each picture is closed when the next one arrives.
 */
export class FrameDecoder {
  /** Why frames do not decode, such as a codec this engine lacks. Empty while they do. */
  error = "";
  private decoder: VideoDecoder | null = null;
  private codec = "";
  private waiting: ((f: VideoFrame | null) => void)[] = [];
  private shown: VideoFrame | null = null;

  /** The frame's picture, null until a keyframe opened the stream. */
  decode(v: FrameValue): Promise<VideoFrame | null> {
    const data = v.data;
    if (!data?.length) return Promise.resolve(null);
    if (v.codec === "Mjpeg") return this.image(data);
    if (typeof VideoDecoder === "undefined") return Promise.reject(new Error("no WebCodecs here"));
    if (!this.decoder && !v.keyframe) return Promise.resolve(null);
    const codec = v.keyframe ? codecString(v.codec ?? "", data) : this.codec;
    if (!this.decoder || codec !== this.codec) {
      this.decoder?.close();
      const d: VideoDecoder = new VideoDecoder({
        output: (f) => this.out(f),
        error: (e) => {
          this.error = `${v.codec ?? "the video"} does not decode here: ${e.message}`;
          if (this.decoder === d) this.decoder = null;
          for (const w of this.waiting.splice(0)) w(null);
        },
      });
      d.configure({ codec, optimizeForLatency: true, ...(v.width && v.height ? { codedWidth: v.width, codedHeight: v.height } : {}) });
      this.decoder = d;
      this.codec = codec;
    }
    return new Promise((res) => {
      this.waiting.push(res);
      this.decoder!.decode(new EncodedVideoChunk({ type: v.keyframe ? "key" : "delta", timestamp: Number(v.pts ?? 0n), data }));
    });
  }

  private async image(data: Uint8Array): Promise<VideoFrame | null> {
    const bmp = await createImageBitmap(new Blob([data as BlobPart], { type: "image/jpeg" }));
    const f = new VideoFrame(bmp, { timestamp: 0 });
    bmp.close();
    this.out(f);
    return f;
  }

  private out(f: VideoFrame): void {
    this.error = "";
    this.shown?.close();
    this.shown = f;
    this.waiting.shift()?.(f);
  }

  close(): void {
    this.decoder?.close();
    this.shown?.close();
    this.shown = null;
  }
}

/** JPEG, PNG and raw pixels to a picture. */
export async function decodeImage(img: ImageValue): Promise<ImageBitmap> {
  const data = img.data;
  if (img.format === "Jpeg" || img.format === "Png")
    return createImageBitmap(new Blob([data as BlobPart], { type: img.format === "Jpeg" ? "image/jpeg" : "image/png" }));
  const w = img.width, h = img.height, rgba = new Uint8ClampedArray(w * h * 4);
  const px = img.format === "Rgba8" ? 4 : img.format === "Rgb8" || img.format === "Bgr8" ? 3 : img.format === "Mono8" ? 1 : 0;
  if (!px) throw new Error(`cannot decode ${img.format} images here`);
  const stride = img.stride || w * px;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = y * stride + x * px, o = (y * w + x) * 4;
      if (px === 1) rgba[o] = rgba[o + 1] = rgba[o + 2] = data[s]!;
      else if (img.format === "Bgr8") {
        rgba[o] = data[s + 2]!;
        rgba[o + 1] = data[s + 1]!;
        rgba[o + 2] = data[s]!;
      } else {
        rgba[o] = data[s]!;
        rgba[o + 1] = data[s + 1]!;
        rgba[o + 2] = data[s + 2]!;
      }
      rgba[o + 3] = px === 4 ? data[s + 3]! : 255;
    }
  return createImageBitmap(new ImageData(rgba, w, h));
}
