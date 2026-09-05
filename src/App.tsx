import { useState, useCallback, useEffect, useRef } from 'react';
import type { Message, ReplLine } from './types';
import { fetchConversationHistory, sendMessageStream, analyzeImage } from './api';
import { I18nProvider } from './i18n';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import styles from './App.module.css';

const CONVERSATION_ID_STORAGE_KEY = 'eo_conversation_id';

interface AnalysisData {
  id: string;
  fileName: string;
  fileUrl: string;
  riskScore: number | null;
  conversationId: string;
  status?: string;
  exif: {
    camera: string | null;
    software: string | null;
    dateOriginal: string | null;
    resolution: string | null;
    compression: string | null;
    make?: string | null;
    model?: string | null;
    lens?: string | null;
    aperture?: string | null;
    exposureTime?: string | null;
    iso?: string | null;
    colorSpace?: string | null;
    gps?: string | null;
    width?: number | null;
    height?: number | null;
  };
  anomalies: string[];
  realityDefender?: {
    status: string;
    score: number | null;
    modelResults?: unknown;
  };
}



function historyToLines(history: Message[]): ReplLine[] {
  const out: ReplLine[] = [];
  for (const m of history) {
    if (!m.content && m.role === 'assistant') continue;
    if (m.role === 'user') {
      out.push({ kind: 'user', id: m.id, text: m.content, ts: m.timestamp });
    } else {
      out.push({
        kind: 'markdown',
        id: m.id,
        turnId: `restored-${m.id}`,
        text: m.content,
        ts: m.timestamp,
        isContinuation: false,
      });
    }
  }
  return out;
}

// IndexedDB storage for analysis history
const DB_NAME = 'DFAnalyzerDB';
const STORE_NAME = 'analysis_history';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function saveAnalysisToDB(data: AnalysisData): Promise<void> {
  return openDB().then(db => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(data);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  });
}

function getAnalysisHistoryFromDB(): Promise<AnalysisData[]> {
  return openDB().then(db => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAll();
      request.onsuccess = () => {
        const results = request.result as AnalysisData[];
        // Sort by ID descending (timestamp based)
        results.sort((a, b) => b.id.localeCompare(a.id));
        resolve(results);
      };
      request.onerror = () => reject(request.error);
    });
  });
}

function clearAllAnalysisFromDB(): Promise<void> {
  return openDB().then(db => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  });
}

