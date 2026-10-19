import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (!process.env.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY belum diisi. Salin .env.example menjadi .env lalu isi kuncinya.');
  process.exit(1);
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'))); // menyajikan tampilan web

const gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY.trim() });
const PORT = process.env.PORT || 3000;

// Model utama dari .env, lalu cadangan bila model tidak ditemukan (404)
const MODEL_UTAMA = (process.env.MODEL_NAME || 'gemini-3.5-flash-lite').trim();
const DAFTAR_MODEL = [...new Set([MODEL_UTAMA, 'gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-2.5-flash'])];
let modelAktif = null; // model yang terakhir berhasil dipakai

// Peran dan batasan asisten. Tambahkan info resmi sekolah di sini bila sudah ada.
const SISTEM = `Kamu adalah "Asisten AI SMK Taman Siswa Cabang Kota Sukabumi", asisten belajar yang ramah untuk siswa, guru, dan orang tua.
Aturan:
- Jawab dalam Bahasa Indonesia yang jelas dan sopan, kecuali pengguna memakai bahasa lain.
- Bantu pelajaran (termasuk pemrograman, PPLG, dan mata pelajaran umum), tugas, ide proyek, dan tanya jawab umum.
- Sekolah ini bagian dari Perguruan Tamansiswa, Cabang Sukabumi, dengan semboyan "Ing ngarsa sung tuladha, ing madya mangun karsa, tut wuri handayani".
- Jangan mengarang informasi spesifik sekolah (alamat, biaya, jadwal, jurusan, nomor telepon, nama guru). Jika tidak tahu, katakan belum punya datanya dan sarankan menghubungi tata usaha sekolah.
- Jangan membantu hal berbahaya atau melanggar hukum. Jaga jawaban tetap ringkas kecuali diminta detail.`;

const teksError = (e) => String(e?.message || e);
const kodeError = (e) => Number(e?.status || e?.code || 0);

const modelTidakAda = (e) => kodeError(e) === 404 || /NOT_FOUND|is not found|not supported for generateContent/i.test(teksError(e));
const sedangPadat = (e) => kodeError(e) === 503 || /overloaded|UNAVAILABLE/i.test(teksError(e));

