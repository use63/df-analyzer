import { RealityDefender } from '@realitydefender/realitydefender';
import exifr from 'exifr';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

export default async function analyzeDeepfake(params: { fileName: string; fileBase64: string }) {
  const apiKey = process.env.REALITY_DEFENDER_API_KEY;
  if (!apiKey) throw new Error("API Key Reality Defender belum dikonfigurasi.");

  const { fileName, fileBase64 } = params;
  console.log(`[Forensic-Log] Memulai analisis untuk berkas: ${fileName}`);

  // 1. Membersihkan string Base64 (menghapus header 'data:image/jpeg;base64,')
  const base64Data = fileBase64.replace(/^data:image\/\w+;base64,/, "");
  const buffer = Buffer.from(base64Data, 'base64');

  // 2. Membuat fail sementara (temp file) di sistem operasi peladen
  const tempFilePath = path.join(os.tmpdir(), `${Date.now()}_${fileName}`);
  
  try {
    // Tulis buffer ke penyimpanan sementara
    await fs.writeFile(tempFilePath, buffer);
    console.log(`[Forensic-Log] Berkas sementara dibuat di: ${tempFilePath}`);

    // --- EKSEKUSI PARALEL (EXIF & REALITY DEFENDER) ---
    
    // Tugas A: Ekstrak EXIF lokal
    const exifTask = exifr.parse(tempFilePath).catch(() => ({ error: "EXIF tidak ditemukan/dihapus" }));

    // Tugas B: Pindai via SDK Reality Defender
    const realityDefender = new RealityDefender({ apiKey });
    const rdTask = realityDefender.detect({ filePath: tempFilePath }).catch(e => {
      console.error("[Forensic-Log] Galat SDK:", e);
      return { status: "error", message: "Gagal memindai ke peladen RD." };
    });

    // Tunggu kedua tugas selesai secara bersamaan
    const [exifData, rdData] = await Promise.all([exifTask, rdTask]);

    console.log(`[Forensic-Log] Analisis selesai.`);

    // 3. Rangkum dan kembalikan struktur JSON ke Dasbor React
    return {
      status: "success",
      fileName: fileName,
      analysis: {
        realityDefender: rdData,
        metadataEXIF: exifData
      }
    };

  } catch (error) {
    console.error("[Forensic-Log] Galat sistem:", error);
    return { status: "error", message: String(error) };
  } finally {
    // 4. SELALU hapus fail sementara agar penyimpanan peladen tidak penuh
    try {
      await fs.unlink(tempFilePath);
      console.log(`[Forensic-Log] Berkas sementara dihapus.`);
    } catch (cleanupError) {
      console.error("[Forensic-Log] Gagal menghapus berkas sementara:", cleanupError);
    }
  }
}