function AppInner() {

  const [historyList, setHistoryList] = useState<AnalysisData[]>([]);
  const [activeAnalysis, setActiveAnalysis] = useState<AnalysisData | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [navigationMode, setNavigationMode] = useState<'new' | 'history'>('new');
  const [activeTab, setActiveTab] = useState<'analysis' | 'ai'>('analysis');

  // Chatbot states
  const [lines, setLines] = useState<ReplLine[]>([]);
  const [inputText, setInputText] = useState('');
  const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);

  const abortCtrlRef = useRef<AbortController | null>(null);
  const analyzeAbortCtrlRef = useRef<AbortController | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const triggeredGreetingsRef = useRef<Set<string>>(new Set());
  const chatCacheRef = useRef<Record<string, ReplLine[]>>({});
  const activeAnalysisIdRef = useRef<string>('new');

  const conversationIdRef = useRef<string>(
    ((): string => {
      const existing = localStorage.getItem(CONVERSATION_ID_STORAGE_KEY);
      if (existing) return existing;
      const id = crypto.randomUUID();
      localStorage.setItem(CONVERSATION_ID_STORAGE_KEY, id);
      return id;
    })(),
  );

  // Scroll to bottom of chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines]);

  // Load analysis history from IndexedDB on mount and migrate legacy items
  useEffect(() => {
    getAnalysisHistoryFromDB()
      .then((history) => {
        const migratedHistory = history.map(item => {
          if (!item.conversationId) {
            const updated = { ...item, conversationId: crypto.randomUUID() };
            saveAnalysisToDB(updated).catch(console.error);
            return updated;
          }
          return item;
        });

        setHistoryList(migratedHistory);
        if (migratedHistory.length > 0) {
          setActiveAnalysis(migratedHistory[0]);
          setNavigationMode('history');
        } else {
          setActiveAnalysis(null);
          setNavigationMode('new');
        }
      })
      .catch((err) => {
        console.error('Failed to load analysis history from IndexedDB:', err);
      });
  }, []);

  // Trigger proactive greeting when opening Chat/AI Assistant tab
  useEffect(() => {
    if (activeTab === 'ai' && activeAnalysis) {
      const fileId = activeAnalysis.id;
      if (!triggeredGreetingsRef.current.has(fileId)) {
        const isHistoryEmpty = lines.length === 0 || (lines.length === 1 && lines[0].kind === 'sysHint');
        if (isHistoryEmpty) {
          triggeredGreetingsRef.current.add(fileId);
          handleSendMessage(
            undefined,
            'Tolong berikan 1-2 paragraf kesimpulan analitis mengenai hasil analisis gambar ini.'
          );
        }
      }
    }
  }, [activeTab, activeAnalysis, lines]);

  // Sync activeAnalysisIdRef when activeAnalysis changes
  useEffect(() => {
    activeAnalysisIdRef.current = activeAnalysis?.id || 'new';
  }, [activeAnalysis]);

  // Save lines to cache whenever they change
  useEffect(() => {
    const currentId = activeAnalysisIdRef.current;
    chatCacheRef.current[currentId] = lines;
  }, [lines]);

  // Handle activeAnalysis change: load from cache or fetch from backend /history
  useEffect(() => {
    const currentId = activeAnalysis?.id || 'new';

    // Abort active streaming
    if (abortCtrlRef.current) {
      abortCtrlRef.current.abort();
      abortCtrlRef.current = null;
    }
    setLoading(false);

    // Retrieve from cache
    const cachedLines = chatCacheRef.current[currentId];
    if (cachedLines && cachedLines.length > 0) {
      setLines(cachedLines);
    } else if (activeAnalysis) {
      // If not cached in memory, fetch history from backend using the file's conversationId
      const cid = activeAnalysis.conversationId;
      setHistoryLoading(true);
      fetchConversationHistory(cid)
        .then((history) => {
          if (history.length > 0) {
            const restoredLines = historyToLines(history);
            setLines(restoredLines);
            chatCacheRef.current[currentId] = restoredLines;
            // Mark as already greeted since history exists
            triggeredGreetingsRef.current.add(activeAnalysis.id);
          } else {
            // No history on backend, initialize fresh
            setLines([
              {
                kind: 'sysHint',
                id: 'init-hint-' + currentId,
                text: 'Sistem analisis aktif. Pilih riwayat analisis di sebelah kiri atau unggah foto baru untuk dianalisis, lalu Anda dapat bertanya kepada AI seputar hasil analisis tersebut di sini.',
                ts: Date.now(),
                tone: 'dim'
              }
            ]);
            triggeredGreetingsRef.current.delete(activeAnalysis.id);
          }
        })
        .catch((err) => {
          console.error('Failed to load conversation history from backend:', err);
          // Fallback to empty state
          setLines([
            {
              kind: 'sysHint',
              id: 'init-hint-err-' + currentId,
              text: 'Gagal memuat riwayat obrolan dari server. Anda tetap dapat memulai obrolan baru.',
              ts: Date.now(),
              tone: 'warn'
            }
          ]);
        })
        .finally(() => {
          setHistoryLoading(false);
        });
    } else {
      // No active file, clear to initial hint
      setLines([
        {
          kind: 'sysHint',
          id: 'init-hint-' + currentId,
          text: 'Sistem analisis aktif. Pilih riwayat analisis di sebelah kiri atau unggah foto baru untuk dianalisis, lalu Anda dapat bertanya kepada AI seputar hasil analisis tersebut di sini.',
          ts: Date.now(),
          tone: 'dim'
        }
      ]);
    }
  }, [activeAnalysis]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Reset file input value so re-selecting same file triggers change
    e.target.value = '';

    // Frontend pre-validation
    setScanError(null);

    // Check file type
    const validTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!validTypes.includes(file.type) && !/\.(jpe?g|png|webp|gif)$/i.test(file.name)) {
      setScanError('Format berkas tidak didukung. Harap unggah berkas gambar JPG, PNG, WebP, atau GIF.');
      return;
    }

    // Check file size (20 MB safe serverless limit)
    const MAX_SIZE = 20 * 1024 * 1024;
    if (file.size > MAX_SIZE) {
      setScanError(`Ukuran berkas terlalu besar (${(file.size / (1024 * 1024)).toFixed(1)} MB). Batas maksimum adalah 20 MB.`);
      return;
    }

    if (file.size === 0) {
      setScanError('Berkas kosong (0 bytes) atau rusak.');
      return;
    }

    // Abort any ongoing analysis
    if (analyzeAbortCtrlRef.current) {
      analyzeAbortCtrlRef.current.abort();
    }
    const abortCtrl = new AbortController();
    analyzeAbortCtrlRef.current = abortCtrl;

    setScanning(true);

    try {
      // Read base64 for local preview
      const base64String = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error('Gagal membaca berkas gambar lokal.'));
        reader.readAsDataURL(file);
      });

      if (abortCtrl.signal.aborted) return;

      // Call real backend API POST /analyze
      const response = await analyzeImage(file, abortCtrl.signal);
      const { data } = response;

      if (abortCtrl.signal.aborted) return;

      const newConversationId = crypto.randomUUID();
      const newResult: AnalysisData = {
        id: 'upload-' + Date.now(),
        fileName: data.fileName || file.name,
        fileUrl: base64String,
        riskScore: data.riskScore,
        conversationId: newConversationId,
        status: data.status,
        exif: {
          camera: data.exif.camera,
          make: data.exif.make,
          model: data.exif.model,
          software: data.exif.software,
          dateOriginal: data.exif.dateOriginal,
          resolution: data.exif.resolution,
          compression: data.exif.compression,
          lens: data.exif.lens,
          aperture: data.exif.aperture,
          exposureTime: data.exif.exposureTime,
          iso: data.exif.iso != null ? String(data.exif.iso) : null,
          colorSpace: data.exif.colorSpace,
          gps: data.exif.gps,
          width: data.exif.width,
          height: data.exif.height,
        },
        anomalies: data.anomalies || [],
        realityDefender: data.realityDefender,
      };

      // Save to IndexedDB ONLY on success
      await saveAnalysisToDB(newResult);

      setHistoryList(prev => [newResult, ...prev]);
      setActiveAnalysis(newResult);
      setNavigationMode('history');
      setActiveTab('analysis');

      // Add system notification in the chat
      const riskDisplay = data.riskScore != null ? `${data.riskScore}%` : (data.status || 'N/A');
      setLines(prev => [
        ...prev,
        {
          kind: 'sysHint',
          id: crypto.randomUUID(),
          text: `[Analisis Forensik Selesai]: Berhasil memindai "${file.name}". Status: ${data.status} | Skor Risiko: ${riskDisplay}. Anda sekarang dapat menanyakan kesimpulan forensik kepada AI.`,
          ts: Date.now(),
          tone: (data.riskScore ?? 0) > 60 ? 'warn' : 'dim'
        }
      ]);
    } catch (err: any) {
      if (err.name === 'AbortError' || abortCtrl.signal.aborted) {
        return;
      }
      console.error('[Forensic-Scanner] Galat analisis:', err);
      setScanError(err.message || 'Gagal menganalisis berkas. Pastikan backend EdgeOne aktif dan API key terkonfigurasi.');
    } finally {
      if (analyzeAbortCtrlRef.current === abortCtrl) {
        analyzeAbortCtrlRef.current = null;
      }
      setScanning(false);
    }
  };

  const handleSendMessage = (e?: React.FormEvent, customText?: string) => {
    if (e) e.preventDefault();
    const textToSend = customText !== undefined ? customText : inputText;
    if (!textToSend.trim() || loading) return;

    const text = textToSend.trim();
    if (customText === undefined) {
      setInputText('');
    }

    // Append user message ONLY IF it is not a custom (hidden) prompt
    if (customText === undefined) {
      const userMsgId = crypto.randomUUID();
      setLines(prev => [...prev, { kind: 'user', id: userMsgId, text, ts: Date.now() }]);
    }

    setLoading(true);
    const turnId = crypto.randomUUID();
    const cid = activeAnalysis?.conversationId || conversationIdRef.current;

    // Contextually enrich AI request with the current analysis data
    let messageWithContext = text;
    let analysisContext: any = null;
    if (activeAnalysis) {
      const scoreDisplay = activeAnalysis.riskScore != null ? `${activeAnalysis.riskScore}%` : (activeAnalysis.status || 'Tidak tersedia');
      const exifItems = [
        activeAnalysis.exif.camera ? `Kamera=${activeAnalysis.exif.camera}` : null,
        activeAnalysis.exif.software ? `Software=${activeAnalysis.exif.software}` : null,
        activeAnalysis.exif.resolution ? `Resolusi/Dimensi=${activeAnalysis.exif.resolution}` : null,
        activeAnalysis.exif.compression ? `Kompresi=${activeAnalysis.exif.compression}` : null,
      ].filter(Boolean).join(', ') || 'Metadata EXIF tidak tersedia';

      const anomaliesText = activeAnalysis.anomalies.length > 0
        ? activeAnalysis.anomalies.join(' | ')
        : 'Tidak ada indikasi anomali terdeteksi';

      messageWithContext = `[Konteks Hasil Analisis Media Aktif:
Nama File: ${activeAnalysis.fileName}
Status Deteksi: ${activeAnalysis.status || 'ANALYZED'}
Skor Risiko Manipulasi: ${scoreDisplay}
Metadata EXIF: ${exifItems}
Daftar Anomali: ${anomaliesText}
]
Pertanyaan Pengguna: ${text}`;

      // Filter analysis context to exclude Base64/URL image data
      analysisContext = {
        fileName: activeAnalysis.fileName,
        riskScore: activeAnalysis.riskScore,
        status: activeAnalysis.status,
        exif: activeAnalysis.exif,
        anomalies: activeAnalysis.anomalies,
      };
    }

    let currentAssistantText = '';
    const assistantMsgId = crypto.randomUUID();

    // Set temporary text line for streaming output
    setLines(prev => [
      ...prev,
      {
        kind: 'text',
        id: assistantMsgId,
        turnId,
        text: '',
        ts: Date.now(),
        isContinuation: false
      }
    ]);

    const ctrl = sendMessageStream(
      messageWithContext,
      {
        onTextDelta: (delta) => {
          currentAssistantText += delta;
          setLines(prev => prev.map(line => {
            if (line.kind === 'text' && line.id === assistantMsgId) {
              return { ...line, text: currentAssistantText };
            }
            return line;
          }));
        },
        onToolCalled: (toolName) => {
          setLines(prev => [
            ...prev,
            {
              kind: 'tool',
              id: crypto.randomUUID(),
              turnId,
              tool: toolName,
              ts: Date.now()
            }
          ]);
        },
        onImage: (payload) => {
          const storageKey = `${cid}/${payload.imageId}`;
          const url = `data:${payload.mimeType};base64,${payload.base64}`;
          setLines(prev => [
            ...prev,
            {
              kind: 'image',
              id: crypto.randomUUID(),
              turnId,
              ts: Date.now(),
              image: {
                imageId: payload.imageId,
                storageKey,
                url,
                mimeType: payload.mimeType,
                size: payload.size
              },
              toolName: payload.toolName
            }
          ]);
        },
        onDone: () => {
          // Collapse turn text to markdown
          setLines(prev => prev.map(line => {
            if (line.kind === 'text' && line.id === assistantMsgId) {
              return {
                kind: 'markdown',
                id: assistantMsgId,
                turnId,
                text: currentAssistantText,
                ts: Date.now(),
                isContinuation: false
              };
            }
            return line;
          }));
          setLoading(false);
        },
        onError: (err) => {
          setLines(prev => [
            ...prev,
            {
              kind: 'error',
              id: crypto.randomUUID(),
              ts: Date.now(),
              message: err.message || 'Gagal memproses jawaban dari AI'
            }
          ]);
          setLoading(false);
        }
      },
      cid,
      analysisContext
    );

    abortCtrlRef.current = ctrl;
  };

  const handleResetSession = useCallback(() => {
    if (abortCtrlRef.current) {
      abortCtrlRef.current.abort();
      abortCtrlRef.current = null;
    }
    if (analyzeAbortCtrlRef.current) {
      analyzeAbortCtrlRef.current.abort();
      analyzeAbortCtrlRef.current = null;
    }
    setLoading(false);
    setScanning(false);
    setScanError(null);

    // Clear triggered greetings and chat cache memory
    triggeredGreetingsRef.current.clear();
    chatCacheRef.current = {};
    
    // Create a new conversation ID
    const newId = crypto.randomUUID();

    if (activeAnalysis) {
      const updated = { ...activeAnalysis, conversationId: newId };
      setActiveAnalysis(updated);
      setHistoryList(prev => prev.map(item => item.id === updated.id ? updated : item));
      saveAnalysisToDB(updated).catch(console.error);
    } else {
      localStorage.setItem(CONVERSATION_ID_STORAGE_KEY, newId);
      conversationIdRef.current = newId;
    }

    // Reset lines
    setLines([
      {
        kind: 'sysHint',
        id: 'reset-hint',
        text: 'Sesi analisis direset. Id percakapan baru dibuat.',
        ts: Date.now(),
        tone: 'warn'
      }
    ]);
  }, [activeAnalysis]);

  const handleClearAllHistory = () => {
    if (window.confirm('Apakah Anda yakin ingin menghapus seluruh riwayat analisis? Tindakan ini tidak dapat dibatalkan.')) {
      if (analyzeAbortCtrlRef.current) {
        analyzeAbortCtrlRef.current.abort();
        analyzeAbortCtrlRef.current = null;
      }
      clearAllAnalysisFromDB()
        .then(() => {
          setHistoryList([]);
          setActiveAnalysis(null);
          setNavigationMode('new');
          setScanError(null);
          triggeredGreetingsRef.current.clear();
          chatCacheRef.current = {};
          setLines([
            {
              kind: 'sysHint',
              id: 'clear-hint',
              text: 'Semua riwayat analisis telah dibersihkan.',
              ts: Date.now(),
              tone: 'warn'
            }
          ]);
        })
        .catch(err => {
          console.error('Failed to clear history from IndexedDB:', err);
          alert('Gagal membersihkan riwayat.');
        });
    }
  };

  const getRiskColor = (score: number | null) => {
    if (score == null) return '#8c9ba5';
    if (score > 70) return '#ff6e6e'; // Red
    if (score > 35) return '#ffb000'; // Yellow/Amber
    return '#87d96c'; // Green
  };

  const getRiskText = (score: number | null, status?: string) => {
    if (score == null) return status || 'Tidak tersedia';
    if (score > 70) return 'Tinggi (Terindikasi Manipulasi)';
    if (score > 35) return 'Sedang (Mencurigakan)';
    return 'Rendah (Autentik)';
  };

  const getBadgeClass = (score: number | null) => {
    if (score == null) return styles.badgeDim;
    if (score > 70) return styles.badgeDanger;
    if (score > 35) return styles.badgeWarning;
    return styles.badgeSuccess;
  };

  return (
    <div className={styles.dashboard}>
      {/* ── COLUMN 1: SIDEBAR/HISTORY ── */}
      <div className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <div className={styles.logoArea}>
            <svg className={styles.logoIcon} viewBox="0 0 24 24">
              <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 6c1.4 0 2.5 1.1 2.5 2.5S13.4 12 12 12s-2.5-1.1-2.5-2.5S10.6 7 12 7zm0 10c-2.33 0-4.33-1.07-5.5-2.73.03-1.82 3.67-2.82 5.5-2.82s5.47 1 5.5 2.82C16.33 15.93 14.33 17 12 17z"/>
            </svg>
            <span>DF-ANALYZER</span>
          </div>
          <div className={styles.sidebarSubtitle}>Forensic Deepfake Dashboard</div>
        </div>

        <div className={styles.sidebarNav}>
          <button
            onClick={() => {
              setNavigationMode('new');
              setActiveAnalysis(null);
            }}
            className={`${styles.btnNewAnalysis} ${navigationMode === 'new' ? styles.btnNewAnalysisActive : ''}`}
          >
            <span>➕ Analisis Baru</span>
          </button>
        </div>

        <div className={styles.historySection}>
          <div className={styles.sectionTitle}>Riwayat Analisis</div>
          <div className={styles.historyList}>
            {historyList.map(item => (
              <button
                key={item.id}
                onClick={() => {
                  setActiveAnalysis(item);
                  setNavigationMode('history');
                }}
                className={`${styles.historyCard} ${navigationMode === 'history' && activeAnalysis?.id === item.id ? styles.historyCardActive : ''}`}
              >
                <div className={styles.historyCardHeader}>
                  <span className={styles.fileName} title={item.fileName}>
                    {item.fileName}
                  </span>
                  <span className={`${styles.badge} ${getBadgeClass(item.riskScore)}`}>
                    {item.riskScore != null ? `${item.riskScore}%` : (item.status || 'N/A')}
                  </span>
                </div>
                <div className={styles.cardMeta}>
                  <span>Tipe: Gambar</span>
                  <span>{item.exif?.dateOriginal ? item.exif.dateOriginal.slice(0, 10) : 'Lokal'}</span>
                </div>
              </button>
            ))}
          </div>

          {historyList.length > 0 && (
            <button
              onClick={handleClearAllHistory}
              className={styles.btnClearHistory}
            >
              <span>🗑️ Hapus Semua Riwayat</span>
            </button>
          )}
        </div>
      </div>

      {/* ── COLUMN 2: MAIN CONTENT ── */}
      <div className={styles.mainContent}>
        {navigationMode === 'new' ? (
          /* UPPER ROW: FILE UPLOADER ONLY */
          <div className={styles.topSection}>
            <div className={styles.panelTitle}>
              <svg className={styles.panelTitleIcon} width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14zm-5.04-6.71l-2.75 3.54-1.96-2.36L6.5 17h11l-3.54-4.71z"/>
              </svg>
              <span>Analisis Gambar Baru</span>
            </div>

            {/* Error Notification */}
            {scanError && (
              <div className={styles.scanErrorBox}>
                <span className={styles.errorIcon}>⚠️</span>
                <span className={styles.errorMessage}>{scanError}</span>
                <button
                  type="button"
                  onClick={() => setScanError(null)}
                  className={styles.btnDismissError}
                  title="Tutup pesan galat"
                >
                  ✕
                </button>
              </div>
            )}

            {/* Upload Area */}
            <div className={styles.uploadContainer}>
              <label className={styles.uploadBox}>
                <svg className={styles.uploadIcon} viewBox="0 0 24 24">
                  <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/>
                </svg>
                <span className={styles.uploadText}>Unggah Berkas Gambar</span>
                <span className={styles.uploadSubtext}>Klik atau seret foto lokal ke area ini (JPG, PNG, WebP, GIF maks 50 MB)</span>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  onChange={handleFileUpload}
                  className={styles.fileInput}
                />
              </label>
            </div>

            {scanning && (
              <div style={{ display: 'flex', justifyContent: 'center', margin: '20px 0' }}>
                <div className={styles.scanningText}>
                  <span className={styles.loadingSpinner}></span>
                  <span>Menjalankan analisis Reality Defender & ekstraksi EXIF nyata...</span>
                </div>
              </div>
            )}
          </div>
        ) : (
          /* STRUCTURED FORENSIC RESULTS (LEFT MEDIA + RESULTS, RIGHT CHATBOT) */
          <>
            {/* Header row */}
            <div className={styles.mainContentHeader}>
              <div style={{ fontSize: '14px', fontWeight: 'bold', color: '#ffb000' }}>
                {activeAnalysis ? `Berkas Aktif: ${activeAnalysis.fileName}` : 'Hasil Analisis'}
              </div>
              <button
                onClick={() => {
                  setActiveAnalysis(null);
                  setNavigationMode('new');
                  setActiveTab('analysis');
                }}
                className={styles.btnReset}
              >
                Tutup Hasil
              </button>
            </div>

            {/* Split layout */}
            <div className={styles.historyLayout}>
              {/* Kolom Kiri: Fokus Gambar */}
              <div className={styles.leftForensicColumn}>
                <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#ffffff', marginBottom: '4px' }}>
                  Pratinjau Media Sumber
                </div>
                {activeAnalysis && (
                  <div className={styles.previewCardFull}>
                    <div className={styles.imageFocusContainer}>
                      <img
                        src={activeAnalysis.fileUrl}
                        alt={activeAnalysis.fileName}
                        className={styles.imageFocus}
                      />
                    </div>
                    <span className={styles.previewLabel} style={{ marginTop: '8px' }}>
                      {activeAnalysis.fileName}
                    </span>
                  </div>
                )}
              </div>

              {/* Kolom Kanan: Sistem Tab */}
              <div className={styles.rightChatColumn}>
                {/* Tabs Nav Header */}
                <div className={styles.tabsHeader}>
                  <button
                    className={`${styles.tabBtn} ${activeTab === 'analysis' ? styles.tabBtnActive : ''}`}
                    onClick={() => setActiveTab('analysis')}
                  >
                    🔍 Hasil Analisis
                  </button>
                  <button
                    className={`${styles.tabBtn} ${activeTab === 'ai' ? styles.tabBtnActive : ''}`}
                    onClick={() => setActiveTab('ai')}
                  >
                    💬 Asisten AI
                  </button>
                </div>

                <div className={styles.tabsContentContainer}>
                  {/* Tab 1: Hasil Analisis */}
                  <div
                    style={{
                      display: activeTab === 'analysis' ? 'flex' : 'none',
                      flexDirection: 'column',
                      height: '100%',
                      overflowY: 'auto',
                      padding: '24px',
                      gap: '20px'
                    }}
                  >
                    {activeAnalysis && (
                      <div className={styles.resultsCard}>
                        {/* Risk Score */}
                        <div className={styles.riskSection}>
                          <div className={styles.riskPercentInfo}>
                            <span className={styles.riskLabel}>Skor Risiko Manipulasi</span>
                            <span className={styles.riskValue} style={{ color: getRiskColor(activeAnalysis.riskScore) }}>
                              {activeAnalysis.riskScore != null ? `${activeAnalysis.riskScore}%` : 'N/A'}
                            </span>
                          </div>
                          <div className={styles.riskBarContainer}>
                            <div className={styles.riskLabel}>Tingkat Keparahan: {getRiskText(activeAnalysis.riskScore, activeAnalysis.status)}</div>
                            <div className={styles.riskBarBg}>
                              <div
                                className={styles.riskBarFill}
                                style={{
                                  width: `${activeAnalysis.riskScore ?? 0}%`,
                                  backgroundColor: getRiskColor(activeAnalysis.riskScore)
                                }}
                              />
                            </div>
                          </div>
                        </div>

                        {/* Grid EXIF & Anomalies */}
                        <div className={styles.detailsGrid}>
                          {/* EXIF Block */}
                          <div className={styles.detailBox}>
                            <div className={styles.detailBoxTitle}>
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
                              </svg>
                              <span>Metrik EXIF Gambar</span>
                            </div>
                            <table className={styles.exifTable}>
                              <tbody>
                                <tr className={styles.exifRow}>
                                  <td className={styles.exifKey}>Pembuat Perangkat</td>
                                  <td className={styles.exifValue}>{activeAnalysis.exif.make || '-'}</td>
                                </tr>
                                <tr className={styles.exifRow}>
                                  <td className={styles.exifKey}>Model Kamera</td>
                                  <td className={styles.exifValue}>{activeAnalysis.exif.camera || activeAnalysis.exif.model || '-'}</td>
                                </tr>
                                <tr className={styles.exifRow}>
                                  <td className={styles.exifKey}>Model Lensa</td>
                                  <td className={styles.exifValue}>{activeAnalysis.exif.lens || '-'}</td>
                                </tr>
                                <tr className={styles.exifRow}>
                                  <td className={styles.exifKey}>Aperture</td>
                                  <td className={styles.exifValue}>{activeAnalysis.exif.aperture || '-'}</td>
                                </tr>
                                <tr className={styles.exifRow}>
                                  <td className={styles.exifKey}>Exposure Time</td>
                                  <td className={styles.exifValue}>{activeAnalysis.exif.exposureTime || '-'}</td>
                                </tr>
                                <tr className={styles.exifRow}>
                                  <td className={styles.exifKey}>ISO</td>
                                  <td className={styles.exifValue}>{activeAnalysis.exif.iso || '-'}</td>
                                </tr>
                                <tr className={styles.exifRow}>
                                  <td className={styles.exifKey}>Ruang Warna</td>
                                  <td className={styles.exifValue}>{activeAnalysis.exif.colorSpace || '-'}</td>
                                </tr>
                                <tr className={styles.exifRow}>
                                  <td className={styles.exifKey}>Lokasi GPS</td>
                                  <td className={styles.exifValue}>{activeAnalysis.exif.gps || '-'}</td>
                                </tr>
                                <tr className={styles.exifRow}>
                                  <td className={styles.exifKey}>Software</td>
                                  <td className={styles.exifValue}>{activeAnalysis.exif.software || '-'}</td>
                                </tr>
                                <tr className={styles.exifRow}>
                                  <td className={styles.exifKey}>Tanggal Asli</td>
                                  <td className={styles.exifValue}>{activeAnalysis.exif.dateOriginal || '-'}</td>
                                </tr>
                                <tr className={styles.exifRow}>
                                  <td className={styles.exifKey}>Dimensi</td>
                                  <td className={styles.exifValue}>{activeAnalysis.exif.resolution || '-'}</td>
                                </tr>
                                <tr className={styles.exifRow}>
                                  <td className={styles.exifKey}>Kompresi</td>
                                  <td className={styles.exifValue}>{activeAnalysis.exif.compression || '-'}</td>
                                </tr>
                              </tbody>
                            </table>
                          </div>

                          {/* Anomalies Block */}
                          <div className={styles.detailBox}>
                            <div className={styles.detailBoxTitle}>
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M12 2L1 21h22L12 2zm1 14h-2v-2h2v2zm0-4h-2V8h2v4z"/>
                              </svg>
                              <span>Daftar Anomali Forensik</span>
                            </div>
                            {(!activeAnalysis.anomalies || activeAnalysis.anomalies.length === 0) ? (
                              <div className={styles.noAnomaliesFallback}>
                                <em>Tidak ada anomali atau manipulasi yang terdeteksi oleh sistem Reality Defender.</em>
                              </div>
                            ) : (
                              <ul className={styles.anomaliesList}>
                                {activeAnalysis.anomalies.map((ano, idx) => (
                                  <li key={idx} className={styles.anomalyItem}>
                                    {ano}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        </div>


                      </div>
                    )}
                  </div>

                  {/* Tab 2: Asisten AI (Chatbot) */}
                  <div
                    style={{
                      display: activeTab === 'ai' ? 'flex' : 'none',
                      flexDirection: 'column',
                      height: '100%',
                      overflow: 'hidden'
                    }}
                    className={styles.chatbotTabContent}
                  >
                    <div className={styles.bottomSection} style={{ flex: 1, height: '100%' }}>
                      <div className={styles.chatHeader}>
                        <div className={styles.chatTitle}>
                          <span className={`${styles.statusIndicator} ${styles.statusOnline}`} />
                          <span>Asisten AI Forensik Digital</span>
                        </div>
                        <div className={styles.chatActions}>
                          <button
                            onClick={handleResetSession}
                            className={styles.btnActionIcon}
                            title="Reset Sesi Chat"
                          >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        </div>
                      </div>

                      <div className={styles.chatBody} style={{ flex: 1, overflowY: 'auto' }}>
                        {historyLoading && lines.length === 0 ? (
                          <div style={{ display: 'flex', justifyContent: 'center', padding: '20px' }}>
                            <span className={styles.loadingSpinner}></span>
                          </div>
                        ) : (
                          lines.map((line, idx) => {
                            if (line.kind === 'user') {
                              return (
                                <div key={line.id || idx} className={`${styles.chatBubble} ${styles.bubbleUser}`}>
                                  <div style={{ fontWeight: 'bold', fontSize: '11px', marginBottom: '4px' }}>USER</div>
                                  <div>{line.text}</div>
                                </div>
                              );
                            }
                            if (line.kind === 'markdown') {
                              return (
                                <div key={line.id || idx} className={`${styles.chatBubble} ${styles.bubbleAgent}`}>
                                  <div style={{ fontWeight: 'bold', fontSize: '11px', marginBottom: '4px', color: '#ffb000' }}>AGENT</div>
                                  <span className={styles.chatBubbleMarkdown}>
                                    <Markdown remarkPlugins={[remarkGfm]}>{line.text}</Markdown>
                                  </span>
                                </div>
                              );
                            }
                            if (line.kind === 'text') {
                              return (
                                <div key={line.id || idx} className={`${styles.chatBubble} ${styles.bubbleAgent}`}>
                                  <div style={{ fontWeight: 'bold', fontSize: '11px', marginBottom: '4px', color: '#ffb000' }}>AGENT</div>
                                  <div>
                                    {line.text}
                                    {loading && idx === lines.length - 1 && <span className={styles.scanningText} style={{ display: 'inline', fontSize: '12px', marginLeft: '6px' }}>...</span>}
                                  </div>
                                </div>
                              );
                            }
                            if (line.kind === 'sysHint') {
                              return (
                                <div key={line.id || idx} className={`${styles.chatBubble} ${styles.bubbleSystem}`}>
                                  {line.text}
                                </div>
                              );
                            }
                            if (line.kind === 'tool') {
                              return (
                                <div key={line.id || idx} className={`${styles.chatBubble} ${styles.bubbleTool}`}>
                                  [Sistem mengeksekusi alat bantu: {line.tool}]
                                </div>
                              );
                            }
                            if (line.kind === 'image') {
                              return (
                                <div key={line.id || idx} className={`${styles.chatBubble} ${styles.bubbleAgent}`}>
                                  <div style={{ fontWeight: 'bold', fontSize: '11px', color: '#c39bff', marginBottom: '6px' }}>
                                    Tangkapan Gambar AI ({line.toolName || 'Tool'})
                                  </div>
                                  <img
                                    src={line.image.url}
                                    alt="Tool Output"
                                    style={{ maxWidth: '100%', maxHeight: '180px', borderRadius: '4px', border: '1px solid #30374a' }}
                                  />
                                </div>
                              );
                            }
                            if (line.kind === 'error') {
                              return (
                                <div key={line.id || idx} className={`${styles.chatBubble} ${styles.bubbleError}`}>
                                  Galat: {line.message}
                                </div>
                              );
                            }
                            return null;
                          })
                        )}
                        <div ref={chatEndRef} />
                      </div>

                      <form onSubmit={handleSendMessage} className={styles.chatInputArea}>
                        <input
                          type="text"
                          value={inputText}
                          onChange={(e) => setInputText(e.target.value)}
                          placeholder={activeAnalysis ? `Tanyakan AI seputar hasil analisis "${activeAnalysis.fileName}"...` : "Masukkan pesan untuk bertanya kepada AI..."}
                          className={styles.chatInput}
                          disabled={loading}
                        />
                        <button
                          type="submit"
                          disabled={loading || !inputText.trim()}
                          className={styles.btnSend}
                        >
                          <span>Kirim</span>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                          </svg>
                        </button>
                      </form>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function App() {
  return (
    <I18nProvider>
      <AppInner />
    </I18nProvider>
  );
}