// Memanggil Gemini: coba model berurutan, tiap model dibatasi waktu agar tidak menunggu lama
async function panggilGemini(params) {
  const urutan = modelAktif ? [modelAktif, ...DAFTAR_MODEL.filter((m) => m !== modelAktif)] : DAFTAR_MODEL;
  let galatTerakhir;

  for (const model of urutan) {
    try {
      const config = {
        ...(params.config || {}),
        httpOptions: { timeout: 15000 }, // maksimal 15 detik per model
        // Model 2.5 "berpikir" dulu secara bawaan; dimatikan agar jawaban lebih cepat
        ...(model.includes('2.5') ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
      };
      const hasil = await gemini.models.generateContent({ ...params, model, config });
      if (modelAktif !== model) {
        modelAktif = model;
        console.log(`Model yang dipakai: ${model}`);
      }
      return hasil;
    } catch (e) {
      galatTerakhir = e;
      console.error(`[${model}] gagal ->`, teksError(e).slice(0, 300));
      const lanjut = modelTidakAda(e) || sedangPadat(e) || /timeout|timed out|abort|deadline/i.test(teksError(e));
      if (!lanjut) throw e; // error lain (mis. API key salah): hentikan
    }
  }
  throw galatTerakhir;
}

const pesanError = (error) => {
  const teks = teksError(error);
  if (modelTidakAda(error)) return [404, `Model AI tidak ditemukan. Ganti MODEL_NAME di .env (buka /cek-model untuk melihat daftar model yang tersedia).`];
  if (sedangPadat(error)) return [503, 'Server AI sedang padat. Tunggu 1 menit lalu coba lagi.'];
  if (kodeError(error) === 429 || /quota|RESOURCE_EXHAUSTED/i.test(teks)) return [429, 'Batas penggunaan AI tercapai. Coba lagi beberapa saat.'];
  if (/API key|API_KEY_INVALID|PERMISSION_DENIED/i.test(teks) || [400, 401, 403].includes(kodeError(error)) && /key/i.test(teks)) {
    return [500, 'Kunci API Gemini tidak valid. Periksa GEMINI_API_KEY di file .env.'];
  }
  return [500, 'Gagal memproses permintaan ke Gemini: ' + teks.slice(0, 200)];
};

const gagal = (res, error, rute) => {
  console.error(rute, '->', teksError(error).slice(0, 500));
  const [kode, pesan] = pesanError(error);
  res.status(kode).json({ error: pesan });
};

// Daftar model yang tersedia untuk API key ini (buka di browser: /cek-model)
app.get('/cek-model', async (req, res) => {
  try {
    const nama = [];
    for await (const m of await gemini.models.list()) {
      if (/gemini/i.test(m.name)) nama.push(m.name.replace('models/', ''));
    }
    res.json({ model_dipakai: modelAktif || MODEL_UTAMA, model_tersedia: nama });
  } catch (error) {
    gagal(res, error, '/cek-model');
  }
});

// 1. Chat teks (dengan riwayat percakapan)
app.post('/tanya-ai', async (req, res) => {
  const { pertanyaan, riwayat = [] } = req.body;
  if (!pertanyaan) return res.status(400).json({ error: 'Pertanyaan wajib diisi!' });

  const contents = [
    ...(Array.isArray(riwayat) ? riwayat : []).slice(-12).map((r) => ({
      role: r.role === 'model' ? 'model' : 'user',
      parts: [{ text: String(r.text || '') }],
    })),
    { role: 'user', parts: [{ text: String(pertanyaan) }] },
  ];

  try {
    const hasil = await panggilGemini({ contents, config: { systemInstruction: SISTEM } });
    res.status(200).json({ jawaban: hasil.text });
  } catch (error) {
    gagal(res, error, '/tanya-ai');
  }
});

// Pola yang sama untuk semua endpoint berkas (gambar, dokumen, audio, video)
const endpointBerkas = (rute, field, kunciHasil, instruksiDefault, pesanWajib) => {
  app.post(rute, upload.single(field), async (req, res) => {
    const instruksi = req.body.instruksi || instruksiDefault;
    if (!req.file) return res.status(400).json({ error: pesanWajib });

    try {
      const hasil = await panggilGemini({
        contents: [
          instruksi,
          { inlineData: { data: req.file.buffer.toString('base64'), mimeType: req.file.mimetype } },
        ],
      });
      res.status(200).json({ [kunciHasil]: hasil.text });
    } catch (error) {
      gagal(res, error, rute);
    }
  });
};

endpointBerkas('/analisis-gambar', 'gambar', 'analisis', 'Jelaskan gambar ini', 'Berkas gambar wajib diunggah!');
endpointBerkas('/analisis-dokumen', 'dokumen', 'analisis_dokumen', 'Ringkas dokumen ini', 'Berkas dokumen wajib diunggah!');
endpointBerkas('/transkrip-audio', 'audio', 'transkrip', 'Transkripsikan audio ini ke teks', 'Berkas audio wajib diunggah!');
endpointBerkas('/analisis-video', 'video', 'analisis', 'Jelaskan isi video ini', 'Berkas video wajib diunggah!');

// 5. Konsep gambar (mode teks kreatif)
app.post('/buat-gambar', async (req, res) => {
  const { deskripsi } = req.body;
  if (!deskripsi) return res.status(400).json({ error: 'Field deskripsi wajib diisi!' });

  try {
    const hasil = await panggilGemini({
      contents: `Buatkan panduan resep gambar AI yang sangat mendetail, instruksi pencahayaan, aspek rasio, dan rekomendasi kata kunci estetik berdasarkan konsep berikut: ${deskripsi}`,
    });
    res.status(200).json({
      status: 'Sukses',
      pesan: 'Konsep gambar berhasil diolah dalam Mode Edukasi Gratis',
      detail_resep_ai: hasil.text,
    });
  } catch (error) {
    gagal(res, error, '/buat-gambar');
  }
});

// Di Vercel, aplikasi diekspor (Vercel yang menjalankannya). Di komputer sendiri, server dijalankan seperti biasa.
if (process.env.VERCEL === undefined) {
  app.listen(PORT, () => {
    console.log(`Server AI berjalan di http://localhost:${PORT}`);
    console.log(`Model utama: ${MODEL_UTAMA} (cadangan: ${DAFTAR_MODEL.slice(1).join(', ')})`);
  });
}

export default app;
