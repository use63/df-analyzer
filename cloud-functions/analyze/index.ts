/**
 * Analyze handler — EdgeOne Makers Serverless Function
 * ====================================================
 *
 * File path cloud-functions/analyze/index.ts maps to POST /analyze.
 *
 * Performs real forensic media analysis:
 * 1. Validates upload payload (size limit, MIME type, and magic bytes).
 * 2. Writes image buffer to a unique temporary file on the local OS disk.
 * 3. Extracts real camera metadata (EXIF) in parallel using exifr.
 * 4. Calls the Reality Defender SDK detect() method with polling support.
 * 5. Normalizes results to the internal AnalyzeSuccessResponse contract.
 * 6. Always removes the temporary file in a finally block.
 */

import { RealityDefender, RealityDefenderError, type DetectionResult } from '@realitydefender/realitydefender';
import exifr from 'exifr';
import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { createLogger } from '../_logger';

const logger = createLogger('analyze');

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' } as const;

// 20 MB maximum file size limit (safe limit for EdgeOne serverless function memory)
const MAX_FILE_SIZE = 20971520;

export interface ExifData {
  camera: string | null;
  make: string | null;
  model: string | null;
  software: string | null;
  dateOriginal: string | null;
  resolution: string | null;
  width: number | null;
  height: number | null;
  lens: string | null;
  aperture: string | null;
  exposureTime: string | null;
  iso: number | string | null;
  colorSpace: string | null;
  gps: string | null;
  compression: string | null;
}

export interface AnalyzeSuccessData {
  fileName: string;
  mimeType: string;
  fileSize: number;
  analyzedAt: string;
  riskScore: number | null; // 0 - 100 percentage or null
  status: string;           // e.g. "MANIPULATED", "AUTHENTIC", "SUSPICIOUS", etc.
  exif: ExifData;
  anomalies: string[];
  realityDefender: {
    status: string;
    score: number | null;   // 0.0 - 1.0 raw score from SDK
    modelResults?: unknown;
  };
}

export interface AnalyzeSuccessResponse {
  success: true;
  data: AnalyzeSuccessData;
}

export interface AnalyzeErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

