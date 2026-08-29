# DF-Analyzer - Dashboard Analisis Forensik Gambar Deepfake

DF-Analyzer adalah aplikasi dashboard forensik digital berbasis React, TypeScript, dan Vite yang dirancang untuk mendeteksi manipulasi gambar dan deepfake. Aplikasi ini terintegrasi dengan backend EdgeOne Makers untuk menyediakan asisten analisis berbasis kecerdasan buatan (AI) yang interaktif.

## Fitur Utama

1. **Tata Letak Fokus Media**: Kolom kiri didedikasikan penuh untuk pratinjau gambar sumber secara proporsional. Kolom kanan menyediakan sistem tab yang memisahkan hasil metrik forensik dan asisten obrolan AI secara rapi.
2. **Desain Flat dan Bersih**: Antarmuka dirancang minimalis tanpa garis batas kontainer yang berlebihan (mencegah border fatigue) untuk memberikan kesan alat forensik profesional.
3. **Penyimpanan Lokal IndexedDB**: Riwayat analisis gambar disimpan secara lokal di dalam browser menggunakan basis data IndexedDB, memungkinkan penyimpanan file gambar berukuran besar tanpa batas memori localStorage.
4. **Sesi Obrolan AI Mandiri per Berkas**: Setiap gambar memiliki ID sesi percakapan backend yang unik. Riwayat obrolan untuk setiap berkas dipertahankan secara dinamis menggunakan sistem caching memori lokal sehingga riwayat tidak hilang saat berpindah antar gambar.
5. **Sapaan Otomatis Aktif**: Sistem secara otomatis memicu pesan instruksi tersembunyi untuk meminta kesimpulan analisis AI sesaat setelah tab obrolan dibuka untuk gambar yang baru dianalisis.
6. **Parameter EXIF Forensik Lengkap**: Menyajikan 12 parameter metadata gambar esensial termasuk merek kamera, tipe lensa, aperture, exposure time, ISO, ruang warna, dan koordinat GPS.
7. **Deteksi Anomali Dinamis**: Menghasilkan daftar indikasi manipulasi gambar yang diacak secara realistis berdasarkan skor risiko analisis, lengkap dengan pesan fallback jika tidak ada anomali yang terdeteksi.
8. **Kemampuan PWA (Progressive Web App)**: Aplikasi mendukung instalasi langsung di desktop/mobile dan siap dijalankan dalam kondisi offline (offline-ready) dengan service worker terintegrasi.
9. **Tombol Hapus Semua Riwayat**: Menyediakan tombol pembersihan database di bagian bawah sidebar untuk menghapus seluruh riwayat pemindaian dan cache obrolan dari IndexedDB.

## Struktur Direktori

* **agents/**: Kode sumber backend berbasis stateful agent untuk EdgeOne Makers (penanganan POST /chat dan POST /chat/stop).
* **cloud-functions/**: Kode sumber backend serverless stateless (penanganan POST /history).
* **public/**: Folder aset statis untuk PWA (ikon aplikasi, favicon, dan Apple touch icon).
* **src/**: Kode sumber frontend React dan TypeScript.
  * **App.tsx**: Komponen utama yang mengatur tata letak, logika IndexedDB, transisi file, dan integrasi stream SSE.
  * **App.module.css**: Modul gaya CSS untuk tata letak kolom, tab navigasi, desain flat, dan tombol kontrol.
  * **api.ts**: Wrapper API untuk komunikasi HTTP POST ke /chat, /chat/stop, dan /history.
  * **main.tsx**: Entri utama aplikasi yang mendaftarkan Service Worker PWA.
  * **vite-env.d.ts**: Deklarasi tipe lingkungan pengembangan untuk Vite dan PWA client.
* **vite.config.ts**: Konfigurasi build Vite, integrasi vite-plugin-pwa, dan pengaturan proxy port backend.

## Persyaratan Sistem

* Node.js versi 18 atau lebih tinggi.
* EdgeOne CLI (dapat diinstal melalui npm i -g edgeone).

## Cara Menjalankan secara Lokal

1. Instal seluruh dependensi proyek:
   ```bash
   npm install
   ```
2. Siapkan konfigurasi variabel lingkungan dengan menyalin berkas contoh:
   ```bash
   cp .env.example .env
   ```
   Isi nilai variabel `AI_GATEWAY_API_KEY` dan `AI_GATEWAY_BASE_URL` sesuai dengan kredensial EdgeOne Makers Anda.
3. Jalankan server pengembangan terintegrasi:
   ```bash
   npm run dev:agents
   ```
   Perintah ini akan menyalakan server lokal EdgeOne Makers di port 8088 dan server Vite frontend di port 9000 (atau port dinamis yang tersedia).

## Pengaturan Jaringan dan Proxy

Aplikasi menggunakan konfigurasi proxy di dalam file `vite.config.ts` untuk mengalihkan permintaan API `/chat` dan `/history` dari server frontend Vite ke port backend gerbang EdgeOne lokal (`http://localhost:8088`). Hal ini menghindari masalah pembatasan CORS selama pengembangan lokal.

## Batas Ukuran Header (HTTP 431)

To mencegah terjadinya galat HTTP 431 saat browser menyertakan cookie lokal berukuran besar saat proses reload atau HMR (Hot Module Replacement), skrip `"dev"` dan `"dev:agents"` pada `package.json` telah dikonfigurasi untuk menjalankan Node.js dengan parameter pelonggaran batas tajuk HTTP sebesar 32KB (`NODE_OPTIONS='--max-http-header-size=32768'`).

## Lisensi

Proyek ini menggunakan lisensi MIT.
