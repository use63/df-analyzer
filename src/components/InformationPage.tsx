import React, { useEffect, useRef } from 'react';
import { APP_VERSION } from '../types';
import styles from '../App.module.css';

interface InformationPageProps {
  onBack: () => void;
}

export const InformationPage: React.FC<InformationPageProps> = ({ onBack }) => {
  const backButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    backButtonRef.current?.focus();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      onBack();
    }
  };

  return (
    <section
      className={styles.informationLayer}
      aria-labelledby="information-title"
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      <div className={styles.infoContainer}>
        {/* Header */}
        <header className={styles.infoHeader}>
          <div className={styles.infoTitleGroup}>
            <h2 id="information-title" className={styles.infoTitle}>
              Informasi DF-Analyzer
            </h2>
            <span className={styles.infoBadge}>EKSPERIMENTAL · BETA</span>
          </div>
          <button
            ref={backButtonRef}
            type="button"
            onClick={onBack}
            className={styles.btnBack}
            aria-label="Kembali ke halaman sebelumnya"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
            </svg>
            <span>Kembali</span>
          </button>
        </header>

        {/* Section 1: Informasi DF-Analyzer */}
        <div className={styles.infoSection}>
          <p className={styles.infoText}>
            DF-Analyzer, atau Deepfake Analyzer, adalah aplikasi eksperimental untuk membantu memeriksa indikasi manipulasi pada gambar melalui model deteksi dan pembacaan metadata. Hasil analisis dilengkapi Asisten AI untuk membantu pengguna memahami informasi teknis yang tersedia.
          </p>
          <p className={styles.infoText}>
            Nama DF-Analyzer merupakan singkatan dari Deepfake Analyzer. Nama ini dipilih secara independen sebagai nama deskriptif untuk proyek dan tidak dimaksudkan merujuk pada, mewakili, atau memiliki afiliasi dengan produk, merek, maupun organisasi lain.
          </p>
        </div>

        {/* Section 2: Status Eksperimental */}
        <div className={styles.infoSection}>
          <h3 className={styles.infoSectionTitle}>Status Eksperimental</h3>
          <p className={styles.infoText}>
            Aplikasi ini masih berada dalam tahap beta dan dikembangkan sebagai prototipe eksperimental. Hasil analisis dapat mengandung kesalahan, termasuk false positive dan false negative, serta dapat berubah mengikuti model dan layanan yang digunakan.
          </p>
        </div>

        {/* Section 3: Batasan Analisis */}
        <div className={styles.infoSection}>
          <h3 className={styles.infoSectionTitle}>Batasan Analisis</h3>
          <p className={styles.infoText}>
            Hasil yang ditampilkan merupakan indikator probabilistik, bukan kepastian mengenai keaslian atau manipulasi suatu gambar. Ketiadaan indikasi manipulasi tidak membuktikan bahwa berkas sepenuhnya autentik.
          </p>
          <p className={styles.infoText}>
            DF-Analyzer bukan pengganti pemeriksaan forensik menyeluruh oleh tenaga profesional. Untuk kebutuhan investigasi, jurnalistik, hukum, atau keamanan, hasil perlu dikonfirmasi menggunakan sumber dan metode pemeriksaan tambahan.
          </p>
        </div>

        {/* Section 4: Privasi dan Pemrosesan Data */}
        <div className={styles.infoSection}>
          <h3 className={styles.infoSectionTitle}>Privasi dan Pemrosesan Data</h3>
          <p className={styles.infoText}>
            Gambar yang dipilih dikirim ke layanan backend untuk dianalisis menggunakan Reality Defender. Hasil analisis dan salinan gambar disimpan secara lokal pada browser melalui IndexedDB untuk menyediakan riwayat analisis.
          </p>
          <p className={styles.infoText}>
            Ketika fitur Asisten AI digunakan, konteks hasil analisis dalam bentuk teks dikirim ke layanan AI melalui Tencent EdgeOne Makers. Berkas gambar tidak dikirimkan langsung kepada model bahasa melalui fitur chat.
          </p>
        </div>

        {/* Section 5: Tanggung Jawab Pengguna */}
        <div className={styles.infoSection}>
          <h3 className={styles.infoSectionTitle}>Tanggung Jawab Pengguna</h3>
          <p className={styles.infoText}>
            Pengguna bertanggung jawab atas berkas yang diunggah, interpretasi hasil, dan keputusan yang dibuat berdasarkan informasi dari aplikasi. Pastikan Anda memiliki hak atau izin untuk menganalisis berkas yang digunakan.
          </p>
          <p className={styles.infoText}>
            Hasil DF-Analyzer tidak boleh digunakan sebagai satu-satunya dasar untuk keputusan hukum, investigasi, jurnalistik, keamanan, atau keputusan lain yang berdampak tinggi.
          </p>
        </div>

        {/* Section 6: Teknologi */}
        <div className={styles.infoSection}>
          <h3 className={styles.infoSectionTitle}>Teknologi</h3>
          <table className={styles.infoTable}>
            <tbody>
              <tr className={styles.infoTableRow}>
                <td className={styles.infoTableKey}>Analisis gambar</td>
                <td className={styles.infoTableValue}>Reality Defender</td>
              </tr>
              <tr className={styles.infoTableRow}>
                <td className={styles.infoTableKey}>Infrastruktur dan AI</td>
                <td className={styles.infoTableValue}>Tencent EdgeOne Makers</td>
              </tr>
              <tr className={styles.infoTableRow}>
                <td className={styles.infoTableKey}>Penyimpanan riwayat</td>
                <td className={styles.infoTableValue}>IndexedDB pada browser</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Section 7: Kode Sumber */}
        <div className={styles.infoSection}>
          <h3 className={styles.infoSectionTitle}>Kode Sumber</h3>
          <p className={styles.infoText}>
            Kode sumber DF-Analyzer tersedia secara terbuka di GitHub. Repository dapat digunakan untuk mempelajari implementasi, meninjau cara kerja aplikasi, dan mengikuti perkembangan proyek.
          </p>
          <div>
            <a
              href="https://github.com/use63/df-analyzer"
              target="_blank"
              rel="noopener noreferrer"
              className={styles.infoLink}
            >
              <span>github.com/use63/df-analyzer</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                <polyline points="15 3 21 3 21 9"></polyline>
                <line x1="10" y1="14" x2="21" y2="3"></line>
              </svg>
            </a>
          </div>
        </div>

        {/* Section 8: Versi */}
        <div className={styles.infoSection}>
          <h3 className={styles.infoSectionTitle}>Versi</h3>
          <div className={styles.infoText} style={{ lineHeight: 1.6 }}>
            <div style={{ fontWeight: 600, color: '#e2e5ec' }}>DF-Analyzer</div>
            <div>v{APP_VERSION}</div>
            <div style={{ color: '#8a90a0' }}>© 2026 use63</div>
          </div>
        </div>
      </div>
    </section>
  );
};