function jsonResponse(data: AnalyzeSuccessResponse | AnalyzeErrorResponse, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

class ValidationError extends Error {
  code: string;
  statusCode: number;
  constructor(message: string, code = 'invalid_request', statusCode = 400) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Validate image magic bytes to prevent spoofed file extensions.
 */
function validateImageMagicBytes(buffer: Buffer): { valid: boolean; detectedMime: string | null } {
  if (buffer.length < 12) {
    return { valid: false, detectedMime: null };
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { valid: true, detectedMime: 'image/jpeg' };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { valid: true, detectedMime: 'image/png' };
  }

  // GIF: GIF87a or GIF89a (47 49 46 38 37/39 61)
  if (
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38 &&
    (buffer[4] === 0x37 || buffer[4] === 0x39) &&
    buffer[5] === 0x61
  ) {
    return { valid: true, detectedMime: 'image/gif' };
  }

  // WebP: RIFF .... WEBP
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return { valid: true, detectedMime: 'image/webp' };
  }

  return { valid: false, detectedMime: null };
}

/**
 * Extract genuine EXIF data from the image buffer or file path using exifr.
 * All missing values are honestly resolved to null.
 */
async function extractExif(input: Buffer | string, fallbackMime: string): Promise<ExifData> {
  try {
    const raw = await exifr.parse(input, {
      tiff: true,
      exif: true,
      gps: true,
      xmp: true,
      icc: true,
    });

    if (!raw || typeof raw !== 'object') {
      return createEmptyExif(fallbackMime);
    }

    const make = typeof raw.Make === 'string' ? raw.Make.trim() : null;
    const model = typeof raw.Model === 'string' ? raw.Model.trim() : null;
    const camera = model ? (make && !model.toLowerCase().includes(make.toLowerCase()) ? `${make} ${model}` : model) : make;

    const width = typeof raw.ExifImageWidth === 'number' ? raw.ExifImageWidth : (typeof raw.ImageWidth === 'number' ? raw.ImageWidth : null);
    const height = typeof raw.ExifImageHeight === 'number' ? raw.ExifImageHeight : (typeof raw.ImageHeight === 'number' ? raw.ImageHeight : null);
    const resolution = width && height ? `${width} x ${height}` : null;

    let dateOriginal: string | null = null;
    if (raw.DateTimeOriginal instanceof Date) {
      dateOriginal = raw.DateTimeOriginal.toISOString().replace('T', ' ').slice(0, 19);
    } else if (raw.DateTimeOriginal) {
      dateOriginal = String(raw.DateTimeOriginal).trim();
    } else if (raw.CreateDate instanceof Date) {
      dateOriginal = raw.CreateDate.toISOString().replace('T', ' ').slice(0, 19);
    } else if (raw.CreateDate) {
      dateOriginal = String(raw.CreateDate).trim();
    }

    let aperture: string | null = null;
    if (typeof raw.FNumber === 'number' && !isNaN(raw.FNumber)) {
      aperture = `f/${raw.FNumber}`;
    }

    let exposureTime: string | null = null;
    if (typeof raw.ExposureTime === 'number' && !isNaN(raw.ExposureTime)) {
      exposureTime = raw.ExposureTime < 1
        ? `1/${Math.round(1 / raw.ExposureTime)} sec`
        : `${raw.ExposureTime} sec`;
    }

    let gps: string | null = null;
    if (typeof raw.latitude === 'number' && typeof raw.longitude === 'number' && !isNaN(raw.latitude) && !isNaN(raw.longitude)) {
      gps = `${raw.latitude.toFixed(4)}, ${raw.longitude.toFixed(4)}`;
    }

    let colorSpace: string | null = null;
    if (raw.ColorSpace === 1 || raw.ColorSpace === 'sRGB') {
      colorSpace = 'sRGB';
    } else if (raw.ColorSpace) {
      colorSpace = String(raw.ColorSpace);
    }

    return {
      camera: camera || null,
      make: make || null,
      model: model || null,
      software: typeof raw.Software === 'string' ? raw.Software.trim() : null,
      dateOriginal,
      resolution,
      width,
      height,
      lens: typeof raw.LensModel === 'string' ? raw.LensModel.trim() : (typeof raw.Lens === 'string' ? raw.Lens.trim() : null),
      aperture,
      exposureTime,
      iso: raw.ISO != null ? String(raw.ISO) : null,
      colorSpace,
      gps,
      compression: raw.Compression != null ? String(raw.Compression) : fallbackMime,
    };
  } catch (err) {
    logger.log('EXIF parse warning/empty:', err);
    return createEmptyExif(fallbackMime);
  }
}

function createEmptyExif(fallbackMime: string): ExifData {
  return {
    camera: null,
    make: null,
    model: null,
    software: null,
    dateOriginal: null,
    resolution: null,
    width: null,
    height: null,
    lens: null,
    aperture: null,
    exposureTime: null,
    iso: null,
    colorSpace: null,
    gps: null,
    compression: fallbackMime,
  };
}

interface ParsedFile {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
}

/**
 * Parse incoming HTTP request supporting strictly multipart/form-data.
 */
async function parseIncomingRequest(context: any): Promise<ParsedFile> {
  const req = context.request;
  const contentType = (req?.headers?.get?.('content-type') || '').toLowerCase();

  if (!contentType.includes('multipart/form-data')) {
    throw new ValidationError(
      `Content-Type "${contentType || 'kosong'}" tidak didukung. Endpoint /analyze hanya menerima berkas melalui multipart/form-data.`,
      'unsupported_content_type',
      415
    );
  }

  if (typeof req.formData !== 'function') {
    throw new ValidationError('Runtime EdgeOne tidak mendukung request.formData()', 'unsupported_runtime', 500);
  }

  const formData = await req.formData();
  const file = formData.get('file');

  if (!file || typeof file !== 'object' || typeof (file as any).arrayBuffer !== 'function') {
    throw new ValidationError('Field "file" wajib disertakan dalam form-data.', 'missing_file', 400);
  }

  const arrayBuf = await (file as any).arrayBuffer();
  const buffer = Buffer.from(arrayBuf);
  const fileName = (file as any).name || (formData.get('fileName') as string) || 'upload.jpg';
  const mimeType = (file as any).type || (formData.get('mimeType') as string) || 'image/jpeg';

  return { buffer, fileName, mimeType };
}

/**
 * Core image analysis function.
 * Completely independent of HTTP request abstraction.
 */
export async function analyzeImageCore(params: {
  buffer: Buffer;
  fileName: string;
  mimeType?: string;
}): Promise<AnalyzeSuccessData> {
  const { buffer, fileName } = params;

  if (!buffer || buffer.length === 0) {
    throw new ValidationError('Berkas gambar kosong (0 bytes).', 'empty_file', 400);
  }

  if (buffer.length > MAX_FILE_SIZE) {
    throw new ValidationError(
      `Ukuran berkas melebihi batas maksimum ${(MAX_FILE_SIZE / (1024 * 1024)).toFixed(0)} MB (${(buffer.length / (1024 * 1024)).toFixed(1)} MB).`,
      'file_too_large',
      413
    );
  }

  // Magic bytes inspection
  const magic = validateImageMagicBytes(buffer);
  if (!magic.valid) {
    throw new ValidationError(
      'Format berkas tidak valid atau rusak. Hanya gambar JPG, PNG, GIF, dan WebP yang didukung.',
      'invalid_image_format',
      400
    );
  }

  const effectiveMime = magic.detectedMime || params.mimeType || 'image/jpeg';
  const extension = effectiveMime === 'image/png' ? 'png' : effectiveMime === 'image/webp' ? 'webp' : effectiveMime === 'image/gif' ? 'gif' : 'jpg';

  // Reality Defender API key check
  const apiKey = process.env.REALITY_DEFENDER_API_KEY;
  if (!apiKey) {
    logger.log('REALITY_DEFENDER_API_KEY is not configured on server.');
    throw new ValidationError(
      'Kredensial Reality Defender (REALITY_DEFENDER_API_KEY) belum dikonfigurasi pada server.',
      'api_key_missing',
      503
    );
  }

  // Sanitize filename and create unique temporary file
  const sanitizedName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const tempFilePath = join(tmpdir(), `df_${Date.now()}_${randomUUID().slice(0, 8)}_${sanitizedName}.${extension}`);

  let rdData: DetectionResult | null = null;
  let exifData: ExifData;

  try {
    // 1. Parallel execution: In-memory EXIF extraction + disk write for Reality Defender SDK
    const exifTask = extractExif(buffer, effectiveMime);

    const writeAndScanTask = (async () => {
      await writeFile(tempFilePath, buffer);
      logger.log(`Temp file created for analysis: ${tempFilePath}`);

      const rd = new RealityDefender({ apiKey });
      return rd.detect(
        { filePath: tempFilePath },
        { maxAttempts: 24, pollingInterval: 2500 }
      );
    })();

    const [exifResult, rdResult] = await Promise.all([exifTask, writeAndScanTask]);
    exifData = exifResult;
    rdData = rdResult;
  } finally {
    // 2. Always clean up temporary file
    try {
      await unlink(tempFilePath);
      logger.log(`Temp file cleaned up: ${tempFilePath}`);
    } catch (cleanupErr: any) {
      if (cleanupErr?.code !== 'ENOENT') {
        logger.log('Warning: Temp file cleanup failed:', cleanupErr);
      }
    }
  }

  // 4. Normalize Reality Defender result honestly
  const rawScore = typeof rdData?.score === 'number' && !isNaN(rdData.score) ? rdData.score : null;
  const riskScore = rawScore != null ? Math.round(rawScore * 100) : null;
  const status = typeof rdData?.status === 'string' ? rdData.status : 'UNKNOWN';

  // Extract honest anomalies / detection signals strictly based on Reality Defender models.
  // Note: The SDK returns per-model statuses and probability scores (0.0 - 1.0), not visual bounding boxes.
  // The descriptions below are application summaries of model signals flagging MANIPULATED or score > 0.5.
  const anomalies: string[] = [];
  if (Array.isArray(rdData?.models)) {
    for (const m of rdData.models) {
      if (m.status === 'MANIPULATED' || (typeof m.score === 'number' && m.score > 0.5)) {
        const scoreFormatted = typeof m.score === 'number' ? ` (Skor: ${Math.round(m.score * 100)}%)` : '';
        anomalies.push(`Sinyal Model "${m.name}": indikasi manipulasi terdeteksi${scoreFormatted}.`);
      }
    }
  }

  if (anomalies.length === 0 && status === 'MANIPULATED') {
    anomalies.push(`Sinyal Deteksi Reality Defender: status MANIPULATED terdeteksi${riskScore != null ? ` (Skor Risiko: ${riskScore}%)` : ''}.`);
  }

  return {
    fileName,
    mimeType: effectiveMime,
    fileSize: buffer.length,
    analyzedAt: new Date().toISOString(),
    riskScore,
    status,
    exif: exifData,
    anomalies,
    realityDefender: {
      status,
      score: rawScore,
      modelResults: rdData?.models ?? null,
    },
  };
}

/**
 * EdgeOne Makers POST /analyze handler.
 */
export async function onRequestPost(context: any): Promise<Response> {
  const startTime = Date.now();
  logger.log(`[analyze] POST start at ${new Date(startTime).toISOString()}`);

  try {
    // Method restriction
    if (context.request?.method !== 'POST') {
      return jsonResponse({
        success: false,
        error: {
          code: 'method_not_allowed',
          message: 'Endpoint /analyze hanya menerima metode HTTP POST.',
          retryable: false,
        },
      }, 405);
    }

    const { buffer, fileName, mimeType } = await parseIncomingRequest(context);
    logger.log(`[analyze] Processing file: "${fileName}" (${(buffer.length / 1024).toFixed(1)} KB)`);

    const data = await analyzeImageCore({ buffer, fileName, mimeType });
    logger.log(`[analyze] Analysis success for "${fileName}" in ${Date.now() - startTime}ms. Status: ${data.status}, RiskScore: ${data.riskScore}`);

    return jsonResponse({
      success: true,
      data,
    }, 200);

  } catch (error: any) {
    logger.log(`[analyze] Error during analysis:`, error?.message || error);

    // 1. Validation error
    if (error instanceof ValidationError) {
      return jsonResponse({
        success: false,
        error: {
          code: error.code,
          message: error.message,
          retryable: false,
        },
      }, error.statusCode);
    }

    // 2. Reality Defender SDK error
    if (error instanceof RealityDefenderError) {
      const isTimeout = error.code === 'timeout';
      const isAuth = error.code === 'unauthorized';
      const statusCode = isTimeout ? 504 : isAuth ? 502 : 500;
      return jsonResponse({
        success: false,
        error: {
          code: `reality_defender_${error.code}`,
          message: `Layanan Reality Defender: ${error.message}`,
          retryable: isTimeout || error.code === 'server_error',
        },
      }, statusCode);
    }

    // 3. Generic server error
    return jsonResponse({
      success: false,
      error: {
        code: 'server_error',
        message: error instanceof Error ? error.message : 'Terjadi galat internal server saat memproses analisis.',
        retryable: false,
      },
    }, 500);
  }
}

// Default export for backward compatibility with external imports
export default analyzeImageCore;